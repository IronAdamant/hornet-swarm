import { describe, expect, it } from 'vitest';
import { analysisMarkdown, buildAnalysis } from '../../packages/report/src/render.ts';
import type { RunResult } from '../../packages/core/src/schemas.ts';

describe('analysis markdown', () => {
  it('includes the same step detail as analysis.json', () => {
    const result: RunResult = {
      schema_version: '1',
      run_id: 'run_20261010-000000_abcdef',
      project: 'fixture',
      started_at: '2026-10-10T10:00:00+11:00',
      finished_at: '2026-10-10T10:00:02+11:00',
      status: 'passed',
      gate: 'all',
      gate_passed: true,
      totals: { users: 1, journeys: 1, steps: 1, passed: 1, failed: 0, skipped: 0 },
      users: [
        {
          label: 'qa-user-1',
          phase1: { status: 'pass', duration_ms: 12 },
          journeys: [{ id: 'flag-check', status: 'pass', duration_ms: 30, steps: [] }],
        },
      ],
      environment: 'test',
      authorisation_id: 'fixture-owner',
      redaction: 'pass',
    };
    const analysis = buildAnalysis({
      result,
      users: [
        {
          label: 'qa-user-1',
          phase1: { status: 'pass', duration_ms: 12 },
          journeys: [
            {
              id: 'flag-check',
              name: 'Ready flag',
              status: 'pass',
              duration_ms: 30,
              steps: [
                {
                  index: 0,
                  type: 'assert',
                  status: 'pass',
                  duration_ms: 30,
                  started_at: '2026-10-10T10:00:00+11:00',
                  finished_at: '2026-10-10T10:00:01+11:00',
                  selector: '#ready',
                  assertion: 'selector_visible',
                  console_logs: ['console ok'],
                  console_error_count: 0,
                  network_errors: [{ method: 'GET', url: 'http://127.0.0.1:4173/flag', status: 200 }],
                  trace_path: '/out/trace.zip',
                  screenshot_paths: ['/out/0.png'],
                  screenshot: '/out/0.png',
                  diff: { visual: 'same', timing: 'same', text: 'same', console: 'same', network: 'same', notes: [] },
                },
              ],
              chaosApplied: ['click:double'],
            },
          ],
        },
      ],
      chaos: { profile: 'default', seed: 'seed-42', actions: ['click:double'] },
      suspected: 'Nothing failed.',
      confidence: 0.9,
      repro: ['Sign in with the test account.'],
      regressions: ['flag-check'],
      next: ['No change is needed.'],
    });
    const markdown = analysisMarkdown(analysis);
    expect(markdown).toContain('Timings: 2026-10-10T10:00:00+11:00');
    expect(markdown).toContain('Selectors: #ready');
    expect(markdown).toContain('Assertions: selector_visible');
    expect(markdown).toContain('Console: console ok');
    expect(markdown).toContain('Network: GET http://127.0.0.1:4173/flag 200');
    expect(markdown).toContain('Trace: /out/trace.zip');
    expect(markdown).toContain('Screenshots: /out/0.png');
    expect(markdown).toContain('Diff: visual same');
    expect(markdown).toContain('Seed: seed-42');
    expect(markdown).toContain('Actions: click:double');
    expect(markdown).toContain('Confidence: 0.9');
    expect(markdown).toContain('Sign in with the test account.');
    expect(markdown).toContain('- flag-check');
    expect(markdown).toContain('No change is needed.');
  });
});
