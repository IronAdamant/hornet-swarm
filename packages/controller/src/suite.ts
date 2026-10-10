import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  authorisationSchema,
  chaosPermitted,
  chaosSequence,
  globalConfigSchema,
  productionGate,
  projectDomainsAuthorised,
  projectSchema,
  Redactor,
  runResultSchema,
  signinBudget,
  validateJourneyYaml,
  type Journey,
  type Project,
  type RunResult,
  type StepResult,
} from '@aegis/core';
import {
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
} from '@aegis/report';
import { writeAudit } from './audit.js';
import { injectSecrets, injectTotp, registerProjectSecrets } from './broker.js';
import { AegisError } from './errors.js';
import { envStatus, stopRunners } from './env.js';
import { aegisHome, ensureDir } from './home.js';
import { acquireLease, releaseStoredLease } from './leases-store.js';


export { AegisError } from './errors.js';

type JobReport = {
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
};

export async function runSuite(request: SuiteRequest): Promise<RunResult> {
  const home = request.home ?? aegisHome();
  const project = projectSchema.parse(parse(readFileSync(join(home, 'projects', request.project, 'project.yaml'), 'utf8')));
  const auth = authorisationSchema.parse(parse(readFileSync(join(home, 'authorisations', `${project.authorisation_id}.yaml`), 'utf8')));
  const gate = request.gate ?? project.phase2.gate;
  const agentId = request.agentId ?? process.env.AEGIS_AGENT_ID ?? `cli-${process.pid}`;
  if (existsSync(join(home, 'KILL'))) throw new AegisError('The kill switch is on.', 2);
  const domains = projectDomainsAuthorised(project, auth);
  if (!domains.ok) throw new AegisError(domains.reason, 3);
  const production = productionDecision(project, auth, Boolean(request.confirmProduction));
  if (!production.ok) throw new AegisError(production.reason, 3);
  if (request.chaos) {
    const allowed = chaosPermitted(auth, project);
    if (!allowed.ok) throw new AegisError(allowed.reason, 3);
  }
  const journeys = request.phase1Only ? [] : loadJourneys(home, project, request.journeyFiles ?? []);
  for (const journey of journeys) {
    const checked = validateJourneyYaml(journey.text, project);
    if (!checked.valid || !checked.journey) throw new AegisError(checked.errors.join('; '), 3);
    journey.journey = checked.journey;
  }
  const labels = request.phase1Only
    ? (request.users ?? project.users.map((user) => user.label))
    : [...new Set(journeys.flatMap((entry) => entry.journey?.users ?? []))];
  const runId = makeRunId();
  const started = isoOffset();
  const runDir = ensureDir(join(home, 'runs', runId));
  const rich: RichUser[] = [];
  let killed = false;
  const phaseResults: { label: string; report: JobReport }[] = [];
  const hold = (label: string, work: () => Promise<void>): Promise<void> => {
    const lease = acquireLease({
      project: project.id,
      label,
      agentId,
      runId,
      candidates: project.users.map((user) => user.label),
      home,
      via: request.via ?? 'cli',
    });
    if (!lease.ok) throw new AegisError(lease.reason === 'busy' ? `busy until ${lease.busyUntil ?? 'later'}` : 'agent already holds a login', 3);
    return work().finally(() => releaseStoredLease(project.id, agentId, home, request.via ?? 'cli'));
  };
  try {
    for (const label of labels) {
      await hold(label, async () => {
        const phase1 = await runPhase1(project, label, runId, home, agentId);
        phaseResults.push({ label, report: phase1.report });
        if (phase1.killed) killed = true;
      });
      if (killed) break;
    }
    const everyPhasePassed = phaseResults.length === labels.length && phaseResults.every((item) => item.report.status === 'passed');
    for (const item of phaseResults) {
      const entries = journeys.filter((entry) => entry.journey?.users.includes(item.label));
      const phaseOk = item.report.status === 'passed';
      const blockedByGate = gate === 'all' && !everyPhasePassed;
      const userJourneys: RichJourney[] = [];
      if (!killed && phaseOk && !blockedByGate && entries.length > 0) {
        await hold(item.label, async () => {
          for (const entry of entries) {
            if (killed) break;
            const played = await runJourney(project, item.label, entry.journey as Journey, runId, home, request.chaos);
            if (played.killed) killed = true;
            userJourneys.push(played.journey);
            rememberRegression(home, project.id, entry, played.journey);
          }
        });
      }
      for (const entry of entries) {
        if (userJourneys.some((journey) => journey.id === entry.journey?.id)) continue;
        userJourneys.push({ id: entry.journey?.id ?? 'journey', name: entry.journey?.name ?? 'Check', status: 'skipped', duration_ms: 0, steps: [] });
      }
      rich.push({ label: item.label, phase1: phaseRecord(item.report), journeys: userJourneys });
    }
  } catch (error) {
    releaseStoredLease(project.id, agentId, home, request.via ?? 'cli');
    if (error instanceof AegisError) throw error;
    throw new AegisError(error instanceof Error ? error.message : 'The run failed.', 4);
  }
  const gatePassed = rich.every((user) => user.phase1.status === 'pass');
  const phaseProblem = rich.some((user) => user.phase1.status === 'fail' || user.phase1.status === 'error');
  const journeyProblem = rich.some((user) => user.journeys.some((journey) => journey.status === 'fail' || journey.status === 'error' || journey.status === 'flaky'));
  const rateLimited = rich.some((user) => user.phase1.blocked_reason === 'rate_limited' || user.journeys.some((journey) => journey.steps.some((step) => step.blocked_reason === 'rate_limited')));
  const blocked = killed || rich.some((user) => user.phase1.status === 'blocked' || user.journeys.some((journey) => journey.status === 'blocked'));
  let status: RunResult['status'] = 'passed';
  if (phaseProblem || journeyProblem) status = 'failed';
  else if (rateLimited) status = 'rate_limited';
  else if (blocked) status = 'blocked';
  else if (!gatePassed) status = 'failed';
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
  const suspected = status === 'passed' ? 'Nothing failed.' : killed ? 'The run was stopped.' : 'A check did not match what we expected.';
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
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(runDir, 'summary.md'), summary);
  writeFileSync(join(runDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
  writeFileSync(join(runDir, 'analysis.md'), analysisMarkdown(analysis));
  writeFileSync(join(runDir, 'junit.xml'), junitXml(result));
  writeFileSync(join(runDir, 'report.html'), htmlReport(result, summary));
  const redactor = new Redactor();
  registerProjectSecrets(project.id, redactor, home);
  await redactTree(runDir, redactor);
  const hits = await scanTree(runDir, redactor);
  if (hits.length > 0) {
    for (const hit of hits) quarantineHit(hit);
    result.status = 'redaction_failure';
    result.redaction = 'fail';
    writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(result, null, 2)}\n`);
    writeAudit({ interface: request.via ?? 'cli', agent: agentId, action: 'redaction_failure', project: project.id, run_id: runId, result: 'quarantined' }, redactor, home);
  }
  writeAudit({ interface: request.via ?? 'cli', agent: agentId, action: 'run_suite', project: project.id, run_id: runId, labels, result: result.status }, redactor, home);
  return result;
}

async function runPhase1(project: Project, label: string, runId: string, home: string, _agent: string): Promise<{ report: JobReport; killed: boolean }> {
  const budget = signinState(home, project, label);
  if (!budget.allowed) {
    return {
      killed: false,
      report: { ok: false, status: 'blocked', blocked_reason: 'signin_limit', steps: [], chaosApplied: [] },
    };
  }
  recordSignin(home, project.id, label);
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
    steps: [
      { navigate: { url: project.auth.signin_url } },
      { fill: { selector: project.auth.selectors.username, credential: `${label}.username` } },
      { fill: { selector: project.auth.selectors.password, credential: `${label}.password` } },
      { click: { selector: project.auth.selectors.submit } },
      { wait: { for: 'navigation' } },
      ...project.auth.success.map((assertion) => ({ assert: assertion })),
    ],
  };
  const played = await execute(project, label, journey, runId, home);
  return played;
}

async function runJourney(
  project: Project,
  label: string,
  journey: Journey,
  runId: string,
  home: string,
  chaos?: { profile: string; seed: string },
): Promise<{ journey: RichJourney; killed: boolean }> {
  let played = await execute(project, label, journey, runId, home, chaos);
  let tries = 0;
  while (!played.killed && played.report.status === 'failed' && tries < journey.retries) {
    tries += 1;
    played = await execute(project, label, journey, runId, home, chaos);
  }
  const status = tries > 0 && played.report.status === 'passed' ? 'flaky' : mapStatus(played.report);
  const steps = played.report.steps.map((step) => (status === 'flaky' ? { ...step, status: 'flaky' as const } : step));
  return {
    killed: played.killed,
    journey: {
      id: journey.id,
      name: journey.name,
      status,
      duration_ms: steps.reduce((sum, step) => sum + step.duration_ms, 0),
      steps,
      chaosApplied: played.report.chaosApplied,
    },
  };
}

async function execute(
  project: Project,
  label: string,
  journey: Journey,
  runId: string,
  home: string,
  chaos?: { profile: string; seed: string },
): Promise<{ report: JobReport; killed: boolean }> {
  const status = await envStatus(project.id);
  const runner = status.runners.find((entry) => entry.label === label && entry.endpoint);
  if (!runner?.endpoint) throw new AegisError(`No healthy runner for ${label}.`, 4);
  const injected = await injectSecrets(project.id, label, runner.endpoint, home);
  if (project.auth.totp.enabled) await injectTotp(project.id, label, runner.endpoint, home);
  const target = containerTarget(project);
  const actions = chaos ? chaosSequence(chaos.seed, chaos.profile, journey.steps.length) : [];
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
  };
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (existsSync(join(home, 'KILL'))) controller.abort();
  }, 400);
  try {
    const response = await fetch(`${runner.endpoint}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const report = (await response.json()) as JobReport;
    copyArtifacts(home, project.id, label, runId, journey.id);
    rewriteArtifacts(home, project.id, label, runId, journey.id, report);
    void injected;
    return { report, killed: false };
  } catch (error) {
    if (controller.signal.aborted || existsSync(join(home, 'KILL'))) {
      await Promise.race([stopRunners(project.id), delay(2_000)]);
      return { report: { ok: false, status: 'blocked', blocked_reason: 'kill', steps: [], chaosApplied: [] }, killed: true };
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
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
  if (!existsSync(dir)) throw new AegisError(`Unknown journey ${file}.`, 3);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.yaml')) continue;
    const path = join(dir, name);
    const parsed = parse(readFileSync(path, 'utf8')) as { id?: string };
    if (parsed.id === file) return path;
  }
  throw new AegisError(`Unknown journey ${file}.`, 3);
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
  const baseUrl = new URL(project.targets.base_url);
  const origins = new Set(project.targets.allowed_origins);
  for (const origin of project.targets.allowed_origins) origins.add(origin);
  if (baseUrl.hostname === 'localhost' || baseUrl.hostname === '127.0.0.1') {
    const rewritten = new URL(baseUrl.toString());
    rewritten.hostname = 'host.docker.internal';
    origins.add(rewritten.origin);
    return { base: rewritten.toString(), origins: [...origins] };
  }
  return { base: baseUrl.toString(), origins: [...origins] };
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

function analysisMarkdown(analysis: { suspected_cause: string; suggested_next_actions: string[] }): string {
  return `# Analysis\n\n${analysis.suspected_cause}\n\n${analysis.suggested_next_actions.map((line) => `- ${line}`).join('\n')}\n`;
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
  for (const hit of hits) quarantineHit(hit);
  result.status = 'redaction_failure';
  result.redaction = 'fail';
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(runDir, 'summary.md'), summaryMarkdown([], 'redaction_failure'));
  writeAudit({ interface: 'cli', action: 'redaction_failure', project, run_id: result.run_id, result: 'quarantined' }, redactor, home);
  return { ok: false, status: 'redaction_failure' };
}


