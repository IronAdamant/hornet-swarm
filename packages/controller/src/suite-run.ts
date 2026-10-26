import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parallelRunners, privateDir, Redactor, runResultSchema, validateJourneyYaml, type Journey, type RunResult, type StepResult } from '@hornet-swarm/core';
import { buildAnalysis, diagnose, redactTree, scanTree, summaryMarkdown, type RichJourney, type RichUser } from '@hornet-swarm/report';
import { writeAudit } from './audit.js';
import { loadAuthorisation, loadProject } from './authorisation.js';
import { listFields, projectSecretValues, registerProjectSecrets } from './broker.js';
import { HornetError } from './errors.js';
import { aegisHome } from './home.js';
import { acquireLease, heartbeatStoredLease, releaseStoredLease } from './leases-store.js';
import { AuthorisedRun } from './runner-session.js';
import { busyMessage, durationReport, guestReport, hasChallengeStop, killReport, leaseBusyReport, runJourney, runOutcome, runPhase1, SLOT_POLL_MS, writeErrorOutcome } from './suite-execute.js';
import { collectArtifacts, failAnalysis, foldRunStatus, phaseRecord, publishParent, stripPhase, stripStep, totals, writeRunReports } from './suite-publish.js';
import { applyBaselines, cleanupRetention, journeyIdOf, listRegressions, loadJourneys, quarantineHit, rememberRegression } from './suite-store.js';
import { delay, isoOffset, makeRunId, selectRunLabels, type JobReport, type ParentPacket, type SuiteRequest } from './suite-types.js';

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
  const includeRegressions = request.includeRegressions ?? true;
  const { run, loaded: journeys } = AuthorisedRun.authorise(
    { project, auth, agentId, home, confirmProduction: Boolean(request.confirmProduction), ...(request.chaos ? { chaos: request.chaos } : {}) },
    () => {
      const loaded = request.phase1Only ? [] : loadJourneys(home, project, request.journeyFiles ?? [], includeRegressions, request.journeyPathsAllowed ?? true);
      const knownSecrets = projectSecretValues(project.id, home);
      for (const journey of loaded) {
        const checked = validateJourneyYaml(journey.text, project, knownSecrets);
        // Name the journey, so "steps.19: Invalid input" says which of several files to fix.
        if (!checked.valid || !checked.journey) throw new HornetError(`${journeyIdOf(journey.text) ?? basename(journey.file)}: ${checked.errors.join('; ')}`, 3);
        journey.journey = checked.journey;
      }
      return { loaded, journeys: loaded.map((entry) => entry.journey as Journey) };
    },
  );
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
  const runDir = privateDir(join(home, 'runs', runId));
  const rich: RichUser[] = [];
  let killed = false;
  let durationStop = false;
  const phaseResults: { label: string; report: JobReport; guest?: boolean }[] = [];
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
      // A guest has no stored login, and every journey it runs skips sign-in, such as a visitor
      // who books without an account. It is not signed in, and that is not a failure.
      const labelJourneys = journeys.filter((entry) => entry.journey?.users.includes(label));
      if (listFields(project.id, label, home).length === 0 && labelJourneys.length > 0 && labelJourneys.every((entry) => entry.journey?.requires_phase1 === false)) {
        phaseResults.push({ label, report: guestReport(), guest: true });
        continue;
      }
      const held = await hold(label, async () => {
        const phase1 = await runPhase1(run, label, runId, deadline, totpCodes);
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
            const played = await runJourney(run, item.label, entry.journey as Journey, runId, deadline, totpCodes, request.chaos);
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
      rich.push({ label: item.label, phase1: item.guest ? { status: 'skipped', duration_ms: 0, blocked_reason: 'guest' } : phaseRecord(item.report), journeys: userJourneys });
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
  const gatePassed = rich.every((user) => user.phase1.status === 'pass' || user.phase1.blocked_reason === 'guest');
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
  const redactor = new Redactor();
  registerProjectSecrets(project.id, redactor, home);
  for (const code of totpCodes) redactor.register('totp_code', code);
  const withheld = writeRunReports(runDir, result, analysis, summary, redactor, artifacts, {
    baseUrl: project.targets.base_url,
    subjectName: project.name,
  });
  withheld.push(...(await redactTree(runDir, redactor)));
  const hits = [...withheld, ...(await scanTree(runDir, redactor))];
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
