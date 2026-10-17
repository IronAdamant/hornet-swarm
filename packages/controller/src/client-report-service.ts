import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { analysisSchema, clientJobSchema, globalConfigSchema, readRegularFile, Redactor, runResultSchema, writeRedactedFile, type BrandingConfig, type ClientJob } from '@hornet-swarm/core';
import { BrandingError, buildClientReport, clientReportSchema, diffClientReports, renderClientReport, resolveBrand, retestDiffMarkdown, type ClientReport, type RetestDiff } from '@hornet-swarm/report';
import { loadAuthorisation, loadProject } from './authorisation.js';
import { registerProjectSecrets } from './broker.js';
import { HornetError } from './errors.js';
import { readRunFile, runFileIsRegular } from './run-folder-files.js';

const RUN_ID = /^run_[A-Za-z0-9_-]+$/;

export type LoadedJob = { job: ClientJob; path: string };

/** Reads and checks a saved job file. A relative logo path in it is read from beside the file. */
export function loadClientJob(path: string): LoadedJob {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new HornetError(`Could not read the job ${path}: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
  const parsed = clientJobSchema.safeParse(raw);
  if (!parsed.success) throw new HornetError(`The job ${path} is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'job'}: ${issue.message}`).join('; ')}`, 3);
  return { job: parsed.data, path: resolve(path) };
}

function globalBranding(home: string): BrandingConfig | undefined {
  const file = join(home, 'config.yaml');
  if (!existsSync(file)) return undefined;
  const parsed = globalConfigSchema.safeParse(parse(readFileSync(file, 'utf8')) ?? {});
  if (!parsed.success) throw new HornetError(`${file} is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, 3);
  return parsed.data.branding;
}

/** Each logo path, made absolute against the folder of the file that named it. */
function anchorLogos(branding: BrandingConfig | undefined, base: string): BrandingConfig | undefined {
  if (!branding) return undefined;
  const anchor = <T extends { logo?: string }>(details: T | undefined): T | undefined => (details?.logo && !isAbsolute(details.logo) ? { ...details, logo: join(base, details.logo) } : details);
  const agency = anchor(branding.agency);
  const ironAdamant = anchor(branding.iron_adamant);
  return { ...branding, ...(agency ? { agency } : {}), ...(ironAdamant ? { iron_adamant: ironAdamant } : {}) };
}

function readSavedRun(runDir: string, runId: string) {
  const text = readRunFile(runDir, 'run.json');
  if (text === undefined) throw new HornetError(`${runId} has no saved run.json.`, 3);
  const result = runResultSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new HornetError(`${runId} has a run.json this version cannot read.`, 3);
  return result.data;
}

function journeyNames(runDir: string): Map<string, string> {
  const names = new Map<string, string>();
  const text = readRunFile(runDir, 'analysis.json');
  if (text === undefined) return names;
  const analysis = analysisSchema.safeParse(JSON.parse(text));
  if (!analysis.success) return names;
  for (const user of analysis.data.users) for (const journey of user.journeys) names.set(journey.id, journey.name);
  return names;
}

function runDirOf(home: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new HornetError(`${runId} is not a run id.`, 3);
  return join(home, 'runs', runId);
}

export type WrittenClientReport = { report: ClientReport; markdown: string; paths: { markdown: string; html: string; json: string } };

/**
 * Builds the client report for one saved run of a job, and saves it in the run folder as
 * client-report.md, client-report.html, and client-report.json. Every file is sealed, so a
 * password or code that reached the report text stops the write.
 */
export function writeClientReport(input: { job: LoadedJob; runId: string; home: string }): WrittenClientReport {
  const { job, path } = input.job;
  const project = loadProject(job.project, input.home);
  const authorisation = loadAuthorisation(project.authorisation_id, input.home);
  const runDir = runDirOf(input.home, input.runId);
  const run = readSavedRun(runDir, input.runId);
  let brand;
  try {
    brand = resolveBrand(anchorLogos(job.branding, dirname(path)), anchorLogos(globalBranding(input.home), input.home), (logo) => readRegularFile(logo));
  } catch (error) {
    if (error instanceof BrandingError) throw new HornetError(error.message, 3);
    throw error;
  }
  let report: ClientReport;
  let rendered: { markdown: string; html: string };
  try {
    report = buildClientReport({ job, brand, authorisation, run, journeyNames: journeyNames(runDir), hasFile: (file) => runFileIsRegular(runDir, file) });
    rendered = renderClientReport(report);
  } catch (error) {
    throw new HornetError(error instanceof Error ? error.message : String(error), 3);
  }
  const redactor = new Redactor();
  registerProjectSecrets(project.id, redactor, input.home);
  const paths = { markdown: join(runDir, 'client-report.md'), html: join(runDir, 'client-report.html'), json: join(runDir, 'client-report.json') };
  writeRedactedFile(paths.markdown, redactor.seal(rendered.markdown));
  writeRedactedFile(paths.html, redactor.seal(rendered.html));
  writeRedactedFile(paths.json, redactor.seal(`${JSON.stringify(report, null, 2)}\n`));
  return { report, markdown: rendered.markdown, paths };
}

function readSavedReport(runDir: string): ClientReport | undefined {
  const text = readRunFile(runDir, 'client-report.json');
  if (text === undefined) return undefined;
  try {
    const parsed = clientReportSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every saved client report of a job, oldest first. */
export function savedJobReports(home: string, jobId: string): ClientReport[] {
  const root = join(home, 'runs');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => RUN_ID.test(name))
    .flatMap((runId) => {
      const report = readSavedReport(join(root, runId));
      return report && report.job_id === jobId ? [report] : [];
    })
    .sort((left, right) => Date.parse(left.tested_at) - Date.parse(right.tested_at) || left.run_id.localeCompare(right.run_id));
}

export type WrittenRetestDiff = { diff: RetestDiff; markdown: string; paths: { markdown: string; json: string } } | { diff: undefined; reason: string };

/**
 * Compares a run's client report with the job's previous one, or with the run named by
 * `against`, and saves retest-diff.md and retest-diff.json in the run folder.
 */
export function writeRetestDiff(input: { job: LoadedJob; runId: string; home: string; against?: string }): WrittenRetestDiff {
  const runDir = runDirOf(input.home, input.runId);
  const current = readSavedReport(runDir) ?? writeClientReport({ job: input.job, runId: input.runId, home: input.home }).report;
  let previous: ClientReport | undefined;
  if (input.against) {
    previous = readSavedReport(runDirOf(input.home, input.against)) ?? writeClientReport({ job: input.job, runId: input.against, home: input.home }).report;
  } else {
    const earlier = savedJobReports(input.home, input.job.job.id).filter((report) => report.run_id !== current.run_id && Date.parse(report.tested_at) <= Date.parse(current.tested_at));
    previous = earlier[earlier.length - 1];
  }
  if (!previous) return { diff: undefined, reason: `This is the first saved report of ${input.job.job.id}, so there is nothing to compare it with yet.` };
  let diff: RetestDiff;
  let markdown: string;
  try {
    diff = diffClientReports(previous, current);
    markdown = retestDiffMarkdown(diff, current);
  } catch (error) {
    throw new HornetError(error instanceof Error ? error.message : String(error), 3);
  }
  const redactor = new Redactor();
  registerProjectSecrets(input.job.job.project, redactor, input.home);
  const paths = { markdown: join(runDir, 'retest-diff.md'), json: join(runDir, 'retest-diff.json') };
  writeRedactedFile(paths.markdown, redactor.seal(markdown));
  writeRedactedFile(paths.json, redactor.seal(`${JSON.stringify(diff, null, 2)}\n`));
  return { diff, markdown, paths };
}
