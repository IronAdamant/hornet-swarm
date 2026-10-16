import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunResult } from '../../packages/core/src/index.ts';
import { checkFindings } from '../../packages/controller/src/findings-report.ts';
import { foldRunStatus, journeyFromJob, vouchedReport, type JobReport } from '../../packages/controller/src/suite.ts';
import { findingsMarkdown, type VerifiedFinding } from '../../packages/report/src/evidence-claims.ts';
import { analysisMarkdown, buildAnalysis, summaryMarkdown, type RichUser } from '../../packages/report/src/render.ts';
import { pageSnapshotText } from '../../packages/runner/src/job.ts';
import { folderAt, hasRevision, REPO_ROOT } from '../support/git-history.ts';

const require = createRequire(join(REPO_ROOT, 'packages/runner/package.json'));
const { chromium } = require('playwright') as typeof import('playwright');

const NOW = '2026-10-14T21:14:36.000Z';
const step = (index: number, status: 'pass' | 'fail' | 'error' | 'skipped', extra: Record<string, unknown> = {}) => ({
  index,
  type: 'assert',
  status,
  duration_ms: 10,
  started_at: NOW,
  finished_at: NOW,
  ...extra,
});

function runResult(runId: string, checkoutStatus: 'pass' | 'fail', extra: Record<string, unknown> = {}): RunResult {
  const steps = [step(0, 'pass'), step(1, 'pass'), step(2, 'pass'), step(3, 'pass'), step(4, checkoutStatus, extra)];
  return {
    schema_version: '1',
    run_id: runId,
    project: 'toolshop',
    started_at: NOW,
    finished_at: NOW,
    status: checkoutStatus === 'pass' ? 'passed' : 'failed',
    gate: 'all',
    gate_passed: true,
    totals: { users: 1, journeys: 1, steps: 5, passed: checkoutStatus === 'pass' ? 5 : 4, failed: checkoutStatus === 'pass' ? 0 : 1, skipped: 0 },
    users: [{ label: 'qa-user-1', phase1: { status: 'pass', duration_ms: 10 }, journeys: [{ id: 'checkout', status: checkoutStatus, duration_ms: 50, steps }] }],
    environment: 'test',
    authorisation_id: 'toolshop-owner',
    redaction: 'pass',
  };
}

describe('report findings must point at saved evidence', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-findings-'));
  const failedRun = 'run_20261014-211436_0139bb';
  let snapshot = '';

  beforeAll(async () => {
    // The page the 6550f54 report misread: a misspelled option in the payment dropdown.
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(`<h1>Checkout</h1>
      <label for="pay">Payment method</label>
      <select id="pay"><option>Bank Transfer</option><option>Cash on Delivery</option><option>Errror 304 - Missing Payment Gateway</option></select>
      <button disabled>Confirm</button>`);
    snapshot = await pageSnapshotText(page);
    await browser.close();

    const save = (runId: string, result: RunResult) => {
      mkdirSync(join(home, 'runs', runId, 'qa-user-1', 'checkout'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'runs', runId, 'run.json'), JSON.stringify(result));
    };
    save(failedRun, runResult(failedRun, 'fail', { error: "expected text 'Order confirmed' (the page said: \"Confirm is disabled\")" }));
    writeFileSync(join(home, 'runs', failedRun, 'qa-user-1', 'checkout', 'failed-step-4.txt'), snapshot);
    writeFileSync(join(home, 'runs', failedRun, 'qa-user-1', 'checkout', 'failed-step-4.png'), 'png');
    save('run_20261015-090000_aaaaaa', runResult('run_20261015-090000_aaaaaa', 'pass'));
    save('run_20261015-100000_bbbbbb', runResult('run_20261015-100000_bbbbbb', 'pass'));
    const other = runResult('run_20261015-110000_cccccc', 'fail');
    save('run_20261015-110000_cccccc', { ...other, project: 'parabank' });
  }, 60_000);

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const finding = (evidence: unknown[], extra: Record<string, unknown> = {}) => ({
    project: 'toolshop',
    findings: [{ id: 'F-01', severity: 'High', title: 'Checkout cannot be confirmed', claim: 'Confirm stays disabled after choosing Bank Transfer.', evidence, ...extra }],
  });
  const failedStep = { kind: 'step', run: failedRun, label: 'qa-user-1', journey: 'checkout', step: 4, status: 'fail' };

  it('renders a finding whose evidence is in the run, and says how often it happened across every saved run', () => {
    const result = checkFindings(
      finding([failedStep, { kind: 'quote', run: failedRun, label: 'qa-user-1', journey: 'checkout', step: 4, text: 'Bank Transfer' }, { kind: 'file', run: failedRun, path: 'qa-user-1/checkout/failed-step-4.png' }]),
      { home },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain('## F-01 · High · Checkout cannot be confirmed');
    expect(result.markdown).toContain('qa-user-1 · checkout · step 4: fail in 1 of 3 saved runs that reached it.');
  });

  it('refuses a step cited with a status its run did not record (6fd08df: a failure that later runs did not repeat)', () => {
    const result = checkFindings(finding([{ ...failedStep, run: 'run_20261015-090000_aaaaaa' }]), { home });
    expect(result).toEqual({ ok: false, problems: ['F-01: run_20261015-090000_aaaaaa recorded qa-user-1 · checkout · step 4 as pass, not fail.'] });
  });

  it('refuses a finding no saved run records (d391eab: a username cutoff checked by hand)', () => {
    expect(checkFindings(finding([]), { home }).ok).toBe(false);
    const unrecorded = checkFindings(finding([{ kind: 'step', run: failedRun, label: 'qa-user-1', journey: 'username-length', step: 0, status: 'fail' }]), { home });
    expect(unrecorded).toEqual({ ok: false, problems: [`F-01: ${failedRun} did not run username-length for qa-user-1.`] });
  });

  it('refuses a quote of a dropdown option the page never showed as a message (6550f54)', () => {
    expect(snapshot).not.toContain('Errror 304');
    const result = checkFindings(finding([failedStep, { kind: 'quote', run: failedRun, label: 'qa-user-1', journey: 'checkout', step: 4, text: 'Errror 304 - Missing Payment Gateway' }]), { home });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toContain('saved no page text or error');
  });

  it('takes severity from the one shared scale only (722e1a0)', () => {
    const result = checkFindings(finding([failedStep], { severity: 'Critical' }), { home });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/^findings\.0\.severity: Invalid enum value\. Expected 'High' \| 'Medium' \| 'Low'/);
  });

  it('refuses another project\'s run, a missing file, and a path outside the run', () => {
    const result = checkFindings(
      finding([
        { ...failedStep, run: 'run_20261015-110000_cccccc' },
        { kind: 'file', run: failedRun, path: 'qa-user-1/checkout/trace.zip' },
      ]),
      { home },
    );
    expect(result).toEqual({
      ok: false,
      problems: ['F-01: run_20261015-110000_cccccc is not a saved run of toolshop.', `F-01: ${failedRun} has no file qa-user-1/checkout/trace.zip.`],
    });
    expect(checkFindings(finding([{ kind: 'file', run: failedRun, path: '../../age.key' }]), { home }).ok).toBe(false);
  });

  it('renders nothing that did not come from the checker', () => {
    const forged = { finding: { id: 'F-09', severity: 'High', title: 't', claim: 'c', evidence: [] }, reproduction: [] } as unknown as VerifiedFinding;
    expect(() => findingsMarkdown([forged])).toThrow('Only findings from verifyFindings can be rendered.');
  });
});

describe('a pass needs every step recorded', () => {
  const sent = 3;
  const passed = (steps: ReturnType<typeof step>[]): JobReport => ({ ok: true, status: 'passed', steps, chaosApplied: [] }) as JobReport;

  it('keeps a pass that recorded every step', () => {
    const report = passed([step(0, 'pass'), step(1, 'skipped'), step(2, 'pass')]);
    expect(vouchedReport(report, sent)).toBe(report);
  });

  it('turns a pass with missing or failed steps into a harness error, so the run is not reported as passed', () => {
    for (const report of [passed([step(0, 'pass'), step(1, 'pass')]), passed([step(0, 'pass'), step(1, 'fail'), step(2, 'pass')]), passed([])]) {
      const vouched = vouchedReport(report, sent);
      expect(vouched.status).toBe('error');
      expect(vouched.steps.at(-1)?.error).toMatch(/^The runner reported a pass but recorded/);
      const journey = journeyFromJob(vouched, { id: 'checkout', name: 'Checkout', tries: 0 });
      expect(foldRunStatus({ killed: false, gatePassed: true, users: [{ phase1: { status: 'pass' }, journeys: [journey] }] })).toBe('error');
    }
  });
});

// Every claim a generated summary makes must follow from the step evidence it was given.
function summaryOverclaims(summary: string, users: RichUser[], status: RunResult['status']): string[] {
  const problems: string[] = [];
  const failedAccessCheck = users.some((user) =>
    user.journeys.some((journey) => journey.steps.some((entry) => entry.status === 'fail' && /^(access_denied\b|http_status (401|403)\b)/.test(entry.assertion ?? ''))),
  );
  if (/another account/.test(summary) && !failedAccessCheck) problems.push('claims a cross-account breach with no failed access check');
  const journeys = users.flatMap((user) => user.journeys);
  const allPassed = journeys.every((journey) => journey.status === 'pass');
  if (/later checks passed|checks that followed passed|Nothing needs fixing/.test(summary) && !(status === 'passed' && allPassed)) problems.push('claims the checks passed when one did not');
  return problems;
}

const userWith = (label: string, journeys: RichUser['journeys']): RichUser => ({ label, phase1: { status: 'pass', duration_ms: 10 }, journeys });
const positiveControlFailed = [
  userWith('qa-user-1', [
    { id: 'cross-tenant', name: 'Access denied to another tenant', status: 'fail', duration_ms: 20, steps: [step(0, 'fail', { assertion: 'url_contains /orders/mine' })] },
  ]),
];
const oneOfTwoPassed = [
  userWith('qa-user-1', [{ id: 'cart', name: 'Cart', status: 'pass', duration_ms: 20, steps: [step(0, 'pass')] }]),
  userWith('qa-user-2', [{ id: 'checkout', name: 'Checkout', status: 'fail', duration_ms: 20, steps: [step(0, 'fail', { assertion: 'text_visible Order confirmed' })] }]),
];

describe('generated summaries claim only what the steps show', () => {
  it('holds for today\'s summary', () => {
    expect(summaryOverclaims(summaryMarkdown(positiveControlFailed, 'failed'), positiveControlFailed, 'failed')).toEqual([]);
    expect(summaryOverclaims(summaryMarkdown(oneOfTwoPassed, 'failed'), oneOfTwoPassed, 'failed')).toEqual([]);
  });

  it.runIf(hasRevision('6184a74'))('proof: the summary before 6184a74 claimed a breach from a journey name, and a pass when one journey failed', async () => {
    const past = folderAt('6184a74^', 'packages/report/src', join(REPO_ROOT, 'packages/report'));
    try {
      const old = (await import(join(past.path, 'render.ts'))) as { summaryMarkdown: (users: RichUser[], status: RunResult['status']) => string };
      expect(summaryOverclaims(old.summaryMarkdown(positiveControlFailed, 'failed'), positiveControlFailed, 'failed')).toContain('claims a cross-account breach with no failed access check');
      expect(summaryOverclaims(old.summaryMarkdown(oneOfTwoPassed, 'failed'), oneOfTwoPassed, 'failed')).toContain('claims the checks passed when one did not');
    } finally {
      past.cleanup();
    }
  });

  it.runIf(hasRevision('c8963cf'))('proof: the analysis before c8963cf called a failed run\'s gate "passed" with no caveat', async () => {
    const result = { ...runResult('run_20261015-090000_aaaaaa', 'fail'), users: [] };
    const analysis = buildAnalysis({ result, users: oneOfTwoPassed, chaos: null, suspected: 's', confidence: 0.8, repro: [], regressions: [], next: [] });
    const caveat = 'This says nothing about the journeys';
    expect(analysisMarkdown(analysis)).toContain(caveat);
    const past = folderAt('c8963cf^', 'packages/report/src', join(REPO_ROOT, 'packages/report'));
    try {
      const old = (await import(join(past.path, 'render.ts'))) as { analysisMarkdown: typeof analysisMarkdown };
      const text = old.analysisMarkdown(analysis);
      expect(text).toContain('Gate: all (passed)');
      expect(text).not.toContain(caveat);
    } finally {
      past.cleanup();
    }
  });
});
