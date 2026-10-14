import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import {
  activitiesPermitted,
  analysisSchema,
  CHAOS_PROFILES,
  chaosPermitted,
  chaosSequence,
  globalConfigSchema,
  parallelRunners,
  passiveOrigins,
  perRunnerRate,
  practiceLimits,
  productionGate,
  projectDomainsAuthorised,
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
  diagnose,
  htmlReport,
  junitXml,
  quarantineFile,
  redactTree,
  sanitizeNetworkLogs,
  scanTree,
  summarizeReliability,
  type ReliabilityReport,
  summaryMarkdown,
  timingChanged,
  writeEvidenceZip,
  type RichJourney,
  type RichStep,
  type RichUser,
} from '@hornet-swarm/report';
import { writeAudit } from './audit.js';
import { assertAuthorisationUsable, loadAuthorisation, loadProject } from './authorisation.js';
import { injectSecrets, injectTotp, listFields, projectSecretValues, registerProjectSecrets } from './broker.js';
import { HornetError } from './errors.js';
import { ensureCredentialPage } from './credentials.js';
import { runnerStatus, startStoppedRunner, stopRunners } from './env.js';
import { aegisHome, ensureDir } from './home.js';
import { acquireLease, heartbeatStoredLease, releaseStoredLease, withFileLock, writeFileAtomic } from './leases-store.js';
import { runWithToken, runnerFetch } from './runner-auth.js';


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
  /**
   * Open regression copies join a suite run, and the suite records new ones. A single-journey
   * run does neither. Defaults to true.
   */
  includeRegressions?: boolean;
  /**
   * Whether a journey may be named by a file path. The CLI allows it. An agent names journeys by
   * id only, so it cannot make the harness read a file outside the project. Defaults to true.
   */
  journeyPathsAllowed?: boolean;
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
  /** The page's words and form-field values beside each screenshot. Quote these, not a reading of the picture. */
  page_text_paths: string[];
  trace_paths: string[];
  packet_path: string;
  instruction: string;
  killed: boolean;
  max_run_duration_min: number;
  deadline: string;
  /** Set when a journey ended on a human check or a second code. That journey is finished. */
  stop_note?: string;
};

const STOP_NOTE =
  'A journey ended on a human check or a second code. That journey is finished and will not resume. The screenshot is for a person to look at. Do not try to solve the challenge.';

const PARENT_INSTRUCTION =
  "The parent agent (a Grok Build session, Grok Bot, Claude, or another MCP client) reads this packet, checks it against the task, and only then tells the owner the outcome. The harness does not grade a site's AI replies.";

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
  const project = loadProject(request.project, home);
  const auth = loadAuthorisation(project.authorisation_id, home);
  const gate = request.gate ?? project.phase2.gate;
  const agentId = request.agentId ?? `cli-${process.pid}`;
  if (existsSync(join(home, 'KILL'))) throw new HornetError('The kill switch is on.', 2);
  try {
    cleanupRetention(home);
  } catch {
    // Retention is housekeeping. A failure to prune old runs does not stop this one.
  }
  assertAuthorisationUsable(auth, home);
  const domains = projectDomainsAuthorised(project, auth);
  if (!domains.ok) throw new HornetError(domains.reason, 3);
  const production = productionGate(project, auth, Boolean(request.confirmProduction));
  if (!production.ok) throw new HornetError(production.reason, 3);
  const polite = practiceLimits(project, auth);
  if (!polite.ok) throw new HornetError(polite.reason, 3);
  if (request.chaos) {
    if (!CHAOS_PROFILES.includes(request.chaos.profile)) throw new HornetError(`unknown chaos profile: ${request.chaos.profile}. Use one of ${CHAOS_PROFILES.join(', ')}.`, 3);
    const allowed = chaosPermitted(auth, project);
    if (!allowed.ok) throw new HornetError(allowed.reason, 3);
  }
  const includeRegressions = request.includeRegressions ?? true;
  const journeys = request.phase1Only ? [] : loadJourneys(home, project, request.journeyFiles ?? [], includeRegressions, request.journeyPathsAllowed ?? true);
  const knownSecrets = projectSecretValues(project.id, home);
  for (const journey of journeys) {
    const checked = validateJourneyYaml(journey.text, project, knownSecrets);
    // Name the journey, so "steps.19: Invalid input" says which of several files to fix.
    if (!checked.valid || !checked.journey) throw new HornetError(`${journeyIdOf(journey.text) ?? basename(journey.file)}: ${checked.errors.join('; ')}`, 3);
    journey.journey = checked.journey;
  }
  const activities = activitiesPermitted(auth, { signIn: true, journeys: journeys.map((entry) => entry.journey as Journey) });
  if (!activities.ok) throw new HornetError(activities.reason, 3);
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
  const renewQuietly = () => {
    try {
      heartbeatStoredLease(project.id, agentId, home, ttlMs, via);
    } catch {
      // A missed renewal is retried on the next tick. It must never crash the process that holds the lease.
    }
  };
  const maxActive = parallelRunners(project);
  /**
   * Returns 'busy' when another agent holds the label, and 'stopped' when the kill switch or the
   * deadline came while this run waited for one of the project's runner slots.
   */
  const busyUntil = new Map<string, string | undefined>();
  const hold = async (label: string, work: () => Promise<void>): Promise<'held' | 'busy' | 'stopped'> => {
    const acquire = (audit: boolean) =>
      acquireLease({
        project: project.id,
        label,
        agentId,
        runId,
        candidates: project.users.map((user) => user.label),
        maxActive,
        auditRefusal: audit,
        home,
        via,
        ...(request.leaseTtlMs ? { ttlMs: request.leaseTtlMs } : {}),
      });
    let lease = acquire(true);
    // Every runner slot is in use by other agents. Wait for one, as a person waits for a free desk.
    while (!lease.ok && lease.reason === 'parallel_limit') {
      if (existsSync(join(home, 'KILL'))) {
        killed = true;
        return 'stopped';
      }
      if (Date.now() >= deadline) {
        durationStop = true;
        return 'stopped';
      }
      await delay(SLOT_POLL_MS);
      lease = acquire(false);
    }
    if (!lease.ok) {
      if (lease.reason === 'agent_already_holds') throw new HornetError('agent already holds a login', 3);
      busyUntil.set(label, lease.busyUntil);
      if (phaseResults.length === 0) throw new HornetError(busyMessage(label, lease.busyUntil), 3);
      return 'busy';
    }
    const intervalMs = Math.max(20, Math.min(60_000, Math.floor(ttlMs / 3)));
    const renew = setInterval(renewQuietly, intervalMs);
    try {
      await work();
    } finally {
      clearInterval(renew);
      renewQuietly();
      releaseStoredLease(project.id, agentId, home, via);
    }
    return 'held';
  };
  /** Each journey's outcome for every label in this run, so a regression is judged once per run. */
  const outcomes = new Map<string, { entry: { file: string; journey?: Journey }; statuses: StepResult['status'][] }>();
  try {
    for (const label of labels) {
      if (Date.now() >= deadline) {
        durationStop = true;
        phaseResults.push({ label, report: durationReport() });
        break;
      }
      const held = await hold(label, async () => {
        const phase1 = await runPhase1(project, label, runId, home, agentId, deadline, totpCodes);
        phaseResults.push({ label, report: phase1.report });
        if (phase1.killed) killed = true;
        if (phase1.report.blocked_reason === 'duration') durationStop = true;
      });
      // A login another agent took mid-run is recorded for that label. The labels already checked keep their results.
      if (held === 'busy') phaseResults.push({ label, report: leaseBusyReport(label, busyUntil.get(label)) });
      if (held === 'stopped') phaseResults.push({ label, report: killed ? killReport() : durationReport() });
      if (killed || durationStop) break;
    }
    const everyPhasePassed = phaseResults.length === labels.length && phaseResults.every((item) => item.report.status === 'passed');
    for (const item of phaseResults) {
      const entries = journeys.filter((entry) => entry.journey?.users.includes(item.label));
      const phaseOk = item.report.status === 'passed';
      const blockedByGate = gate === 'all' && !everyPhasePassed;
      // A journey with requires_phase1: false runs even when this label's sign-in check did not pass.
      const runnable = entries.filter((entry) => entry.journey?.requires_phase1 === false || (phaseOk && !blockedByGate));
      const userJourneys: RichJourney[] = [];
      let leaseLost = false;
      if (!killed && !durationStop && runnable.length > 0) {
        const held = await hold(item.label, async () => {
          for (const entry of runnable) {
            if (killed || durationStop) break;
            const played = await runJourney(project, item.label, entry.journey as Journey, runId, home, deadline, totpCodes, request.chaos);
            if (played.killed) killed = true;
            if (played.duration) durationStop = true;
            userJourneys.push(played.journey);
            const id = entry.journey?.id ?? 'journey';
            const outcome = outcomes.get(id) ?? { entry, statuses: [] };
            outcome.statuses.push(played.journey.status);
            outcomes.set(id, outcome);
          }
        });
        leaseLost = held === 'busy';
      }
      for (const entry of entries) {
        if (userJourneys.some((journey) => journey.id === entry.journey?.id)) continue;
        if (durationStop || leaseLost) {
          userJourneys.push({
            id: entry.journey?.id ?? 'journey',
            name: entry.journey?.name ?? 'Check',
            status: 'blocked',
            duration_ms: 0,
            steps: [],
            blocked_reason: durationStop ? 'duration' : 'lease_busy',
          });
          continue;
        }
        userJourneys.push({ id: entry.journey?.id ?? 'journey', name: entry.journey?.name ?? 'Check', status: 'skipped', duration_ms: 0, steps: [] });
      }
      rich.push({ label: item.label, phase1: phaseRecord(item.report), journeys: userJourneys });
    }
    if (includeRegressions) {
      for (const { entry, statuses } of outcomes.values()) rememberRegression(home, project.id, entry, runOutcome(statuses));
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
      maxRunDurationMin: project.limits.max_run_duration_min,
      deadline,
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
  const diagnosis = diagnose(rich, status);
  const analysis = buildAnalysis({
    result,
    users: rich,
    chaos: request.chaos ? { profile: request.chaos.profile, seed: request.chaos.seed, actions: loggedChaos } : null,
    suspected: diagnosis.suspected,
    confidence: diagnosis.confidence,
    repro: diagnosis.repro,
    regressions: listRegressions(home, project.id),
    next: diagnosis.next,
  });
  const summary = summaryMarkdown(rich, status, request.chaos);
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
    maxRunDurationMin: project.limits.max_run_duration_min,
    deadline,
    challengeStop: rich.some((user) => hasChallengeStop(user)),
  });
  return { ...result, parent };
}

function hasChallengeStop(user: RichUser): boolean {
  const challenge = (reason?: string) => reason === 'captcha' || reason === '2fa';
  return (
    challenge(user.phase1.blocked_reason) ||
    user.journeys.some((journey) => challenge(journey.blocked_reason) || journey.steps.some((step) => challenge(step.blocked_reason)))
  );
}

const SLOT_POLL_MS = 1_000;

function killReport(): JobReport {
  return { ok: false, status: 'blocked', blocked_reason: 'kill', steps: [], chaosApplied: [] };
}

/** A journey's result across every label in one run: failed if any label failed, passed only if every label passed. */
export function runOutcome(statuses: ReadonlyArray<StepResult['status']>): 'fail' | 'pass' | 'none' {
  if (statuses.some((status) => status === 'fail' || status === 'error' || status === 'flaky')) return 'fail';
  if (statuses.length > 0 && statuses.every((status) => status === 'pass')) return 'pass';
  return 'none';
}

/** A login another agent holds: which label, until when, and that it says nothing about the site. */
export function busyMessage(label: string, until?: string): string {
  const when = until && !Number.isNaN(Date.parse(until)) ? isoOffset(new Date(until)) : 'later';
  return `${label} is busy until ${when}: another agent holds its login. This is not a site failure. Run it again after that time.`;
}

function leaseBusyReport(label: string, until?: string): JobReport {
  const now = new Date().toISOString();
  return {
    ok: false,
    status: 'blocked',
    blocked_reason: 'lease_busy',
    steps: [{ index: 0, type: 'lease', status: 'blocked', duration_ms: 0, started_at: now, finished_at: now, blocked_reason: 'lease_busy', error: busyMessage(label, until) }],
    chaosApplied: [],
  };
}

/** A runner that is missing, unhealthy, or drops the connection becomes an error for that label only. The other labels keep running. */
async function contained(work: () => Promise<{ report: JobReport; killed: boolean }>): Promise<{ report: JobReport; killed: boolean }> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HornetError && error.exitCode === 3) throw error;
    const message = error instanceof Error ? error.message : 'The runner failed.';
    const now = isoOffset();
    return {
      killed: false,
      report: {
        ok: false,
        status: 'error',
        steps: [{ index: 0, type: 'runner', status: 'error', duration_ms: 0, started_at: now, finished_at: now, error: message }],
        chaosApplied: [],
      },
    };
  }
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
  return contained(() => execute(project, label, journey, runId, home, deadline, undefined, codes));
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
  let played = await contained(() => execute(project, label, journey, runId, home, deadline, chaos, codes));
  let tries = 0;
  while (!played.killed && played.report.blocked_reason !== 'duration' && played.report.status === 'failed' && tries < journey.retries) {
    tries += 1;
    played = await contained(() => execute(project, label, journey, runId, home, deadline, chaos, codes));
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
  return runWithToken(project.id, label, home, () => executeIssued(project, label, journey, runId, home, deadline, chaos, codes));
}

async function executeIssued(
  project: Project,
  label: string,
  journey: Journey,
  runId: string,
  home: string,
  deadline: number,
  chaos?: { profile: string; seed: string },
  codes: string[] = [],
): Promise<{ report: JobReport; killed: boolean }> {
  // A run stopped before this job is not handed the login at all.
  const stopNow = existsSync(join(home, 'KILL')) ? 'kill' : Date.now() >= deadline ? 'duration' : undefined;
  if (stopNow) {
    return applyReturnedJob({
      abortReason: stopNow,
      killPresent: stopNow === 'kill',
      report: { ok: false, status: 'blocked', steps: [], chaosApplied: [] },
      projectId: project.id,
      label,
      stopRunners,
    });
  }
  const endpoint = await endpointFor(project.id, label);
  const injected = await injectSecrets(project.id, label, endpoint, home);
  if (project.auth.totp.enabled) {
    const totp = await injectTotp(project.id, label, endpoint, home);
    if (totp.code) codes.push(totp.code);
  }
  const target = containerTarget(project);
  // The label and journey join the seed, so each journey meets a different, still repeatable, pattern.
  const actions = chaos ? chaosSequence(`${chaos.seed}:${label}:${journey.id}`, chaos.profile, journey.steps.length) : [];
  const gate = await openOperatorGate(project.id, label, home);
  const pollUrl = gate?.pollUrl;
  const rate = perRunnerRate(project);
  const body = {
    runId,
    label,
    journeyId: journey.id,
    baseUrl: target.base,
    steps: journey.steps,
    allowOrigins: target.origins,
    passiveOrigins: passiveOrigins(project),
    authEndpoints: project.auth.auth_endpoints,
    minStepDelayMs: project.limits.min_step_delay_ms,
    rps: rate.rps,
    burst: rate.burst,
    http2: project.runners.http2,
    accessDeniedMarkers: project.auth.access_denied_markers,
    chaosActions: actions,
    outDir: `/out/${runId}/${journey.id}`,
    vars: journey.vars,
    users: Object.fromEntries(project.users.map((user) => [user.label, { vars: user.vars }])),
    deadline,
    operatorWaitMs: project.auth.operator_code_wait_sec * 1000,
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
    await moveArtifacts(home, project, label, runId, journey.id);
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
    await moveArtifacts(home, project, label, runId, journey.id).catch(() => undefined);
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
    if (gate) await closeOperatorGate(gate).catch(() => undefined);
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

type OperatorGateHandle = { port: number; id: string; token: string; pollUrl: string };

async function openOperatorGate(project: string, label: string, home: string): Promise<OperatorGateHandle | undefined> {
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
    return { port, id: opened.id, token: opened.token, pollUrl: `http://host.docker.internal:${port}/v1/operator-code/${id}?token=${token}` };
  } catch {
    return undefined;
  }
}

async function closeOperatorGate(gate: OperatorGateHandle): Promise<void> {
  await fetch(`http://127.0.0.1:${gate.port}/v1/operator-code/${encodeURIComponent(gate.id)}?token=${encodeURIComponent(gate.token)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(2_000),
  });
}

async function endpointFor(projectId: string, label: string): Promise<string> {
  const missing = `No healthy runner for ${label}. Start one with: hornet-swarm env up --project ${projectId}`;
  const runner = await runnerStatus(projectId, label);
  if (runner.health === 'healthy' && runner.endpoint) return runner.endpoint;
  const started = await startStoppedRunner(projectId, label);
  if (!started) throw new HornetError(missing, 4);
  const again = await runnerStatus(projectId, label);
  if (again.health === 'healthy' && again.endpoint) return again.endpoint;
  throw new HornetError(missing, 4);
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
  maxRunDurationMin?: number;
  deadline?: number;
}): { run: boolean; packet: boolean; message: string } {
  const redactor = new Redactor();
  try {
    registerProjectSecrets(input.projectId, redactor, input.home);
  } catch {
    // A missing store still gets a packet with a fixed summary.
  }
  for (const code of input.codes ?? []) redactor.register('totp_code', code);
  let run: boolean;
  let packet: boolean;
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
      page_text_paths: [],
      trace_paths: [],
      packet_path: packetPath,
      instruction: PARENT_INSTRUCTION,
      killed: false,
      max_run_duration_min: input.maxRunDurationMin ?? 30,
      deadline: input.deadline ? new Date(input.deadline).toISOString() : '',
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

/**
 * Each label has its own baseline, because accounts can be meant to look different, such as a
 * visual-test account. A baseline saved before baselines were per label is still read for any
 * label that has none of its own.
 */
export function baselineDir(home: string, project: string, label: string, journeyId: string): string {
  const own = join(home, 'baselines', project, label, journeyId);
  if (existsSync(own)) return own;
  const shared = join(home, 'baselines', project, journeyId);
  return existsSync(join(shared, 'timings.json')) ? shared : own;
}

/** Words on the page compare equal when only their spacing differs. */
export function textChanged(before: string, after: string): boolean {
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
  return squash(before) !== squash(after);
}

function applyBaselines(home: string, project: string, users: RichUser[]): void {
  for (const user of users) {
    for (const journey of user.journeys) {
      const base = baselineDir(home, project, user.label, journey.id);
      const timingFile = join(base, 'timings.json');
      const saved = existsSync(timingFile) ? (JSON.parse(readFileSync(timingFile, 'utf8')) as Record<string, number>) : {};
      for (const step of journey.steps) {
        const shot = step.screenshot_paths?.[0];
        const baseShot = join(base, `${step.index}.png`);
        let visual: 'same' | 'changed' | 'no_baseline' = 'same';
        let ratio: number | undefined;
        if (shot && existsSync(baseShot)) {
          const compared = compareScreenshots(readFileSync(baseShot), readFileSync(shot));
          visual = compared.visual;
          ratio = compared.ratio;
        } else if (shot) visual = 'no_baseline';
        const before = saved[String(step.index)];
        const timing = before === undefined ? 'no_baseline' : timingChanged(before, step.duration_ms) ? 'slower' : 'same';
        const shotText = shot ? shot.replace(/\.png$/, '.txt') : '';
        const baseText = join(base, `${step.index}.txt`);
        const text: 'same' | 'changed' | 'no_baseline' =
          shotText && existsSync(shotText) && existsSync(baseText)
            ? textChanged(readFileSync(baseText, 'utf8'), readFileSync(shotText, 'utf8'))
              ? 'changed'
              : 'same'
            : 'no_baseline';
        const notes: string[] = [];
        if (visual === 'changed') notes.push('The page looks different from the saved baseline.');
        if (text === 'changed') notes.push('The words on the page differ from the saved baseline.');
        if (timing === 'slower') notes.push('This step took longer than the saved baseline.');
        step.diff = {
          visual,
          ...(ratio !== undefined ? { visual_mismatch_ratio: ratio } : {}),
          timing,
          text,
          console: (step.console_error_count ?? 0) > (saved[`console-${step.index}`] ?? 0) ? 'new_errors' : before === undefined ? 'no_baseline' : 'same',
          network: (step.network_errors?.length ?? 0) > (saved[`network-${step.index}`] ?? 0) ? 'new_errors' : before === undefined ? 'no_baseline' : 'same',
          notes,
        };
      }
    }
  }
}

export function acceptBaseline(project: string, runId: string, home = aegisHome()): { ok: true } {
  if (!/^[a-z0-9-]+$/.test(project)) throw new HornetError('Unknown project.', 3);
  if (!RUN_ID.test(runId)) throw new HornetError('Unknown run id.', 3);
  const runDir = join(home, 'runs', runId);
  const analysis = JSON.parse(readFileSync(join(runDir, 'analysis.json'), 'utf8')) as {
    project?: string;
    users: RichUser[];
  };
  if (analysis.project !== project) throw new HornetError('That run belongs to another project.', 3);
  for (const user of analysis.users) {
    if (!/^qa-user-\d+$/.test(user.label)) continue;
    for (const journey of user.journeys) {
      if (!/^[a-z0-9-]+$/.test(journey.id)) continue;
      const dir = ensureDir(join(home, 'baselines', project, user.label, journey.id));
      const timings: Record<string, number> = {};
      for (const step of journey.steps) {
        timings[String(step.index)] = step.duration_ms;
        timings[`console-${step.index}`] = step.console_error_count ?? 0;
        timings[`network-${step.index}`] = step.network_errors?.length ?? 0;
        // Only files inside this run are copied. The paths come from the run's own report.
        const shot = step.screenshot_paths?.[0];
        if (!shot || !shot.startsWith(`${runDir}/`) || !existsSync(shot)) continue;
        copyFileSync(shot, join(dir, `${step.index}.png`));
        const text = shot.replace(/\.png$/, '.txt');
        if (existsSync(text)) copyFileSync(text, join(dir, `${step.index}.txt`));
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

/** Reliability for one project across its saved runs, newest `last` runs only. */
/**
 * Reliability across recent runs. Chaos runs are left out by default, because a disruption the
 * harness added is not the site's everyday reliability. `chaos: 'only'` reports on them alone.
 */
export function reliabilityReport(projectId: string, last = 20, home = aegisHome(), chaos: 'exclude' | 'only' = 'exclude'): ReliabilityReport {
  if (!/^[a-z0-9-]+$/.test(projectId)) throw new HornetError('Unknown project.', 3);
  const root = join(home, 'runs');
  const runs: RunResult[] = [];
  let leftOut = 0;
  if (existsSync(root)) {
    for (const name of readdirSync(root).filter((entry) => entry.startsWith('run_')).sort()) {
      try {
        const parsed = runResultSchema.safeParse(JSON.parse(readFileSync(join(root, name, 'run.json'), 'utf8')));
        if (!parsed.success || parsed.data.project !== projectId) continue;
        const withChaos = runUsedChaos(join(root, name));
        if (withChaos === (chaos === 'only')) runs.push(parsed.data);
        else leftOut += 1;
      } catch {
        // A run folder without a readable run.json is skipped.
      }
    }
  }
  const size = Math.max(1, Math.min(500, Math.trunc(last)));
  const report = summarizeReliability(projectId, runs.sort((left, right) => left.started_at.localeCompare(right.started_at)).slice(-size));
  if (leftOut > 0) {
    report.notes.push(
      chaos === 'only'
        ? `Only chaos runs are counted. ${leftOut} run${leftOut === 1 ? '' : 's'} without chaos ${leftOut === 1 ? 'was' : 'were'} left out.`
        : `${leftOut} chaos run${leftOut === 1 ? ' was' : 's were'} left out. See them with --chaos.`,
    );
  }
  return report;
}

function runUsedChaos(runDir: string): boolean {
  try {
    const analysis = JSON.parse(readFileSync(join(runDir, 'analysis.json'), 'utf8')) as { chaos?: unknown };
    return Boolean(analysis.chaos);
  } catch {
    return false;
  }
}

export function listProjectUsers(projectId: string, home = aegisHome()): { label: string; role: string; tenant: string }[] {
  const project = loadProject(projectId, home);
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

/**
 * Moves a job's files out of the runner folder into the run folder. Symbolic links written by
 * the runner are skipped. Session headers are masked and auth endpoint bodies are dropped
 * before anything else reads the files. The runner copy is deleted, so no unredacted trace
 * stays behind in the runner folder.
 */
export async function moveArtifacts(home: string, project: Project, label: string, runId: string, journeyId: string): Promise<void> {
  const runEntry = join(home, 'runners', project.id, label, runId);
  if (!lstatExists(runEntry)) return;
  // The run's folder is first moved out of the runner's reach in one rename. A rename moves a
  // link itself rather than what it points to, so a runner that put a link where its folder
  // belongs can never make the copy or the delete below reach a file elsewhere on this Mac.
  const staged = join(ensureDir(join(home, 'staging')), `${label}-${runId}-${randomBytes(4).toString('hex')}`);
  renameSync(runEntry, staged);
  try {
    const source = join(staged, journeyId);
    const stagedLink = lstatSync(staged).isSymbolicLink();
    const sourceLink = !stagedLink && lstatExists(source) && lstatSync(source).isSymbolicLink();
    if (stagedLink || sourceLink) {
      throw new HornetError('The runner wrote a link where its results belong. Nothing was copied, and the link was removed.', 4);
    }
    if (!lstatExists(source)) return;
    const destination = ensureDir(join(home, 'runs', runId, label, journeyId));
    cpSync(source, destination, { recursive: true, filter: (path) => !lstatSync(path).isSymbolicLink() });
    await sanitizeNetworkLogs(destination, authEndpointPatterns(project));
  } finally {
    if (lstatExists(staged) && lstatSync(staged).isSymbolicLink()) unlinkSync(staged);
    else rmSync(staged, { recursive: true, force: true });
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bodies dropped from the network logs: the project's auth_endpoints, and always the
 * sign-in page itself, where a login form usually posts and a session token usually comes back.
 */
export function authEndpointPatterns(project: Project): string[] {
  const signin = new URL(project.auth.signin_url, project.targets.base_url);
  const patterns = new Set(project.auth.auth_endpoints);
  for (const url of [signin.toString(), rewriteForContainer(signin.toString(), macAddresses())]) {
    const parsed = new URL(url);
    patterns.add(`${parsed.origin}${parsed.pathname}`);
  }
  return [...patterns];
}

function loadJourneys(home: string, project: Project, files: string[], includeRegressions: boolean, pathsAllowed: boolean): { text: string; file: string; journey?: Journey }[] {
  const selected =
    files.length > 0
      ? files.map((file) => resolveJourneyArg(home, project, file, pathsAllowed))
      : readdirSync(resolveJourneys(home, project)).filter((name) => name.endsWith('.yaml')).map((name) => join(resolveJourneys(home, project), name));
  const loaded = selected.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  if (!includeRegressions) return loaded;
  // An open regression joins the run once. It is skipped when the run already has a journey with that id.
  const ids = new Set(loaded.map((entry) => journeyIdOf(entry.text)));
  const regressions = regressionFiles(home, project.id)
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter((entry) => !ids.has(journeyIdOf(entry.text)));
  return [...loaded, ...regressions];
}

function journeyIdOf(text: string): string | undefined {
  try {
    const parsed = parse(text) as { id?: unknown };
    return typeof parsed?.id === 'string' ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function agentJourneysDir(home: string, project: string): string {
  return join(home, 'projects', project, 'agent-journeys');
}

/**
 * Saves a journey an agent wrote, after the same checks as any journey: the schema, the
 * allowlist and passive origins, no literal secret, and fixture paths inside the fixtures
 * folder. It cannot replace an owner journey with the same id. Returns the saved path.
 */
export function saveAgentJourney(projectId: string, yamlText: string, home = aegisHome()): { path: string; id: string } {
  const project = loadProject(projectId, home);
  const checked = validateJourneyYaml(yamlText, project, projectSecretValues(project.id, home));
  if (!checked.valid || !checked.journey) throw new HornetError(checked.errors.join('; '), 3);
  const id = checked.journey.id;
  const ownerDir = resolveJourneys(home, project);
  if (existsSync(join(ownerDir, `${id}.journey.yaml`)) || ownerJourneyIds(ownerDir).has(id)) {
    throw new HornetError(`A project journey already uses the id ${id}. Pick another id.`, 3);
  }
  const dir = agentJourneysDir(home, project.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.journey.yaml`);
  writeFileAtomic(path, yamlText.endsWith('\n') ? yamlText : `${yamlText}\n`);
  return { path, id };
}

function ownerJourneyIds(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => journeyIdOf(readFileSync(join(dir, name), 'utf8')))
      .filter((id): id is string => Boolean(id)),
  );
}

const JOURNEY_ID = /^[a-z0-9-]+$/;
const RUN_ID = /^run_[A-Za-z0-9_-]+$/;

/**
 * A journey id is looked up in the project's journeys, then in the agent journeys. A file path is
 * read as given, but only when paths are allowed, which is the owner's CLI and never an agent.
 */
function resolveJourneyArg(home: string, project: Project, file: string, pathsAllowed: boolean): string {
  const looksLikePath = file.endsWith('.yaml') || file.endsWith('.yml') || file.includes('/');
  if (looksLikePath && pathsAllowed) return file;
  if (!JOURNEY_ID.test(file)) throw new HornetError(`${file} is not a journey id. Name a journey by its id, such as signin-dashboard.`, 3);
  for (const dir of [resolveJourneys(home, project), agentJourneysDir(home, project.id)]) {
    const direct = join(dir, `${file}.journey.yaml`);
    if (existsSync(direct)) return direct;
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.yaml')) continue;
      const path = join(dir, name);
      if (journeyIdOf(readFileSync(path, 'utf8')) === file) return path;
    }
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

/**
 * A journey that failed, errored, or was flaky for any label in a suite run is copied into the
 * regression folder and joins later suite runs. Three suite runs in a row where it passed for
 * every label mark it fixed and retire the copy. The ledger stays as the record.
 */
function rememberRegression(home: string, project: string, entry: { file: string; journey?: Journey }, outcome: 'fail' | 'pass' | 'none'): void {
  if (!entry.journey || outcome === 'none') return;
  const dir = ensureDir(join(home, 'regressions', project));
  const file = join(dir, `${entry.journey.id}.journey.yaml`);
  const ledgerPath = join(dir, `${entry.journey.id}.json`);
  if (outcome === 'fail') {
    if (entry.file !== file) writeFileSync(file, readFileSync(entry.file));
    writeFileSync(ledgerPath, `${JSON.stringify({ state: 'open', consecutive: 0 })}\n`);
    return;
  }
  if (!existsSync(ledgerPath)) return;
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { state: string; consecutive: number };
  if (ledger.state !== 'open') return;
  const consecutive = ledger.consecutive + 1;
  const fixed = consecutive >= 3;
  writeFileSync(ledgerPath, `${JSON.stringify({ state: fixed ? 'fixed' : 'open', consecutive })}\n`);
  if (fixed) rmSync(file, { force: true });
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

function signinState(home: string, project: Project, label: string): { allowed: boolean } {
  const stamps = readSignins(home, project.id).filter((entry) => entry.label === label).map((entry) => entry.at);
  return signinBudget(stamps, Date.now(), project.limits.max_signin_attempts_per_user_per_hour);
}

/** Entries older than the hour window are dropped, and parallel runs take a lock, so the file stays small and no attempt is lost. */
function recordSignin(home: string, project: string, label: string): void {
  const file = join(home, 'projects', project, 'signin.json');
  withFileLock(home, `signin-${project}`, () => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const current = readSignins(home, project).filter((entry) => entry.at >= cutoff);
    current.push({ label, at: Date.now() });
    writeFileAtomic(file, `${JSON.stringify(current)}\n`);
  });
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
  const phaseProblem = input.users.some((user) => user.phase1.status === 'fail');
  const journeyProblem = input.users.some((user) => user.journeys.some((journey) => journey.status === 'fail' || journey.status === 'flaky'));
  // An error is the harness failing, such as a missing runner or a browser that did not start. It is not a site failure.
  const harnessError = input.users.some((user) => user.phase1.status === 'error' || user.journeys.some((journey) => journey.status === 'error'));
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
  if (harnessError) return 'error';
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

function collectArtifacts(runDir: string): { screenshots: string[]; texts: string[]; traces: string[] } {
  const screenshots: string[] = [];
  const texts: string[] = [];
  const traces: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (name.endsWith('.png')) {
        screenshots.push(path);
        const text = path.replace(/\.png$/, '.txt');
        if (existsSync(text)) texts.push(text);
      }
      if (name === 'trace.zip') traces.push(path);
    }
  };
  walk(runDir);
  return { screenshots, texts, traces };
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
  artifacts: { screenshots: string[]; texts?: string[]; traces: string[] };
  redactionFailed: boolean;
  maxRunDurationMin?: number;
  deadline?: number;
  challengeStop?: boolean;
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
    page_text_paths: input.artifacts.texts ?? [],
    trace_paths: input.artifacts.traces,
    packet_path: packetPath,
    instruction: PARENT_INSTRUCTION,
    killed: input.killed,
    max_run_duration_min: input.maxRunDurationMin ?? 30,
    deadline: input.deadline ? new Date(input.deadline).toISOString() : '',
    ...(input.challengeStop ? { stop_note: STOP_NOTE } : {}),
  };
  let encoded = JSON.stringify(packet, null, 2);
  if (input.redactor.contains(encoded)) {
    const candidates = [evidenceZip, join(input.runDir, 'evidence.zip'), join(input.runDir, 'report.html'), ...input.artifacts.screenshots, ...(input.artifacts.texts ?? []), ...input.artifacts.traces];
    for (const file of candidates) {
      if (!file || !fileContainsSecret(file, input.redactor)) continue;
      quarantineFile(file);
    }
    packet.status = 'redaction_failure';
    packet.summary = 'Redaction failed. The summary was withheld.';
    packet.analysis = { withheld: true };
    packet.evidence_zip = '';
    packet.screenshot_paths = [];
    packet.page_text_paths = [];
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

/** Reads a saved journey by its id. Agents call this, so a path is refused. */
export function readJourneyYaml(projectId: string, journeyId: string, home = aegisHome()): string {
  const project = loadProject(projectId, home);
  return readFileSync(resolveJourneyArg(home, project, journeyId, false), 'utf8');
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


