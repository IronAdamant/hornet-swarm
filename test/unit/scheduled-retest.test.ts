import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateDir, privateTempDir, type RunResult } from '../../packages/core/src/index.ts';
import { writeAuthorisedProject } from '../support/authorised-fixture.ts';
import { CONTRAST, IMAGE_ALT, fixtureRun, type FixtureRunOptions } from '../support/client-report-fixture.ts';

const suite = vi.hoisted(() => ({ next: undefined as undefined | (() => RunResult), calls: [] as unknown[] }));

vi.mock('../../packages/controller/src/suite.ts', () => ({
  runSuite: async (request: unknown) => {
    suite.calls.push(request);
    if (!suite.next) throw new Error('no run prepared');
    return { ...suite.next(), parent: { packet_path: '' } };
  },
}));

const { loadClientJob, savedJobReports, writeClientReport, writeRetestDiff } = await import('../../packages/controller/src/client-report-service.ts');
const { retestDue, runRetest } = await import('../../packages/controller/src/scheduled-retest.ts');

let home: string;

const JOB = `version: 1
id: fixture-monthly
project: fixture
client: { business_name: Fixture Shop Pty Ltd, site_name: Fixture Shop, site_url: "http://127.0.0.1:4173" }
branding: { agency: { name: Test Agency Pty Ltd, logo: ./logo.svg } }
journeys:
  - { id: pages }
  - { id: checkout, covers: checkout }
not_in_scope:
  - { covers: sign_up, reason: Not offered on this site. }
schedule: { cadence: monthly }
`;

function saveRun(options: FixtureRunOptions): RunResult {
  const run = fixtureRun(options);
  const runDir = privateDir(join(home, 'runs', run.run_id));
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run)}\n`, { mode: 0o600 });
  const journeyDir = privateDir(join(runDir, 'qa-user-1', 'pages'));
  for (const step of run.users[0]?.journeys[0]?.steps ?? []) {
    if (step.accessibility) writeFileSync(join(journeyDir, `accessibility-${step.accessibility.name}.json`), '{}\n', { mode: 0o600 });
  }
  return run;
}

function jobFile(): string {
  const dir = privateDir(join(home, 'jobs'));
  writeFileSync(join(dir, 'fixture.job.yaml'), JOB, { mode: 0o600 });
  writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', { mode: 0o600 });
  return join(dir, 'fixture.job.yaml');
}

beforeEach(() => {
  home = privateTempDir('hornet-swarm-retest-');
  writeAuthorisedProject(home);
  privateDir(join(home, 'runs'));
  suite.next = undefined;
  suite.calls = [];
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the client report service', () => {
  it('writes the report into the run folder as private Markdown, HTML, and JSON', () => {
    const run = saveRun({ pages: [{ name: 'home', result: { violations: [IMAGE_ALT] } }] });
    const written = writeClientReport({ job: loadClientJob(jobFile()), runId: run.run_id, home });
    for (const path of Object.values(written.paths)) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(written.paths.markdown, 'utf8')).toContain('1 issue found against WCAG 2.2 AA in tested pages');
    expect(readFileSync(written.paths.html, 'utf8')).toContain('data:image/svg+xml;base64,');
    expect(written.report.brand.name).toBe('Test Agency Pty Ltd');
    expect(savedJobReports(home, 'fixture-monthly').map((report) => report.run_id)).toEqual([run.run_id]);
  });

  it('names the authorisation the run was made under, not the project\'s current one', () => {
    const run = saveRun({ pages: [{ name: 'home', result: { violations: [IMAGE_ALT] } }] });
    const projectFile = join(home, 'projects', 'fixture', 'project.yaml');
    writeFileSync(projectFile, readFileSync(projectFile, 'utf8').replace('authorisation_id: fixture-owner', 'authorisation_id: renewed-owner'));
    const written = writeClientReport({ job: loadClientJob(jobFile()), runId: run.run_id, home });
    expect(readFileSync(written.paths.markdown, 'utf8')).toContain('fixture-owner');
  });

  it('refuses a run id that is a path, and a job file that is not valid', () => {
    const job = loadClientJob(jobFile());
    expect(() => writeClientReport({ job, runId: '../outside', home })).toThrow(/not a run id/);
    writeFileSync(join(home, 'jobs', 'bad.job.yaml'), 'version: 1\nid: Bad Id\n', { mode: 0o600 });
    expect(() => loadClientJob(join(home, 'jobs', 'bad.job.yaml'))).toThrow(/is not valid/);
  });

  it('compares a run with the job\'s previous report, and says so when there is none', () => {
    const job = loadClientJob(jobFile());
    const first = saveRun({ runId: 'run_20261001-000000_aaaaaa', finishedAt: '2026-10-01T00:00:00.000Z', pages: [{ name: 'home', result: { violations: [IMAGE_ALT, CONTRAST] } }] });
    const firstDiff = writeRetestDiff({ job, runId: first.run_id, home });
    expect(firstDiff.diff).toBeUndefined();
    const second = saveRun({ runId: 'run_20261029-000000_bbbbbb', finishedAt: '2026-10-29T00:00:00.000Z', pages: [{ name: 'home', result: { violations: [CONTRAST] } }], journeys: { checkout: 'fail' } });
    const diff = writeRetestDiff({ job, runId: second.run_id, home });
    if (!diff.diff) throw new Error(diff.reason);
    expect(diff.diff.previous_run).toBe(first.run_id);
    expect(diff.diff.fixed.map((issue) => issue.key)).toEqual(['a11y:image-alt']);
    expect(diff.diff.journey_regressions.map((change) => change.kind)).toEqual(['checkout']);
    expect(statSync(diff.paths.markdown).mode & 0o777).toBe(0o600);
  });

  it('does not write a report for a run that failed its redaction check', () => {
    const run = saveRun({ status: 'redaction_failure', redaction: 'fail' });
    expect(() => writeClientReport({ job: loadClientJob(jobFile()), runId: run.run_id, home })).toThrow(/must not be shared/);
  });
});

describe('the scheduled re-test', () => {
  it('is due when the job has no report, or its cadence has passed', () => {
    const job = loadClientJob(jobFile());
    expect(retestDue(home, job).due).toBe(true);
    const run = saveRun({ finishedAt: '2026-10-01T00:00:00.000Z' });
    writeClientReport({ job, runId: run.run_id, home });
    expect(retestDue(home, job, new Date('2026-10-20T00:00:00.000Z'))).toMatchObject({ due: false, next_due_at: '2026-10-29T00:00:00.000Z' });
    expect(retestDue(home, job, new Date('2026-10-29T00:00:00.000Z')).due).toBe(true);
  });

  it('waits a day after an attempt that left no report, instead of re-running every hour', async () => {
    const job = loadClientJob(jobFile());
    suite.next = () => saveRun({ status: 'redaction_failure', redaction: 'fail' });
    const first = await runRetest({ job, home, ifDue: true, now: new Date('2026-10-20T00:00:00.000Z') });
    expect(first.ran).toBe(true);
    const hourLater = await runRetest({ job, home, ifDue: true, now: new Date('2026-10-20T01:00:00.000Z') });
    expect(hourLater.ran).toBe(false);
    expect(suite.calls).toHaveLength(1);
    expect(retestDue(home, job, new Date('2026-10-21T00:00:00.000Z')).due).toBe(true);
  });

  it('skips a job that is not due without starting a run', async () => {
    const job = loadClientJob(jobFile());
    writeClientReport({ job, runId: saveRun({ finishedAt: '2026-10-01T00:00:00.000Z' }).run_id, home });
    const outcome = await runRetest({ job, home, ifDue: true, now: new Date('2026-10-10T00:00:00.000Z') });
    expect(outcome.ran).toBe(false);
    expect(suite.calls).toEqual([]);
  });

  it('runs the job\'s journeys by id through the authorised suite, then writes the report and the comparison', async () => {
    const job = loadClientJob(jobFile());
    writeClientReport({ job, runId: saveRun({ runId: 'run_20261001-000000_aaaaaa', finishedAt: '2026-10-01T00:00:00.000Z', pages: [{ name: 'home', result: { violations: [IMAGE_ALT] } }] }).run_id, home });
    suite.next = () => saveRun({ runId: 'run_20261029-000000_bbbbbb', finishedAt: '2026-10-29T00:00:00.000Z' });
    const outcome = await runRetest({ job, home, ifDue: true, now: new Date('2026-10-29T01:00:00.000Z') });
    expect(suite.calls).toEqual([expect.objectContaining({ project: 'fixture', journeyFiles: ['pages', 'checkout'], journeyPathsAllowed: false, includeRegressions: false, confirmProduction: false })]);
    if (!outcome.ran || !outcome.diff?.diff) throw new Error('expected a comparison');
    expect(outcome.diff.diff.fixed.map((issue) => issue.key)).toEqual(['a11y:image-alt']);
    expect(readFileSync(join(home, 'audit.log'), 'utf8')).toContain('"action":"retest"');
  });

  it('writes no report for a re-test run that failed its redaction check', async () => {
    const job = loadClientJob(jobFile());
    suite.next = () => saveRun({ status: 'redaction_failure', redaction: 'fail' });
    const outcome = await runRetest({ job, home });
    expect(outcome).toMatchObject({ ran: true, not_reported: expect.stringContaining('redaction check') });
    expect(savedJobReports(home, 'fixture-monthly')).toEqual([]);
  });
});
