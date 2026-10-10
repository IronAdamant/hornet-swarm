import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { rescanRun } from '../../packages/controller/dist/index.js';
import { hornet, clearSignins, containsSecret, home, journeys, latestRun, readRun, secret } from './helper.js';

const prefix = 'FixtureOnly-s3cret';

async function prefixHits(dir: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = (current: string): string[] => {
    if (!existsSync(current)) return [];
    return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  };
  for (const file of walk(dir)) {
    const bytes = readFileSync(file);
    if (bytes.toString('latin1').includes(prefix)) hits.push(file);
    if (!file.endsWith('.zip')) continue;
    const zip = await JSZip.loadAsync(bytes);
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (!entry || entry.dir) continue;
      if ((await entry.async('string')).includes(prefix)) hits.push(`${file}!${name}`);
    }
  }
  return hits;
}

beforeAll(() => {
  clearSignins();
});

describe('redaction against the fixture', () => {
  it('removes a seeded secret from the run, including trace and HAR zips', async () => {
    const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'echo-secret.journey.yaml')]);
    expect(run.stdout).not.toContain(secret);
    expect(run.status).toBe(0);
    const dir = latestRun();
    const report = readRun(dir);
    expect(report.result.status).toBe('passed');
    expect(report.result.redaction).toBe('pass');
    expect(await containsSecret(dir)).toEqual([]);
    expect(await prefixHits(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'qa-user-1/echo-secret/console.log'), 'utf8')).toContain('[REDACTED:qa-user-1.password]');
    expect(readFileSync(join(dir, 'qa-user-1/echo-secret/network.har'), 'utf8')).toContain('[REDACTED:qa-user-1.password]');
    expect(report.summary).not.toContain(secret);
    expect(JSON.stringify(report.analysis)).not.toContain(secret);
  });

  it('quarantines a forced leak and audits it without the secret', async () => {
    const dir = latestRun();
    writeFileSync(join(dir, 'planted-leak.txt'), secret);
    const scanned = await rescanRun(dir, 'fixture', home);
    expect(scanned.status).toBe('redaction_failure');
    expect(readFileSync(join(dir, 'run.json'), 'utf8')).toContain('redaction_failure');
    const analysis = readFileSync(join(dir, 'analysis.json'), 'utf8');
    expect(analysis).toContain('"status": "redaction_failure"');
    expect(analysis).toContain('"redaction": "fail"');
    expect(readFileSync(join(dir, 'analysis.md'), 'utf8')).toContain('Selectors:');
    expect(readFileSync(join(dir, 'report.html'), 'utf8')).toContain('Redaction: FAIL');
    expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toContain('hidden');
    expect(readFileSync(join(dir, 'planted-leak.txt.quarantined'), 'utf8')).toContain('quarantined');
    const audit = readFileSync(join(home, 'audit.log'), 'utf8');
    expect(audit).toContain('redaction_failure');
    expect(audit).not.toContain(secret);
    expect(await containsSecret(dir)).toEqual([]);
  });
});
