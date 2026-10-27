import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { analysisSchema, privateDir, readRegularFile, Redactor, runResultSchema, UnredactableError, writeRedactedFile, type Analysis, type RunResult, type StepResult } from '@hornet-swarm/core';
import { analysisMarkdown, htmlReport, IaFindingsError, iaFindingsFromRun, junitXml, quarantineFile, renderIaFindings, scanTree, summaryMarkdown, type RichStep, type RichUser } from '@hornet-swarm/report';
import { writeAudit } from './audit.js';
import { loadProject } from './authorisation.js';
import { registerProjectSecrets } from './broker.js';
import { aegisHome } from './home.js';
import { exportEvidence, fileContainsSecret, quarantineHit, resolveJourneyArg } from './suite-store.js';
import { mapStatus, PARENT_INSTRUCTION, STOP_NOTE, type JobReport, type ParentPacket } from './suite-types.js';

export function phaseRecord(report: JobReport): RichUser['phase1'] {
  return {
    status: report.blocked_reason === 'signin_limit' ? 'blocked' : mapStatus(report),
    duration_ms: report.steps.reduce((sum, step) => sum + step.duration_ms, 0),
    ...(report.blocked_reason ? { blocked_reason: report.blocked_reason } : {}),
    ...(report.steps.find((step) => step.error)?.error ? { error: report.steps.find((step) => step.error)?.error } : {}),
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

export function stripPhase(phase: RichUser['phase1']): RunResult['users'][number]['phase1'] {
  return {
    status: phase.status,
    duration_ms: phase.duration_ms,
    ...(phase.blocked_reason ? { blocked_reason: phase.blocked_reason } : {}),
    ...(phase.error ? { error: phase.error } : {}),
  };
}

export function stripStep(step: RichStep): StepResult {
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
    ...(step.accessibility ? { accessibility: step.accessibility } : {}),
    ...(step.passive_security ? { passive_security: step.passive_security } : {}),
    ...(step.redundant_entry ? { redundant_entry: step.redundant_entry } : {}),
  };
}

export function totals(users: RichUser[]): RunResult['totals'] {
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

/** Returns the files left unwritten because redaction could not clean them. The caller treats them as redaction hits. */
export function writeRunReports(
  runDir: string,
  result: RunResult,
  analysis: Analysis,
  summary: string,
  redactor: Redactor,
  artifacts?: { screenshots: string[]; traces: string[] },
  iaContext?: { baseUrl?: string; subjectName?: string },
): string[] {
  const reports: [string, () => string][] = [
    ['run.json', () => `${JSON.stringify(result, null, 2)}\n`],
    ['summary.md', () => summary],
    ['analysis.json', () => `${JSON.stringify(analysis, null, 2)}\n`],
    ['analysis.md', () => analysisMarkdown(analysis)],
    ['report.html', () => htmlReport(result, summary, artifacts)],
    ['junit.xml', () => junitXml(result)],
  ];
  const withheld: string[] = [];
  for (const [name, render] of reports) {
    const file = join(runDir, name);
    try {
      writeRedactedFile(file, redactor.seal(render()));
    } catch (error) {
      if (!(error instanceof UnredactableError)) throw error;
      withheld.push(file);
    }
  }
  withheld.push(...writeIaFindings(runDir, result, redactor, iaContext));
  return withheld;
}

/**
 * Internal findings file and the report rendered from it. A failed redaction check writes neither.
 * These files are groundwork. They are not the client report, and the run marks them internal.
 */
function writeIaFindings(runDir: string, result: RunResult, redactor: Redactor, iaContext?: { baseUrl?: string; subjectName?: string }): string[] {
  if (result.redaction === 'fail') return [];
  let written: { json: string; markdown: string; html: string };
  try {
    const doc = iaFindingsFromRun(result, { ...iaContext, axeFiles: readSavedAxeFiles(runDir) });
    const rendered = renderIaFindings(doc);
    written = { json: `${JSON.stringify(doc, null, 2)}\n`, markdown: rendered.markdown, html: rendered.html };
  } catch (error) {
    if (error instanceof IaFindingsError) return [];
    throw error;
  }
  const withheld: string[] = [];
  for (const [name, text] of [
    ['ia-findings.json', written.json],
    ['ia-report.md', written.markdown],
    ['ia-report.html', written.html],
  ] as const) {
    const file = join(runDir, name);
    try {
      writeRedactedFile(file, redactor.seal(text));
    } catch (error) {
      if (!(error instanceof UnredactableError)) throw error;
      withheld.push(file);
    }
  }
  return withheld;
}

function readSavedAxeFiles(runDir: string): { path: string; body: unknown }[] {
  const found: { path: string; body: unknown }[] = [];
  const root = resolve(runDir);
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('accessibility-') || !entry.name.endsWith('.json')) continue;
      try {
        const text = readRegularFile(full).toString('utf8');
        found.push({ path: relative(root, full).split(sep).join('/'), body: JSON.parse(text) as unknown });
      } catch {
        continue;
      }
    }
  };
  walk(root);
  return found;
}

export function collectArtifacts(runDir: string): { screenshots: string[]; texts: string[]; traces: string[] } {
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
  }
  const sealed = input.redactor.seal(`${encoded}\n`);
  privateDir(join(input.home, 'projects', input.projectId));
  writeRedactedFile(packetPath, sealed);
  return JSON.parse(sealed) as ParentPacket;
}

export function failAnalysis(analysis: Analysis): Analysis {
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
    writeRedactedFile(file, redactor.seal(`${JSON.stringify(result, null, 2)}\n`));
    writeRedactedFile(join(runDir, 'summary.md'), redactor.seal(summary));
    writeRedactedFile(join(runDir, 'report.html'), redactor.seal(htmlReport(result, summary)));
  }
  writeAudit({ interface: 'cli', action: 'redaction_failure', project, run_id: result.run_id, result: 'quarantined' }, redactor, home);
  return { ok: false, status: 'redaction_failure' };
}
