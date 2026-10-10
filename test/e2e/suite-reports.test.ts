import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analysisSchema } from '../../packages/core/dist/index.js';
import { aegis, clearSignins, readRun, resetFixture, secret } from './helper.js';

const examples = [
  'examples/journeys/consistencyhub/01-signin-dashboard.journey.yaml',
  'examples/journeys/consistencyhub/02-tenant-isolation.journey.yaml',
];

beforeAll(async () => {
  clearSignins();
  await resetFixture();
});

describe('example journeys and reports', () => {
  it('passes sign-in and tenant isolation twice, with both report layers', () => {
    const first = runExamples();
    const second = runExamples();
    for (const report of [first, second]) {
      expect(report.result.status).toBe('passed');
      expect(report.result.gate_passed).toBe(true);
      const users = report.result.users as { phase1: { status: string }; journeys: { id: string; status: string; steps: { assertion?: string; http_status?: number }[] }[] }[];
      expect(users[0]?.phase1.status).toBe('pass');
      const ids = new Set(users[0]?.journeys.map((journey) => journey.id));
      expect(ids.has('signin-dashboard')).toBe(true);
      expect(ids.has('tenant-isolation')).toBe(true);
      expect(users[0]?.journeys.filter((journey) => ids.has(journey.id)).every((journey) => journey.status === 'pass')).toBe(true);
      const isolation = JSON.stringify(users[0]?.journeys.find((journey) => journey.id === 'tenant-isolation'));
      expect(isolation).toContain('access_denied');
      expect(isolation).toContain('403');
      expect(report.summary.split('\n\n')[0]?.split('\n').length).toBe(1);
      expect(report.summary).toContain('Findings:');
      expect(report.summary).not.toContain(secret);
      expect(report.summary).not.toMatch(/run_\d/);
      expect(report.summary).not.toMatch(/at\s+\S+\s+\(/);
      analysisSchema.parse(report.analysis);
      const analysisMd = readFileSync(join(report.dir, 'analysis.md'), 'utf8');
      for (const heading of ['Timings:', 'Selectors:', 'Assertions:', 'Console:', 'Network:', 'Trace:', 'Screenshots:', 'Diff:', 'Confidence:', '## Chaos', '## Reproduction', '## Regressions', '## Next actions']) {
        expect(analysisMd).toContain(heading);
      }
      const junit = readFileSync(join(report.dir, 'junit.xml'), 'utf8');
      expect(junit.startsWith('<?xml')).toBe(true);
      expect(junit).toContain('<testsuite');
      expect(junit).toContain('</testsuites>');
      const html = readFileSync(join(report.dir, 'report.html'), 'utf8');
      expect(html).toContain('Redaction: PASS');
      expect(html).toMatch(/AEDT|AEST/);
      expect(html).toMatch(/2026-\d{2}-\d{2}T/);
    }
  });
});

function runExamples(): ReturnType<typeof readRun> {
  const run = aegis(['suite', '--project', 'fixture', '--json', ...examples.flatMap((file) => ['--journey', file])]);
  expect(run.status, run.stdout + run.stderr).toBe(0);
  return readRun();
}
