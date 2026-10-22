import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chaosSequence, passiveOrigins, perRunnerRate, privateDir, Redactor, rewriteForContainer, runResultSchema, signinBudget, writePrivateFile, writeRedactedFile, type Journey, type Project, type StepResult } from '@hornet-swarm/core';
import { unsupportedPass, type RichJourney, type RichStep, type RichUser } from '@hornet-swarm/report';
import { injectSecrets, injectTotp, listFields, registerProjectSecrets } from './broker.js';
import { ensureCredentialPage } from './credentials.js';
import { HornetError } from './errors.js';
import { assertExistingRunnerIsolated, runnerStatus, startStoppedRunner, stopRunners } from './env.js';
import { withFileLock } from './leases-store.js';
import { runnerFetch } from './runner-auth.js';
import { AuthorisedRun, RunnerSession } from './runner-session.js';
import { macAddresses, moveArtifacts } from './suite-store.js';
import { delay, isoOffset, mapStatus, PARENT_INSTRUCTION, type JobReport, type ParentPacket } from './suite-types.js';

export function hasChallengeStop(user: RichUser): boolean {
  const challenge = (reason?: string) => reason === 'captcha' || reason === '2fa';
  return (
    challenge(user.phase1.blocked_reason) ||
    user.journeys.some((journey) => challenge(journey.blocked_reason) || journey.steps.some((step) => challenge(step.blocked_reason)))
  );
}

export const SLOT_POLL_MS = 1_000;

export function killReport(): JobReport {
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

/** Sign-in for a guest: nothing to check. Recorded as skipped, with the reason guest. */
export function guestReport(): JobReport {
  return { ok: true, status: 'passed', steps: [], chaosApplied: [] };
}

export function leaseBusyReport(label: string, until?: string): JobReport {
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
export async function contained(work: () => Promise<{ report: JobReport; killed: boolean }>): Promise<{ report: JobReport; killed: boolean }> {
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

export async function runPhase1(run: AuthorisedRun, label: string, runId: string, deadline: number, codes: string[]): Promise<{ report: JobReport; killed: boolean }> {
  const { project, home } = run;
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
  const steps = signInSteps(project, label);
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
  return contained(() => execute(run, label, journey, runId, deadline, undefined, codes));
}

/** The project's own sign-in, as journey steps: the sign-in check runs these, and so does an inspection. */
export function signInSteps(project: Project, label: string): Journey['steps'] {
  const steps: Journey['steps'] = [
    { navigate: { url: project.auth.signin_url } },
    ...(project.auth.prepare ?? []).map((selector) => ({ click: { selector } })),
    { fill: { selector: project.auth.selectors.username, credential: `${label}.username` } },
    { fill: { selector: project.auth.selectors.password, credential: `${label}.password` } },
  ];
  if (project.auth.totp.enabled) steps.push({ fill: { selector: project.auth.selectors.totp, totp: label } });
  steps.push({ click: { selector: project.auth.selectors.submit } }, { wait: { for: 'navigation' } }, ...project.auth.success.map((assertion) => ({ assert: assertion })));
  return steps;
}

export async function runJourney(
  run: AuthorisedRun,
  label: string,
  journey: Journey,
  runId: string,
  deadline: number,
  codes: string[],
  chaos?: { profile: string; seed: string },
): Promise<{ journey: RichJourney; killed: boolean; duration: boolean }> {
  let played = await contained(() => execute(run, label, journey, runId, deadline, chaos, codes));
  let tries = 0;
  while (!played.killed && played.report.blocked_reason !== 'duration' && played.report.status === 'failed' && tries < journey.retries) {
    tries += 1;
    played = await contained(() => execute(run, label, journey, runId, deadline, chaos, codes));
  }
  return {
    killed: played.killed,
    duration: played.report.blocked_reason === 'duration',
    journey: journeyFromJob(played.report, { id: journey.id, name: journey.name, tries }),
  };
}

export async function execute(
  run: AuthorisedRun,
  label: string,
  journey: Journey,
  runId: string,
  deadline: number,
  chaos?: { profile: string; seed: string },
  codes: string[] = [],
): Promise<{ report: JobReport; killed: boolean }> {
  return RunnerSession.open(run, label, endpointFor, (session) => executeIssued(session, journey, runId, deadline, chaos, codes));
}

export async function executeIssued(
  session: RunnerSession,
  journey: Journey,
  runId: string,
  deadline: number,
  chaos?: { profile: string; seed: string },
  codes: string[] = [],
): Promise<{ report: JobReport; killed: boolean }> {
  const { project, home } = session.run;
  const { label } = session;
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
  const endpoint = await session.endpoint();
  // A guest has no login to hand over. A journey that asks for one fails at its fill step and says so.
  const injected = listFields(project.id, label, home).length > 0 ? await injectSecrets(session) : { ok: true, handles: [] };
  if (project.auth.totp.enabled) {
    const totp = await injectTotp(session);
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
    ...(session.run.auth.activities.includes('passive_security_checks') ? { passiveSecurityAuthorised: true } : {}),
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
    const response = await session.fetch('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const report = vouchedReport((await response.json()) as JobReport, journey.steps.length);
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

export type OperatorGateHandle = { port: number; id: string; token: string; pollUrl: string };

export async function openOperatorGate(project: string, label: string, home: string): Promise<OperatorGateHandle | undefined> {
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

export async function closeOperatorGate(gate: OperatorGateHandle): Promise<void> {
  await fetch(`http://127.0.0.1:${gate.port}/v1/operator-code/${encodeURIComponent(gate.id)}?token=${encodeURIComponent(gate.token)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(2_000),
  });
}

export async function endpointFor(projectId: string, label: string): Promise<string> {
  const missing = `No healthy runner for ${label}. Start one with: hornet-swarm env up --project ${projectId}`;
  await assertExistingRunnerIsolated(projectId, label);
  const runner = await runnerStatus(projectId, label);
  if (runner.health === 'healthy' && runner.endpoint) return runner.endpoint;
  const started = await startStoppedRunner(projectId, label);
  if (!started) throw new HornetError(missing, 4);
  const again = await runnerStatus(projectId, label);
  if (again.health === 'healthy' && again.endpoint) return again.endpoint;
  throw new HornetError(missing, 4);
}

export async function postAbort(projectId: string, endpoint: string, home: string): Promise<void> {
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
    writeRedactedFile(join(input.runDir, 'run.json'), redactor.seal(`${JSON.stringify(result, null, 2)}\n`));
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
    privateDir(join(input.home, 'projects', input.projectId));
    writeRedactedFile(packetPath, redactor.seal(`${JSON.stringify(body, null, 2)}\n`));
    packet = true;
  } catch {
    packet = false;
  }
  return { run, packet, message: redactor.redact(input.message) };
}

export function durationReport(): JobReport {
  return { ok: false, status: 'blocked', blocked_reason: 'duration', steps: [], chaosApplied: [] };
}

export function rewriteArtifacts(home: string, project: string, label: string, runId: string, journeyId: string, report: JobReport): void {
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

export function containerTarget(project: Project): { base: string; origins: string[] } {
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

export function signinState(home: string, project: Project, label: string): { allowed: boolean } {
  const stamps = readSignins(home, project.id).filter((entry) => entry.label === label).map((entry) => entry.at);
  return signinBudget(stamps, Date.now(), project.limits.max_signin_attempts_per_user_per_hour);
}

/** Entries older than the hour window are dropped, and parallel runs take a lock, so the file stays small and no attempt is lost. */
export function recordSignin(home: string, project: string, label: string): void {
  const file = join(home, 'projects', project, 'signin.json');
  withFileLock(home, `signin-${project}`, () => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const current = readSignins(home, project).filter((entry) => entry.at >= cutoff);
    current.push({ label, at: Date.now() });
    writePrivateFile(file, `${JSON.stringify(current)}\n`);
  });
}

export function readSignins(home: string, project: string): { label: string; at: number }[] {
  try {
    return JSON.parse(readFileSync(join(home, 'projects', project, 'signin.json'), 'utf8')) as { label: string; at: number }[];
  } catch {
    return [];
  }
}

/** A pass the runner cannot show step by step becomes a harness error, with the reason as its last step. */
export function vouchedReport(report: JobReport, sentSteps: number): JobReport {
  const problem = unsupportedPass(report, sentSteps);
  if (!problem) return report;
  const now = new Date().toISOString();
  const marker: RichStep = { index: report.steps.length, type: 'check', status: 'error', duration_ms: 0, started_at: now, finished_at: now, error: problem };
  return { ...report, ok: false, status: 'error', steps: [...report.steps, marker] };
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
