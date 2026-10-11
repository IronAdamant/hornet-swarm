import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  analysisSchema,
  authorisationSchema,
  chaosPermitted,
  chaosSequence,
  globalConfigSchema,
  productionGate,
  projectDomainsAuthorised,
  projectSchema,
  Redactor,
  rewriteForContainer,
  runResultSchema,
  type Analysis,
  signinBudget,
  validateJourneyYaml,
  type Journey,
  type Project,
  type RunResult,
  type StepResult,
} from '@hornet-swarm/core';
import {
  analysisMarkdown,
  buildAnalysis,
  compareScreenshots,
  htmlReport,
  junitXml,
  quarantineFile,
  redactTree,
  scanTree,
  summaryMarkdown,
  timingChanged,
  writeEvidenceZip,
  type RichJourney,
  type RichStep,
  type RichUser,
} from '@hornet-swarm/report';
import { writeAudit } from './audit.js';
import { injectSecrets, injectTotp, listFields, projectSecretValues, registerProjectSecrets } from './broker.js';
import { HornetError } from './errors.js';
import { ensureCredentialPage } from './credentials.js';
import { envStatus, startStoppedRunner, stopRunners } from './env.js';
import { aegisHome, ensureDir } from './home.js';
import { acquireLease, heartbeatStoredLease, releaseStoredLease } from './leases-store.js';
import { rotateControlToken, runnerFetch } from './runner-auth.js';


export { HornetError } from './errors.js';

export type JobReport = {
  ok: boolean;
  status: 'passed' | 'failed' | 'blocked' | 'error' | 'rate_limited';
  blocked_reason?: StepResult['blocked_reason'];
  steps: RichStep[];
  chaosApplied: string[];
};

export type SuiteRequest = {
  project: string;
  journeyFiles?: string[];
  home?: string;
  gate?: 'all' | 'per_user';
  confirmProduction?: boolean;
  chaos?: { profile: string; seed: string };
  agentId?: string;
  via?: 'cli' | 'mcp';
  phase1Only?: boolean;
  users?: string[];
  /** Test hook. Production runs keep the 30 minute lease. */
  leaseTtlMs?: number;
};

export type ParentPacket = {
  validation_required: true;
  run_id: string;
  project: string;
  status: string;
  summary: string;
  analysis: unknown;
  evidence_zip: string;
  html_path: string;
  screenshot_paths: string[];
  trace_paths: string[];
  packet_path: string;
  instruction: string;
  killed: boolean;
};

const PARENT_INSTRUCTION =
  "The parent Grok Build session or Grok Bot reads this packet, checks it against the task, and only then tells the owner the outcome. The harness does not grade a site's AI replies.";

export function selectRunLabels(input: {
  phase1Only: boolean;
  users?: string[];
  projectUsers: string[];
  journeyUsers: string[];
}): string[] {
  if (input.phase1Only) return input.users ?? input.projectUsers;
  const journeyUsers = [...new Set(input.journeyUsers)];
  if (!input.users) return journeyUsers;
  const wanted = new Set(input.users);
  return journeyUsers.filter((label) => wanted.has(label));
}

export async function runSuite(request: SuiteRequest): Promise<RunResult & { parent: ParentPacket }> {
  const home = request.home ?? aegisHome();
  const project = projectSchema.parse(parse(readFileSync(join(home, 'projects', request.project, 'project.yaml'), 'utf8')));
  const auth = authorisationSchema.parse(parse(readFileSync(join(home, 'authorisations', `${project.authorisation_id}.yaml`), 'utf8')));
  const gate = request.gate ?? project.phase2.gate;
  const agentId = request.agentId ?? `cli-${process.pid}`;
  if (existsSync(join(home, 'KILL'))) throw new HornetError('The kill switch is on.', 2);
  const domains = projectDomainsAuthorised(project, auth);
  if (!domains.ok) throw new HornetError(domains.reason, 3);
  const production = productionDecision(project, auth, Boolean(request.confirmProduction));
  if (!production.ok) throw new HornetError(production.reason, 3);
  if (request.chaos) {
    const allowed = chaosPermitted(auth, project);
    if (!allowed.ok) throw new HornetError(allowed.reason, 3);
  }
  const journeys = request.phase1Only ? [] : loadJourneys(home, project, request.journeyFiles ?? []);
  const knownSecrets = projectSecretValues(project.id, home);
  for (const journey of journeys) {
    const checked = validateJourneyYaml(journey.text, project, knownSecrets);
    if (!checked.valid || !checked.journey) throw new HornetError(checked.errors.join('; '), 3);
    journey.journey = checked.journey;
  }
  const labels = selectRunLabels({
    phase1Only: Boolean(request.phase1Only),
    ...(request.users ? { users: request.users } : {}),
    projectUsers: project.users.map((user) => user.label),
    journeyUsers: journeys.flatMap((entry) => entry.journey?.users ?? []),
  });
  const runId = makeRunId();
  const started = isoOffset();
  const deadline = Date.now() + project.limits.max_run_duration_min * 60_000;
  const ttlMs = request.leaseTtlMs ?? 30 * 60 * 1000;
  const via = request.via ?? 'cli';
  const runDir = ensureDir(join(home, 'runs', runId));
  const rich: RichUser[] = [];
  let killed = false;
  let durationStop = false;
  const phaseResults: { label: string; report: JobReport }[] = [];
  const totpCodes: string[] = [];
  const hold = (label: string, work: () => Promise<void>): Promise<void> => {
    const lease = acquireLease({
      project: project.id,
      label,
      agentId,
      runId,
      candidates: project.users.map((user) => user.label),
      home,
      via,
      ...(request.leaseTtlMs ? { ttlMs: request.leaseTtlMs } : {}),
    });
    if (!lease.ok) throw new HornetError(lease.reason === 'busy' ? `busy until ${lease.busyUntil ?? 'later'}` : 'agent already holds a login', 3);
    const intervalMs = Math.max(20, Math.min(60_000, Math.floor(ttlMs / 3)));
    const renew = setInterval(() => {
      heartbeatStoredLease(project.id, agentId, home, ttlMs, via);
    }, intervalMs);
    return work().finally(() => {
      clearInterval(renew);
      heartbeatStoredLease(project.id, agentId, home, ttlMs, via);
      releaseStoredLease(project.id, agentId, home, via);
    });
  };
  try {
    for (const label of labels) {
      if (Date.now() >= deadline) {
        durationStop = true;
        phaseResults.push({ label, report: durationReport() });
        break;
      }
      await hold(label, async () => {
        const phase1 = await runPhase1(project, label, runId, home, agentId, deadline, totpCodes);
        phaseResults.push({ label, report: phase1.report });
        if (phase1.killed) killed = true;
        if (phase1.report.blocked_reason === 'duration') durationStop = true;
      });
      if (killed || durationStop) break;
    }
    const everyPhasePassed = phaseResults.length === labels.length && phaseResults.every((item) => item.report.status === 'passed');
    for (const item of phaseResults) {
      const entries = journeys.filter((entry) => entry.journey?.users.includes(item.label));
      const phaseOk = item.report.status === 'passed';
      const blockedByGate = gate === 'all' && !everyPhasePassed;
      const userJourneys: RichJourney[] = [];
      if (!killed && !durationStop && phaseOk && !blockedByGate && entries.length > 0) {
        await hold(item.label, async () => {
          for (const entry of entries) {
            if (killed || durationStop) break;
            const played = await runJourney(project, item.label, entry.journey as Journey, runId, home, deadline, totpCodes, request.chaos);
            if (played.killed) killed = true;
            if (played.duration) durationStop = true;
            userJourneys.push(played.journey);
            rememberRegression(home, project.id, entry, played.journey);
          }
        });
      }
      for (const entry of entries) {
        if (userJourneys.some((journey) => journey.id === entry.journey?.id)) continue;
        if (durationStop) {
          userJourneys.push({
            id: entry.journey?.id ?? 'journey',
            name: entry.journey?.name ?? 'Check',
            status: 'blocked',
            duration_ms: 0,
            steps: [],
            blocked_reason: 'duration',
          });
          continue;
        }
        userJourneys.push({ id: entry.journey?.id ?? 'journey', name: entry.journey?.name ?? 'Check', status: 'skipped', duration_ms: 0, steps: [] });
      }
      rich.push({ label: item.label, phase1: phaseRecord(item.report), journeys: userJourneys });
    }
  } catch (error) {
    releaseStoredLease(project.id, agentId, home, via);
    const message = error instanceof Error ? error.message : 'The run failed.';
    const wrote = writeErrorOutcome({
      home,
      projectId: project.id,
      environment: project.environment,
      authorisationId: project.authorisation_id,
      runDir,
      runId,
      started,
      gate,
      message,
      codes: totpCodes,
    });
    if (!wrote.run && !wrote.packet) rmSync(runDir, { recursive: true, force: true });
    const code = error instanceof HornetError ? error.exitCode : 4;
    throw new HornetError(wrote.message, code);
  }
  const gatePassed = rich.every((user) => user.phase1.status === 'pass');
  const status = foldRunStatus({ killed, gatePassed, users: rich, durationStop });
  const result = runResultSchema.parse({
    schema_version: '1',
    run_id: runId,
    project: project.id,
    started_at: started,
    finished_at: isoOffset(),
    status,
    gate,
    gate_passed: gatePassed && !killed,
    totals: totals(rich),
    users: rich.map((user) => ({
      label: user.label,
      phase1: stripPhase(user.phase1),
      journeys: user.journeys.map((journey) => ({
        id: journey.id,
        status: journey.status,
        duration_ms: journey.duration_ms,
        steps: journey.steps.map(stripStep),
      })),
    })),
    environment: project.environment,
    authorisation_id: project.authorisation_id,
    redaction: 'pass',
  });
  applyBaselines(home, project.id, rich);
  const loggedChaos = rich.flatMap((user) => user.journeys.flatMap((journey) => journey.chaosApplied ?? []));
  const suspected = durationStop
    ? 'The run reached its time limit.'
    : status === 'passed'
      ? 'Nothing failed.'
      : killed
        ? 'The run was stopped.'
        : 'A check did not match what we expected.';
  const analysis = buildAnalysis({
    result,
    users: rich,
    chaos: request.chaos ? { profile: request.chaos.profile, seed: request.chaos.seed, actions: loggedChaos } : null,
    suspected,
    confidence: status === 'passed' ? 0.9 : 0.6,
    repro: status === 'passed' ? ['Sign in with the test account.', 'Repeat the same checks.'] : ['Sign in with the test account.', 'Repeat the check that failed.'],
    regressions: listRegressions(home, project.id),
    next: status === 'passed' ? ['No change is needed.'] : ['Fix the first failed check and run it again.'],
  });
  const summary = summaryMarkdown(rich, status);
  const artifacts = collectArtifacts(runDir);
  writeRunReports(runDir, result, analysis, summary, undefined, artifacts);
  writeFileSync(join(runDir, 'junit.xml'), junitXml(result));
  const redactor = new Redactor();
  registerProjectSecrets(project.id, redactor, home);
  for (const code of totpCodes) redactor.register('totp_code', code);
  await redactTree(runDir, redactor);
  const hits = await scanTree(runDir, redactor);
  if (hits.length > 0) {
    for (const hit of hits) quarantineHit(hit);
    const failedSummary = summaryMarkdown(rich, 'redaction_failure');
    const failedAnalysis = failAnalysis(analysis);
    result.status = 'redaction_failure';
    result.redaction = 'fail';
    writeRunReports(runDir, result, failedAnalysis, failedSummary, redactor, collectArtifacts(runDir));
    writeAudit({ interface: via, agent: agentId, action: 'redaction_failure', project: project.id, run_id: runId, result: 'quarantined' }, redactor, home);
  }
  writeAudit({ interface: via, agent: agentId, action: 'run_suite', project: project.id, run_id: runId, labels, result: result.status }, redactor, home);
  const parent = await publishParent({
    home,
    projectId: project.id,
    runDir,
    runId,
    result,
    summary,
    durationStop: durationStop && result.status !== 'redaction_failure',
    killed,
    redactor,
    artifacts: collectArtifacts(runDir),
    redactionFailed: hits.length > 0,
  });
  return { ...result, parent };
}

async function runPhase1(
  project: Project,
  label: string,
  runId: string,
  home: string,
  _agent: string,
  deadline: number,
  codes: string[],
): Promise<{ report: JobReport; killed: boolean }> {
  const budget = signinState(home, project, label);
  if (!budget.allowed) {
    return {
      killed: false,
      report: { ok: false, status: 'blocked', blocked_reason: 'signin_limit', steps: [], chaosApplied: [] },
    };
  }
  if (project.auth.totp.enabled && !listFields(project.id, label, home).includes('totp_secret')) {
    return { killed: false, report: { ok: false, status: 'blocked', blocked_reason: 'totp_missing', steps: [], chaosApplied: [] } };
  }
  recordSignin(home, project.id, label);
  const steps: Journey['steps'] = [
    { navigate: { url: project.auth.signin_url } },
    { fill: { selector: project.auth.selectors.username, credential: `${label}.username` } },
    { fill: { selector: project.auth.selectors.password, credential: `${label}.password` } },
  ];
  if (project.auth.totp.enabled) steps.push({ fill: { selector: project.auth.selectors.totp, totp: label } });
  steps.push({ click: { selector: project.auth.selectors.submit } }, { wait: { for: 'navigation' } }, ...project.auth.success.map((assertion) => ({ assert: assertion })));
  const journey: Journey = {
    version: 1,
    id: 'phase1',
    name: 'Sign-in check',
    description: '',
    users: [label],
    requires_phase1: false,
    tags: [],
    vars: {},
    retries: 0,
    steps,
  };
  return execute(project, label, journey, runId, home, deadline, undefined, codes);
}

async function runJourney(
  project: Project,
  label: string,
  journey: Journey,
  runId: string,
  home: string,
  deadline: number,
  codes: string[],
  chaos?: { profile: string; seed: string },
): Promise<{ journey: RichJourney; killed: boolean; duration: boolean }> {
  let played = await execute(project, label, journey, runId, home, deadline, chaos, codes);
  let tries = 0;
  while (!played.killed && played.report.blocked_reason !== 'duration' && played.report.status === 'failed' && tries < journey.retries) {
    tries += 1;
    played = await execute(project, label, journey, runId, home, deadline, chaos, codes);
  }
  return {
    killed: played.killed,
    duration: played.report.blocked_reason === 'duration',
    journey: journeyFromJob(played.report, { id: journey.id, name: journey.name, tries }),
  };
}

async function execute(
  project: Project,
  label: string,
  journey: Journey,
  runId: string,
  home: string,
  deadline: number,
  chaos?: { profile: string; seed: string },
  codes: string[] = [],
): Promise<{ report: JobReport; killed: boolean }> {
  const endpoint = await endpointFor(project.id, label);
  rotateControlToken(project.id, label, home);
  const injected = await injectSecrets(project.id, label, endpoint, home);
  if (project.auth.totp.enabled) {
    const totp = await injectTotp(project.id, label, endpoint, home);
    if (totp.code) codes.push(totp.code);
  }
  const target = containerTarget(project);
  const actions = chaos ? chaosSequence(chaos.seed, chaos.profile, journey.steps.length) : [];
  const pollUrl = await operatorPollUrl(project.id, label, home);
  const body = {
    runId,
    label,
    journeyId: journey.id,
    baseUrl: target.base,
    steps: journey.steps,
    allowOrigins: target.origins,
    authEndpoints: project.auth.auth_endpoints,
    minStepDelayMs: project.limits.min_step_delay_ms,
    rps: project.limits.max_requests_per_second_per_runner,
    accessDeniedMarkers: project.auth.access_denied_markers,
    chaosActions: actions,
    outDir: `/out/${runId}/${journey.id}`,
    vars: journey.vars,
    users: Object.fromEntries(project.users.map((user) => [user.label, { vars: user.vars }])),
    deadline,
    ...(pollUrl ? { operatorPollUrl: pollUrl } : {}),
  };
  const controller = new AbortController();
  let abortReason: 'kill' | 'duration' | undefined;
  let arming: Promise<void> | undefined;
  const arm = (reason: 'kill' | 'duration'): Promise<void> => {
    if (arming) return arming;
    abortReason = reason;
    arming = (async () => {
      await postAbort(project.id, endpoint, home);
      controller.abort();
    })();
    return arming;
  };
  if (existsSync(join(home, 'KILL'))) await arm('kill');
  else if (Date.now() >= deadline) await arm('duration');
  const timer = setInterval(() => {
    if (abortReason) return;
    if (existsSync(join(home, 'KILL'))) void arm('kill');
    else if (Date.now() >= deadline) void arm('duration');
  }, 400);
  try {
    const response = await runnerFetch(project.id, endpoint, '/v1/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal,
    }, home);
    const report = (await response.json()) as JobReport;
    copyArtifacts(home, project.id, label, runId, journey.id);
    rewriteArtifacts(home, project.id, label, runId, journey.id, report);
    void injected;
    if (arming) await arming;
    return applyReturnedJob({
      ...(abortReason ? { abortReason } : {}),
      killPresent: existsSync(join(home, 'KILL')),
      report,
      projectId: project.id,
      label,
      stopRunners,
    });
  } catch (error) {
    if (arming) await arming;
    const killPresent = existsSync(join(home, 'KILL'));
    if (abortReason || killPresent) {
      return applyReturnedJob({
        ...(abortReason ? { abortReason } : {}),
        killPresent,
        report: { ok: false, status: 'blocked', steps: [], chaosApplied: [] },
        projectId: project.id,
        label,
        stopRunners,
      });
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
}

export async function applyReturnedJob(input: {
  abortReason?: 'kill' | 'duration';
  killPresent: boolean;
  report: JobReport;
  projectId: string;
  label: string;
  stopRunners: (project: string, label?: string) => Promise<void>;
}): Promise<{ report: JobReport; killed: boolean }> {
  if (input.abortReason === 'kill' || input.killPresent) {
    await Promise.race([input.stopRunners(input.projectId), delay(2_000)]);
    return { report: { ok: false, status: 'blocked', blocked_reason: 'kill', steps: [], chaosApplied: [] }, killed: true };
  }
  if (input.report.blocked_reason === '2fa') return { report: input.report, killed: false };
  if (input.abortReason === 'duration') {
    await Promise.race([input.stopRunners(input.projectId, input.label), delay(2_000)]);
    return { report: durationReport(), killed: false };
  }
  return { report: input.report, killed: false };
}

async function operatorPollUrl(project: string, label: string, home: string): Promise<string | undefined> {
  try {
    const port = await ensureCredentialPage(home);
    const response = await fetch(`http://127.0.0.1:${port}/v1/operator-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, label, reason: 'A texted or emailed code is needed.' }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const opened = (await response.json()) as { id?: string; token?: string };
    if (!opened.id || !opened.token) return undefined;
    const id = encodeURIComponent(opened.id);
    const token = encodeURIComponent(opened.token);
    return `http://host.docker.internal:${port}/v1/operator-code/${id}?token=${token}`;
  } catch {
    return undefined;
  }
}

async function endpointFor(projectId: string, label: string): Promise<string> {
  const current = await envStatus(projectId);
  const runner = current.runners.find((entry) => entry.label === label);
  if (runner?.health === 'healthy' && runner.endpoint) return runner.endpoint;
  const started = await startStoppedRunner(projectId, label);
  if (!started) throw new HornetError(`No healthy runner for ${label}.`, 4);
  const again = await envStatus(projectId);
  const next = again.runners.find((entry) => entry.label === label);
  if (next?.health === 'healthy' && next.endpoint) return next.endpoint;
  throw new HornetError(`No healthy runner for ${label}.`, 4);
}

async function postAbort(projectId: string, endpoint: string, home: string): Promise<void> {
  try {
    await runnerFetch(projectId, endpoint, '/v1/abort', { method: 'POST', body: '{}', signal: AbortSignal.timeout(1_500) }, home);
  } catch {
    // A failed abort post still continues into the stop.
  }
}

export function writeErrorOutcome(input: {
  home: string;
  projectId: string;
  environment: string;
  authorisationId: string;
  runDir: string;
  runId: string;
  started: string;
  gate: 'all' | 'per_user';
  message: string;
  codes?: string[];
}): { run: boolean; packet: boolean; message: string } {
  const redactor = new Redactor();
  try {
    registerProjectSecrets(input.projectId, redactor, input.home);
  } catch {
    // A missing store still gets a packet with a fixed summary.
  }
  for (const code of input.codes ?? []) redactor.register('totp_code', code);
  let run = false;
  let packet = false;
  try {
    const result = runResultSchema.parse({
      schema_version: '1',
      run_id: input.runId,
      project: input.projectId,
      started_at: input.started,
      finished_at: isoOffset(),
      status: 'error',
      gate: input.gate,
      gate_passed: false,
      totals: { users: 0, journeys: 0, steps: 0, passed: 0, failed: 0, skipped: 0 },
      users: [],
      environment: input.environment,
      authorisation_id: input.authorisationId,
      redaction: 'pass',
    });
    writeFileSync(join(input.runDir, 'run.json'), redactor.redact(`${JSON.stringify(result, null, 2)}\n`));
    run = true;
  } catch {
    run = false;
  }
  try {
    const packetPath = join(input.home, 'projects', input.projectId, 'latest-parent-report.json');
    const body: ParentPacket = {
      validation_required: true,
      run_id: input.runId,
      project: input.projectId,
      status: 'error',
      summary: 'The run failed before it could finish.',
      analysis: { withheld: false },
      evidence_zip: '',
      html_path: '',
      screenshot_paths: [],
      trace_paths: [],
      packet_path: packetPath,
      instruction: PARENT_INSTRUCTION,
      killed: false,
    };
    let encoded = JSON.stringify(body, null, 2);
    if (redactor.contains(encoded) || redactor.contains(input.message)) encoded = redactor.redact(encoded);
    ensureDir(join(input.home, 'projects', input.projectId));
    writeFileSync(packetPath, `${encoded}\n`);
    packet = true;
  } catch {
    packet = false;
  }
  return { run, packet, message: redactor.redact(input.message) };
}

function durationReport(): JobReport {
  return { ok: false, status: 'blocked', blocked_reason: 'duration', steps: [], chaosApplied: [] };
}

function rewriteArtifacts(home: string, project: string, label: string, runId: string, journeyId: string, report: JobReport): void {
  const dir = join(home, 'runs', runId, label, journeyId);
  report.steps = report.steps.map((step) => {
    const shots = (step.screenshot_paths ?? [])
      .map((shot) => join(dir, shot.split('/').pop() ?? ''))
      .filter((shot) => existsSync(shot));
    const trace = join(dir, 'trace.zip');
    return {
      ...step,
      ...(shots[0] ? { screenshot_paths: shots, screenshot: shots[0] } : {}),
      ...(existsSync(trace) ? { trace_path: trace } : {}),
    };
  });
}

function applyBaselines(home: string, project: string, users: RichUser[]): void {
  for (const user of users) {
    for (const journey of user.journeys) {
      const timingFile = join(home, 'baselines', project, journey.id, 'timings.json');
      const saved = existsSync(timingFile) ? (JSON.parse(readFileSync(timingFile, 'utf8')) as Record<string, number>) : {};
      for (const step of journey.steps) {
        const shot = step.screenshot_paths?.[0];
        const baseShot = join(home, 'baselines', project, journey.id, `${step.index}.png`);
        let visual: 'same' | 'changed' | 'no_baseline' = 'same';
        let ratio: number | undefined;
        if (shot && existsSync(baseShot)) {
          const compared = compareScreenshots(readFileSync(baseShot), readFileSync(shot));
          visual = compared.visual;
          ratio = compared.ratio;
        } else if (shot) visual = 'no_baseline';
        const before = saved[String(step.index)];
        const timing = before === undefined ? 'no_baseline' : timingChanged(before, step.duration_ms) ? 'slower' : 'same';
        const notes: string[] = [];
        if (visual === 'changed') notes.push('The page looks different from the saved baseline.');
        if (timing === 'slower') notes.push('This step took longer than the saved baseline.');
        step.diff = {
          visual,
          ...(ratio !== undefined ? { visual_mismatch_ratio: ratio } : {}),
          timing,
          text: 'same',
          console: (step.console_error_count ?? 0) > (saved[`console-${step.index}`] ?? 0) ? 'new_errors' : before === undefined ? 'no_baseline' : 'same',
          network: (step.network_errors?.length ?? 0) > (saved[`network-${step.index}`] ?? 0) ? 'new_errors' : before === undefined ? 'no_baseline' : 'same',
          notes,
        };
      }
    }
  }
}

export function acceptBaseline(project: string, runId: string, home = aegisHome()): { ok: true } {
  const analysis = JSON.parse(readFileSync(join(home, 'runs', runId, 'analysis.json'), 'utf8')) as {
    users: RichUser[];
  };
  for (const user of analysis.users) {
    for (const journey of user.journeys) {
      const dir = ensureDir(join(home, 'baselines', project, journey.id));
      const timings: Record<string, number> = {};
      for (const step of journey.steps) {
        timings[String(step.index)] = step.duration_ms;
        timings[`console-${step.index}`] = step.console_error_count ?? 0;
        timings[`network-${step.index}`] = step.network_errors?.length ?? 0;
        const shot = step.screenshot_paths?.[0];
        if (shot && existsSync(shot)) copyFileSync(shot, join(dir, `${step.index}.png`));
      }
      writeFileSync(join(dir, 'timings.json'), `${JSON.stringify(timings)}\n`);
    }
  }
  return { ok: true };
}

export async function exportEvidence(project: string, runId: string, destination: string, home = aegisHome()): Promise<{ ok: true; path: string }> {
  const redactor = new Redactor();
  registerProjectSecrets(project, redactor, home);
  const runDir = join(home, 'runs', runId);
  await redactTree(runDir, redactor);
  await writeEvidenceZip(runDir, destination, redactor);
  return { ok: true, path: destination };
}

export function cleanupRetention(home = aegisHome(), days?: number): string[] {
  const keepDays = days ?? retentionDays(home);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const root = join(home, 'runs');
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    if (statSync(dir).mtimeMs < cutoff) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

function retentionDays(home: string): number {
  try {
    const parsed = globalConfigSchema.parse(parse(readFileSync(join(home, 'config.yaml'), 'utf8')));
    return parsed.results_retention_days;
  } catch {
    return 30;
  }
}

export function listProjectUsers(projectId: string, home = aegisHome()): { label: string; role: string; tenant: string }[] {
  const project = projectSchema.parse(parse(readFileSync(join(home, 'projects', projectId, 'project.yaml'), 'utf8')));
  return project.users.map((user) => ({ label: user.label, role: user.role, tenant: user.tenant }));
}

function quarantineHit(hit: string): void {
  const file = hit.split('!')[0] ?? hit;
  if (existsSync(file)) quarantineFile(file);
}

function fileContainsSecret(file: string, redactor: Redactor): boolean {
  if (!file || !existsSync(file)) return false;
  try {
    const bytes = readFileSync(file);
    return redactor.contains(bytes.toString('utf8')) || redactor.contains(bytes.toString('latin1'));
  } catch {
    return false;
  }
}

function copyArtifacts(home: string, project: string, label: string, runId: string, journeyId: string): void {
  const source = join(home, 'runners', project, label, runId, journeyId);
  if (!existsSync(source)) return;
  const destination = ensureDir(join(home, 'runs', runId, label, journeyId));
  cpSync(source, destination, { recursive: true });
}

function loadJourneys(home: string, project: Project, files: string[]): { text: string; file: string; journey?: Journey }[] {
  const selected = (files.length > 0 ? files : readdirSync(resolveJourneys(home, project)).filter((name) => name.endsWith('.yaml')).map((name) => join(resolveJourneys(home, project), name))).map((file) => resolveJourneyArg(home, project, file));
  const regressions = regressionFiles(home, project.id);
  return [...selected, ...regressions].map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

function resolveJourneyArg(home: string, project: Project, file: string): string {
  if (file.endsWith('.yaml') || file.endsWith('.yml') || file.includes('/')) return file;
  const dir = resolveJourneys(home, project);
  const direct = join(dir, `${file}.journey.yaml`);
  if (existsSync(direct)) return direct;
  if (!existsSync(dir)) throw new HornetError(`Unknown journey ${file}.`, 3);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.yaml')) continue;
    const path = join(dir, name);
    const parsed = parse(readFileSync(path, 'utf8')) as { id?: string };
    if (parsed.id === file) return path;
  }
  throw new HornetError(`Unknown journey ${file}.`, 3);
}

function resolveJourneys(home: string, project: Project): string {
  if (project.journeys_dir.startsWith('/')) return project.journeys_dir;
  return join(home, 'projects', project.id, project.journeys_dir);
}

function regressionFiles(home: string, project: string): string[] {
  const dir = join(home, 'regressions', project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.journey.yaml')).map((name) => join(dir, name));
}

function rememberRegression(home: string, project: string, entry: { file: string; journey?: Journey }, played: RichJourney): void {
  if (!entry.journey) return;
  const dir = ensureDir(join(home, 'regressions', project));
  const file = join(dir, `${entry.journey.id}.journey.yaml`);
  const ledgerPath = join(dir, `${entry.journey.id}.json`);
  if (played.status === 'fail' || played.status === 'error' || played.status === 'flaky') {
    writeFileSync(file, readFileSync(entry.file));
    writeFileSync(ledgerPath, `${JSON.stringify({ state: 'open', consecutive: 0 })}\n`);
    return;
  }
  // Only the stored regression copy advances the three-pass counter.
  if (played.status !== 'pass' || !existsSync(ledgerPath) || entry.file !== file) return;
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { state: string; consecutive: number };
  const consecutive = ledger.consecutive + 1;
  writeFileSync(ledgerPath, `${JSON.stringify({ state: consecutive >= 3 ? 'fixed' : 'open', consecutive })}\n`);
}

function listRegressions(home: string, project: string): string[] {
  const dir = join(home, 'regressions', project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.journey.yaml'));
}

function containerTarget(project: Project): { base: string; origins: string[] } {
  const locals = macAddresses();
  const base = rewriteForContainer(project.targets.base_url, locals);
  const origins = new Set<string>();
  origins.add(new URL(base).origin);
  for (const origin of project.targets.allowed_origins) {
    origins.add(origin);
    origins.add(new URL(rewriteForContainer(origin, locals)).origin);
  }
  for (const third of project.targets.allowed_third_party) origins.add(new URL(third.origin).origin);
  return { base, origins: [...origins] };
}

function macAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.push(entry.address);
  }
  return addresses;
}

function productionDecision(project: Project, auth: ReturnType<typeof authorisationSchema.parse>, confirm: boolean): { ok: true } | { ok: false; reason: string } {
  return productionGate(project, auth, confirm);
}

function signinState(home: string, project: Project, label: string): { allowed: boolean } {
  const stamps = readSignins(home, project.id).filter((entry) => entry.label === label).map((entry) => entry.at);
  return signinBudget(stamps, Date.now(), project.limits.max_signin_attempts_per_user_per_hour);
}

function recordSignin(home: string, project: string, label: string): void {
  const file = join(home, 'projects', project, 'signin.json');
  const current = readSignins(home, project);
  current.push({ label, at: Date.now() });
  writeFileSync(file, `${JSON.stringify(current)}\n`);
}

function readSignins(home: string, project: string): { label: string; at: number }[] {
  try {
    return JSON.parse(readFileSync(join(home, 'projects', project, 'signin.json'), 'utf8')) as { label: string; at: number }[];
  } catch {
    return [];
  }
}

function phaseRecord(report: JobReport): RichUser['phase1'] {
  return {
    status: report.blocked_reason === 'signin_limit' ? 'blocked' : mapStatus(report),
    duration_ms: report.steps.reduce((sum, step) => sum + step.duration_ms, 0),
    ...(report.blocked_reason ? { blocked_reason: report.blocked_reason } : {}),
    ...(report.steps.find((step) => step.error)?.error ? { error: report.steps.find((step) => step.error)?.error } : {}),
  };
}

export function journeyFromJob(report: JobReport, meta: { id: string; name: string; tries: number }): RichJourney {
  const status = meta.tries > 0 && report.status === 'passed' ? 'flaky' : mapStatus(report);
  const steps = report.steps.map((step) => (status === 'flaky' ? { ...step, status: 'flaky' as const } : step));
  const blockedReason = report.status === 'rate_limited' ? 'rate_limited' : report.blocked_reason;
  return {
    id: meta.id,
    name: meta.name,
    status,
    duration_ms: steps.reduce((sum, step) => sum + step.duration_ms, 0),
    steps,
    chaosApplied: report.chaosApplied,
    ...(blockedReason ? { blocked_reason: blockedReason } : {}),
  };
}

export function foldRunStatus(input: {
  killed: boolean;
  gatePassed: boolean;
  durationStop?: boolean;
  users: ReadonlyArray<{
    phase1: { status: string; blocked_reason?: string };
    journeys: ReadonlyArray<{ status: string; blocked_reason?: string; steps: ReadonlyArray<{ blocked_reason?: string }> }>;
  }>;
}): RunResult['status'] {
  const phaseProblem = input.users.some((user) => user.phase1.status === 'fail' || user.phase1.status === 'error');
  const journeyProblem = input.users.some((user) => user.journeys.some((journey) => journey.status === 'fail' || journey.status === 'error' || journey.status === 'flaky'));
  const rateLimited = input.users.some(
    (user) =>
      user.phase1.blocked_reason === 'rate_limited' ||
      user.journeys.some(
        (journey) => journey.blocked_reason === 'rate_limited' || journey.steps.some((step) => step.blocked_reason === 'rate_limited'),
      ),
  );
  const blocked =
    input.killed || input.users.some((user) => user.phase1.status === 'blocked' || user.journeys.some((journey) => journey.status === 'blocked'));
  if (phaseProblem || journeyProblem) return 'failed';
  if (rateLimited) return 'rate_limited';
  if (blocked || input.durationStop) return 'blocked';
  if (!input.gatePassed) return 'failed';
  return 'passed';
}

function mapStatus(report: JobReport): StepResult['status'] {
  if (report.status === 'passed') return 'pass';
  if (report.status === 'blocked' || report.status === 'rate_limited') return 'blocked';
  if (report.status === 'error') return 'error';
  return 'fail';
}

function stripPhase(phase: RichUser['phase1']): RunResult['users'][number]['phase1'] {
  return {
    status: phase.status,
    duration_ms: phase.duration_ms,
    ...(phase.blocked_reason ? { blocked_reason: phase.blocked_reason } : {}),
    ...(phase.error ? { error: phase.error } : {}),
  };
}

function stripStep(step: RichStep): StepResult {
  return {
    index: step.index,
    type: step.type,
    status: step.status,
    duration_ms: step.duration_ms,
    started_at: step.started_at,
    finished_at: step.finished_at,
    ...(step.selector ? { selector: step.selector } : {}),
    ...(step.assertion ? { assertion: step.assertion } : {}),
    ...(step.error ? { error: step.error } : {}),
    ...(step.screenshot ? { screenshot: step.screenshot } : {}),
    ...(step.blocked_reason ? { blocked_reason: step.blocked_reason } : {}),
    ...(step.console_error_count !== undefined ? { console_error_count: step.console_error_count } : {}),
    ...(step.network_errors ? { network_errors: step.network_errors } : {}),
    ...(step.http_status ? { http_status: step.http_status } : {}),
  };
}

function totals(users: RichUser[]): RunResult['totals'] {
  const steps = users.flatMap((user) => user.journeys.flatMap((journey) => journey.steps));
  return {
    users: users.length,
    journeys: users.reduce((sum, user) => sum + user.journeys.length, 0),
    steps: steps.length,
    passed: steps.filter((step) => step.status === 'pass').length,
    failed: steps.filter((step) => step.status === 'fail' || step.status === 'flaky').length,
    skipped: users.reduce((sum, user) => sum + user.journeys.filter((journey) => journey.status === 'skipped').length, 0),
  };
}

function writeRunReports(
  runDir: string,
  result: RunResult,
  analysis: Analysis,
  summary: string,
  redactor?: Redactor,
  artifacts?: { screenshots: string[]; traces: string[] },
): void {
  const emit = (text: string) => (redactor ? redactor.redact(text) : text);
  writeFileSync(join(runDir, 'run.json'), emit(`${JSON.stringify(result, null, 2)}\n`));
  writeFileSync(join(runDir, 'summary.md'), emit(summary));
  writeFileSync(join(runDir, 'analysis.json'), emit(`${JSON.stringify(analysis, null, 2)}\n`));
  writeFileSync(join(runDir, 'analysis.md'), emit(analysisMarkdown(analysis)));
  writeFileSync(join(runDir, 'report.html'), emit(htmlReport(result, summary, artifacts)));
}

function collectArtifacts(runDir: string): { screenshots: string[]; traces: string[] } {
  const screenshots: string[] = [];
  const traces: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (name.endsWith('.png')) screenshots.push(path);
      if (name === 'trace.zip') traces.push(path);
    }
  };
  walk(runDir);
  return { screenshots, traces };
}

export async function publishParent(input: {
  home: string;
  projectId: string;
  runDir: string;
  runId: string;
  result: RunResult;
  summary: string;
  durationStop: boolean;
  killed: boolean;
  redactor: Redactor;
  artifacts: { screenshots: string[]; traces: string[] };
  redactionFailed: boolean;
}): Promise<ParentPacket> {
  let evidenceZip = '';
  if (!input.redactionFailed) {
    evidenceZip = join(input.runDir, 'evidence.zip');
    await exportEvidence(input.projectId, input.runId, evidenceZip, input.home);
  }
  const summaryFile = join(input.runDir, 'summary.md');
  const summary = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : input.summary;
  const analysisFile = join(input.runDir, 'analysis.json');
  const analysis = existsSync(analysisFile) ? (JSON.parse(readFileSync(analysisFile, 'utf8')) as unknown) : {};
  const packetPath = join(input.home, 'projects', input.projectId, 'latest-parent-report.json');
  const packet: ParentPacket = {
    validation_required: true,
    run_id: input.runId,
    project: input.projectId,
    status: input.redactionFailed ? 'redaction_failure' : input.durationStop ? 'duration' : input.result.status,
    summary,
    analysis,
    evidence_zip: evidenceZip,
    html_path: join(input.runDir, 'report.html'),
    screenshot_paths: input.artifacts.screenshots,
    trace_paths: input.artifacts.traces,
    packet_path: packetPath,
    instruction: PARENT_INSTRUCTION,
    killed: input.killed,
  };
  let encoded = JSON.stringify(packet, null, 2);
  if (input.redactor.contains(encoded)) {
    const candidates = [evidenceZip, join(input.runDir, 'evidence.zip'), join(input.runDir, 'report.html'), ...input.artifacts.screenshots, ...input.artifacts.traces];
    for (const file of candidates) {
      if (!file || !fileContainsSecret(file, input.redactor)) continue;
      quarantineFile(file);
    }
    packet.status = 'redaction_failure';
    packet.summary = 'Redaction failed. The summary was withheld.';
    packet.analysis = { withheld: true };
    packet.evidence_zip = '';
    packet.screenshot_paths = [];
    packet.trace_paths = [];
    packet.html_path = '';
    encoded = JSON.stringify(packet, null, 2);
    if (input.redactor.contains(encoded)) encoded = input.redactor.redact(encoded);
  }
  ensureDir(join(input.home, 'projects', input.projectId));
  writeFileSync(packetPath, `${encoded}\n`);
  return JSON.parse(encoded) as ParentPacket;
}

function failAnalysis(analysis: Analysis): Analysis {
  return analysisSchema.parse({
    ...analysis,
    status: 'redaction_failure',
    redaction: 'fail',
    suspected_cause: 'A saved file still contained something that should have stayed hidden.',
    suggested_next_actions: ['Do not share these results.', 'Remove the hidden text and run the check again.'],
  });
}

export function readJourneyYaml(projectId: string, journeyId: string, home = aegisHome()): string {
  const project = projectSchema.parse(parse(readFileSync(join(home, 'projects', projectId, 'project.yaml'), 'utf8')));
  return readFileSync(resolveJourneyArg(home, project, journeyId), 'utf8');
}

function makeRunId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const hex = Math.random().toString(16).slice(2, 8);
  return `run_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${hex}`;
}

function isoOffset(date = new Date()): string {
  const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function rescanRun(runDir: string, project: string, home = aegisHome()): Promise<{ ok: boolean; status: RunResult['status'] }> {
  const redactor = new Redactor();
  registerProjectSecrets(project, redactor, home);
  const hits = await scanTree(runDir, redactor);
  const file = join(runDir, 'run.json');
  const result = runResultSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (hits.length === 0) return { ok: true, status: result.status };
  const analysisFile = join(runDir, 'analysis.json');
  const analysis = existsSync(analysisFile) ? analysisSchema.parse(JSON.parse(readFileSync(analysisFile, 'utf8'))) : undefined;
  for (const hit of hits) quarantineHit(hit);
  result.status = 'redaction_failure';
  result.redaction = 'fail';
  const summary = summaryMarkdown([], 'redaction_failure');
  if (analysis) writeRunReports(runDir, result, failAnalysis(analysis), summary, redactor);
  else {
    writeFileSync(file, redactor.redact(`${JSON.stringify(result, null, 2)}\n`));
    writeFileSync(join(runDir, 'summary.md'), redactor.redact(summary));
    writeFileSync(join(runDir, 'report.html'), redactor.redact(htmlReport(result, summary)));
  }
  writeAudit({ interface: 'cli', action: 'redaction_failure', project, run_id: result.run_id, result: 'quarantined' }, redactor, home);
  return { ok: false, status: 'redaction_failure' };
}


