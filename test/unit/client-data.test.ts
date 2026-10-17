import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { globalConfigSchema } from '../../packages/core/src/schemas.ts';
import { privateDir, privateTempDir, Redactor, WCAG22_AA_CRITERIA } from '../../packages/core/src/index.ts';
import { maskPersonalData } from '../../packages/report/src/page-privacy.ts';
import { sanitizeNetworkLogs } from '../../packages/report/src/artifacts.ts';
import { measureAiUsage } from '../../packages/controller/src/ai-usage.ts';
import { loadClientJob, writeClientReport } from '../../packages/controller/src/client-report-service.ts';
import { writeAuthorisedProject } from '../support/authorised-fixture.ts';
import { fixtureRun } from '../support/client-report-fixture.ts';
import { createFixture } from '../fixture-app/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const JOB = (id: string) => `version: 1
id: ${id}
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

let built = false;

function ensureBuilt(): void {
  if (built) return;
  for (const name of ['@hornet-swarm/core', '@hornet-swarm/report', '@hornet-swarm/controller', '@hornet-swarm/cli']) {
    execFileSync('pnpm', ['--filter', name, 'build'], { cwd: root, stdio: 'inherit' });
  }
  built = true;
}

describe('client data handling', () => {
  it('tells clients that full-disk encryption is required and keeps runs for 7 days', () => {
    for (const file of ['docs/client-engagement.md', 'docs/reference.md']) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text).toMatch(/full-disk encryption/i);
      expect(text).toContain('FileVault');
    }
    expect(readFileSync(join(root, 'docs/reference.md'), 'utf8')).toContain('7 by default');
    const example = globalConfigSchema.parse(parse(readFileSync(join(root, 'examples/config.yaml'), 'utf8')));
    expect(example.results_retention_days).toBe(7);
    expect(globalConfigSchema.parse({}).results_retention_days).toBe(7);
  });

  it('lists every manual and partial WCAG 2.2 criterion and does not mark one passed', () => {
    const text = readFileSync(join(root, 'docs/wcag22-manual-checklist.md'), 'utf8');
    const human = WCAG22_AA_CRITERIA.filter((criterion) => criterion.automation !== 'automated');
    expect(human.length).toBeGreaterThan(40);
    for (const criterion of human) {
      const line = text.split('\n').find((entry) => entry.startsWith(`- ${criterion.id} `));
      expect(line, criterion.id).toBeTruthy();
      expect(line).toContain(criterion.title);
      expect(line).toContain(criterion.manualNote);
      expect(line?.toLowerCase()).not.toContain('passed');
    }
  });

  it('masks an email and a phone number in a stored page response and leaves a date', async () => {
    expect(maskPersonalData('due 2026-10-17')).toBe('due 2026-10-17');
    const dir = mkdtempSync(join(tmpdir(), 'hornet-privacy-'));
    const body = 'Account ada@example.com phone 0412 345 678';
    writeFileSync(
      join(dir, 'network.har'),
      JSON.stringify({
        log: {
          entries: [
            { request: { url: 'http://127.0.0.1/account' }, response: { content: { mimeType: 'text/html', text: body } } },
            { request: { url: 'http://127.0.0.1/about' }, response: { content: { mimeType: 'text/html', text: 'about the shop' } } },
          ],
        },
      }),
    );
    expect(await sanitizeNetworkLogs(dir, ['**/login'], new Redactor())).toBe(0);
    const har = readFileSync(join(dir, 'network.har'), 'utf8');
    expect(har).not.toContain('ada@example.com');
    expect(har).not.toContain('0412 345 678');
    expect(har).toContain('[REDACTED:email]');
    expect(har).toContain('[REDACTED:phone]');
    expect(har).toContain('about the shop');
  });

  it('measures zero model calls as 0 USD, and sums only a cost a call already recorded', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hornet-ai-empty-'));
    expect(measureAiUsage(empty)).toEqual({ model_calls: 0, cost_usd: 0, unit: 'USD' });
    const dir = mkdtempSync(join(tmpdir(), 'hornet-ai-calls-'));
    writeFileSync(join(dir, 'ai-calls.jsonl'), '{"cost_usd":0.02}\nnot json\n');
    expect(measureAiUsage(dir)).toEqual({ model_calls: 2, cost_usd: 0.02, unit: 'USD' });
  });

  it('keeps a run for 7 days when the config does not name a number', async () => {
    ensureBuilt();
    vi.resetModules();
    const { cleanupRetention } = await import('../../packages/controller/src/suite.ts');
    const home = privateTempDir('hornet-retention-');
    privateDir(join(home, 'runs'));
    const old = privateDir(join(home, 'runs', 'run_old_keep'));
    const recent = privateDir(join(home, 'runs', 'run_new_keep'));
    const day = 24 * 60 * 60 * 1000;
    utimesSync(old, (Date.now() - 8 * day) / 1000, (Date.now() - 8 * day) / 1000);
    utimesSync(recent, (Date.now() - day) / 1000, (Date.now() - day) / 1000);
    expect(cleanupRetention(home)).toContain('run_old_keep');
    expect(existsSync(recent)).toBe(true);
    writeFileSync(join(home, 'config.yaml'), 'runtime: auto\ndefault_project: example-app\n', { mode: 0o600 });
    const again = privateDir(join(home, 'runs', 'run_old_again'));
    utimesSync(again, (Date.now() - 8 * day) / 1000, (Date.now() - 8 * day) / 1000);
    expect(cleanupRetention(home)).toContain('run_old_again');
    expect(existsSync(recent)).toBe(true);
  }, 180_000);
});

describe('phone viewport, keyboard navigation, and delete-after-delivery', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    process.env.AEGIS_HEADLESS = '1';
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(chrome)) process.env.AEGIS_BROWSER = chrome;
    const app = createFixture();
    server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.AEGIS_HEADLESS;
  });

  it('runs a phone-sized viewport and a keyboard-only step on the offline fixture', async () => {
    ensureBuilt();
    vi.resetModules();
    const { executeJob } = await import('../../packages/runner/src/job.ts');
    const report = await executeJob(
      {
        runId: 'run_phone',
        label: 'qa-user-1',
        journeyId: 'keys',
        baseUrl: `http://127.0.0.1:${port}`,
        steps: [
          { navigate: { url: '/keys' } },
          { viewport: { preset: 'phone' } },
          { assert: { type: 'text_visible', value: 'width 390' } },
          { keyboard: { key: 'Tab' } },
          { assert: { type: 'text_visible', value: 'focused one' } },
        ],
        allowOrigins: [`http://127.0.0.1:${port}`],
        authEndpoints: [],
        minStepDelayMs: 0,
        rps: 50,
        burst: 50,
        accessDeniedMarkers: [],
        chaosActions: [],
        outDir: mkdtempSync(join(tmpdir(), 'hornet-phone-')),
        vars: {},
        users: {},
      },
      new Map(),
      () => false,
    );
    expect(report.status, JSON.stringify(report.steps.map((step) => step.error))).toBe('passed');
  }, 60_000);

  it('deletes one job\'s runs, page bodies, and evidence and leaves another job', () => {
    ensureBuilt();
    const home = privateTempDir('hornet-delete-job-');
    writeAuthorisedProject(home);
    privateDir(join(home, 'runs'));
    const jobs = privateDir(join(home, 'jobs'));
    writeFileSync(join(jobs, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', { mode: 0o600 });
    const save = (id: string, runId: string) => {
      writeFileSync(join(jobs, `${id}.job.yaml`), JOB(id), { mode: 0o600 });
      const run = fixtureRun({ runId, pages: [{ name: 'home', result: { violations: [] } }] });
      const runDir = privateDir(join(home, 'runs', run.run_id));
      writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run)}\n`, { mode: 0o600 });
      const page = 'Reach ada@example.com or 0412 345 678';
      writeFileSync(join(runDir, 'network.har'), JSON.stringify({ log: { entries: [{ response: { content: { text: page } } }] } }));
      writeFileSync(join(runDir, 'evidence.zip'), Buffer.from('evidence'));
      writeClientReport({ job: loadClientJob(join(jobs, `${id}.job.yaml`)), runId, home });
      return runDir;
    };
    const gone = save('job-delivered', 'run_20261017-000000_jobaaa');
    const kept = save('job-other', 'run_20261017-000000_jobbbb');
    const unrelated = privateDir(join(home, 'runs', 'run_20261017-000000_loose1'));
    writeFileSync(join(unrelated, 'network.har'), 'keep this other run');
    const out = execFileSync(process.execPath, [join(root, 'packages/cli/dist/main.js'), 'delete-after-delivery', '--job', join(jobs, 'job-delivered.job.yaml'), '--json'], {
      cwd: root,
      env: { ...process.env, AEGIS_HOME: home },
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toMatchObject({ ok: true, job_id: 'job-delivered', removed: ['run_20261017-000000_jobaaa'] });
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(join(kept, 'network.har'))).toBe(true);
    expect(readFileSync(join(kept, 'network.har'), 'utf8')).toContain('ada@example.com');
    expect(existsSync(join(kept, 'evidence.zip'))).toBe(true);
    expect(existsSync(join(kept, 'client-report.md'))).toBe(true);
    expect(readFileSync(join(unrelated, 'network.har'), 'utf8')).toBe('keep this other run');
  }, 180_000);
});
