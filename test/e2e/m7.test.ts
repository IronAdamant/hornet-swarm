import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { analysisSchema } from '../../packages/core/dist/index.js';
import { cleanupRetention } from '../../packages/controller/dist/index.js';
import { hornet, clearSignins, containsSecret, home, journeys, latestRun, readRun, resetFixture, secret } from './helper.js';

beforeAll(() => {
  clearSignins();
});

describe('regressions, chaos, baselines, evidence, and flaky results', () => {
  it('keeps a failed check until it passes three times', async () => {
    await resetFixture({ failFlag: true });
    const failed = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
    expect(failed.status).toBe(1);
    expect(readFileSync(join(home, 'regressions/fixture/flag-check.journey.yaml'), 'utf8')).toContain('flag-check');
    const failedReport = readRun();
    analysisSchema.parse(failedReport.analysis);
    expect(failedReport.analysis.suspected_cause).toBeTruthy();
    expect(failedReport.analysis.repro_steps).toBeTruthy();
    expect(failedReport.summary).not.toContain(secret);
    expect(failedReport.summary).not.toMatch(/run_\d/);
    await resetFixture({ failFlag: false });
    // While open, the regression copy joins a suite run that did not name it.
    const withRegression = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'chaos.journey.yaml')]);
    expect(withRegression.status, withRegression.stdout).toBe(0);
    const openIds = (readRun().result.users as { journeys: { id: string }[] }[])[0]?.journeys.map((journey) => journey.id);
    expect(openIds).toContain('flag-check');
    // A single-journey run leaves it out.
    const single = hornet(['journey', join(journeys, 'chaos.journey.yaml'), '--project', 'fixture', '--json']);
    expect(single.status, single.stdout).toBe(0);
    expect((readRun().result.users as { journeys: { id: string }[] }[])[0]?.journeys.map((journey) => journey.id)).not.toContain('flag-check');
    // The same id from the named file is not run twice, and its passes count toward fixed.
    for (let pass = 2; pass <= 3; pass += 1) {
      const ok = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
      expect(ok.status, `pass ${pass} ${ok.stdout}`).toBe(0);
      const ids = (readRun().result.users as { journeys: { id: string }[] }[])[0]?.journeys.map((journey) => journey.id) ?? [];
      expect(ids.filter((id) => id === 'flag-check')).toHaveLength(1);
    }
    const ledger = JSON.parse(readFileSync(join(home, 'regressions/fixture/flag-check.json'), 'utf8')) as { state: string; consecutive: number };
    expect(ledger.state).toBe('fixed');
    expect(ledger.consecutive).toBe(3);
    expect(existsSync(join(home, 'regressions/fixture/flag-check.journey.yaml'))).toBe(false);
    const again = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'chaos.journey.yaml')]);
    expect(again.status).toBe(0);
    const ids = (readRun().result.users as { journeys: { id: string }[] }[])[0]?.journeys.map((journey) => journey.id);
    expect(ids).not.toContain('flag-check');
  });

  it('repeats a chaos seed and refuses chaos without permission', () => {
    const first = chaos();
    const second = chaos();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    const authPath = join(home, 'authorisations/fixture-owner.yaml');
    const original = readFileSync(authPath, 'utf8');
    writeFileSync(authPath, original.replace(', chaos', ''));
    try {
      const refused = hornet(['suite', '--project', 'fixture', '--chaos', 'latency', '--seed', 'same', '--json', '--journey', join(journeys, 'chaos.journey.yaml')]);
      expect(refused.status).toBe(3);
      expect(refused.stdout + refused.stderr).toContain('chaos_not_authorised');
    } finally {
      writeFileSync(authPath, original);
    }
  });

  it('flags a layout change and leaves the baseline alone until it is accepted', async () => {
    await resetFixture({ layout: 'steady', delayMs: 0 });
    const first = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'layout.journey.yaml')]);
    expect(first.status).toBe(0);
    const runId = (readRun().result.run_id as string);
    const baselinePng = join(home, 'baselines/fixture/layout-check/1.png');
    expect(hornet(['accept-baseline', runId, '--project', 'fixture', '--json']).status).toBe(0);
    const hash = createHash('sha256').update(readFileSync(baselinePng)).digest('hex');
    const same = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'layout.journey.yaml')]);
    expect(same.status).toBe(0);
    const sameDiff = diffFor(readRun(), 'layout-check');
    expect(sameDiff?.visual).toBe('same');
    expect(sameDiff?.timing).not.toBe('slower');
    expect(createHash('sha256').update(readFileSync(baselinePng)).digest('hex')).toBe(hash);
    await resetFixture({ layout: 'changed' });
    const changed = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'layout.journey.yaml')]);
    expect(changed.status).toBe(0);
    expect(diffFor(readRun(), 'layout-check')?.visual).toBe('changed');
    expect(createHash('sha256').update(readFileSync(baselinePng)).digest('hex')).toBe(hash);
    await resetFixture({ layout: 'steady', delayMs: 0 });
  });

  it('exports an evidence zip whose hashes match and which has no secret', async () => {
    const run = readRun();
    const destination = join(home, 'evidence-test.zip');
    const exported = hornet(['export-evidence', String(run.result.run_id), '--project', 'fixture', '--out', destination, '--json']);
    expect(exported.status, exported.stdout + exported.stderr).toBe(0);
    const zip = await JSZip.loadAsync(readFileSync(destination));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { files: { path: string; sha256: string }[] };
    for (const file of manifest.files) {
      const data = await zip.file(file.path)!.async('nodebuffer');
      expect(createHash('sha256').update(data).digest('hex')).toBe(file.sha256);
    }
    expect(await containsSecret(latestRun())).toEqual([]);
    const packed = await zip.generateAsync({ type: 'string' });
    expect(packed).not.toContain(secret);
  });

  it('keeps a flaky retry visible as a failure', async () => {
    await resetFixture({ flakyLeft: 1 });
    const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'flaky.journey.yaml')]);
    expect(run.status).toBe(1);
    const report = readRun();
    expect(JSON.stringify(report.result)).toContain('flaky');
    expect(report.summary.toLowerCase()).toContain('failure');
    expect(report.summary).not.toContain(secret);
  });

  it('removes run folders older than the retention window', () => {
    const old = join(home, 'runs/run_old_retention');
    mkdirSync(old, { recursive: true });
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    const removed = cleanupRetention(home, 1);
    expect(removed).toContain('run_old_retention');
  });
});

function chaos(): string[] {
  const run = hornet(['suite', '--project', 'fixture', '--chaos', 'latency', '--seed', 'same-seed', '--json', '--journey', join(journeys, 'chaos.journey.yaml')]);
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const analysis = readRun().analysis as { chaos: { actions: string[] } };
  return analysis.chaos.actions;
}

function diffFor(report: ReturnType<typeof readRun>, id: string): { visual?: string; timing?: string } | undefined {
  const users = report.analysis.users as { journeys: { id: string; steps: { screenshot_paths?: string[]; diff?: { visual?: string; timing?: string } }[] }[] }[];
  return users[0]?.journeys.find((journey) => journey.id === id)?.steps.find((step) => (step.screenshot_paths ?? []).length > 0)?.diff;
}
