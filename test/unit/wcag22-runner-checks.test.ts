import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wcag22PageSignalsSchema } from '../../packages/core/src/index.ts';
import { RedundantEntryTracker, pageKey } from '../../packages/runner/src/redundant-entry-tracker.ts';
import { executeJob, type JobRequest } from '../../packages/runner/src/job.ts';

const require = createRequire(join(import.meta.dirname, '../../packages/runner/package.json'));
require('playwright');

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((path) => existsSync(path));

// A local page with each WCAG 2.2 fault planted, and a clean page to compare it with.
const PAGES: Record<string, string> = {
  '/faults': `<main>
  <h1>Shop</h1>
  <nav><a href="/contact">Contact us</a> <a href="/faq">FAQ</a></nav>
  <p><a href="/a" class="tiny">a</a><a href="/b" class="tiny">b</a></p>
  <div draggable="true" id="reorder">Drag to reorder</div>
  <form autocomplete="off"><label for="pw">Password</label><input type="password" id="pw" onpaste="return false"></form>
  <button id="subscribe" style="position:fixed;bottom:20px;left:20px;z-index:1">Subscribe</button>
  <div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#fff;z-index:5">We use cookies</div>
</main>
<style>.tiny{display:inline-block;width:10px;height:10px;font-size:8px;line-height:10px;margin:0;padding:0}</style>`,
  '/clean': `<main>
  <h1>Account</h1>
  <nav><a href="/faq">FAQ</a> <a href="/contact">Contact us</a></nav>
  <form><label for="pw">Password</label><input type="password" id="pw" autocomplete="current-password"></form>
  <button id="save">Save</button>
</main>
<style>nav a{display:inline-block;padding:8px}</style>`,
  '/delivery': `<main><h1>Delivery</h1><form action="/billing"><label for="postcode">Postcode</label><input id="postcode" name="postcode"><button>Next</button></form></main>`,
  '/billing': `<main><h1>Billing</h1><form><label for="billing-postcode">Billing postcode</label><input id="billing-postcode"><button>Pay</button></form></main>`,
};

let server: Server;
let port = 0;

beforeAll(async () => {
  process.env.AEGIS_HEADLESS = '1';
  if (chrome) process.env.AEGIS_BROWSER = chrome;
  server = createServer((req, res) => {
    const body = PAGES[(req.url ?? '/').split('?')[0] ?? '/'] ?? '<main><h1>Other</h1></main>';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>Fixture</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.AEGIS_HEADLESS;
  delete process.env.AEGIS_BROWSER;
});

function job(steps: JobRequest['steps'], name: string): JobRequest {
  return {
    runId: 'run_wcag22',
    label: 'qa-user-1',
    journeyId: name,
    baseUrl: `http://127.0.0.1:${port}`,
    steps,
    allowOrigins: [`http://127.0.0.1:${port}`],
    authEndpoints: [],
    minStepDelayMs: 0,
    rps: 50,
    burst: 50,
    accessDeniedMarkers: [],
    chaosActions: [],
    outDir: join(mkdtempSync(join(tmpdir(), 'hornet-wcag22-')), name),
    vars: {},
    users: {},
  };
}

describe('the WCAG 2.2 checks in the runner', () => {
  it('finds each planted fault, and nothing on the clean page', async () => {
    const request = job([{ navigate: { url: '/faults' } }, { accessibility: { name: 'faults' } }, { navigate: { url: '/clean' } }, { accessibility: { name: 'clean' } }], 'pages');
    const report = await executeJob(request, new Map(), () => false);
    expect(report.status, JSON.stringify(report.steps.map((step) => step.error))).toBe('passed');
    const faults = report.steps[1]?.accessibility;
    const clean = report.steps[3]?.accessibility;
    expect(faults?.standard).toBe('wcag22aa');
    expect(faults?.violations.find((violation) => violation.rule === 'target-size')?.criteria).toEqual(['2.5.8']);
    const signals = wcag22PageSignalsSchema.parse(faults?.wcag22);
    expect(signals.focus_not_obscured.hidden).toEqual([expect.objectContaining({ target: '#subscribe', covered_by: '#cookie-banner' })]);
    expect(signals.dragging).toEqual([{ target: '#reorder', reason: 'draggable="true"' }]);
    expect(signals.help.map((entry) => entry.kind)).toEqual(['contact', 'faq']);
    expect(signals.authentication).toEqual({ password_fields: 1, paste_blocked: ['#pw'], autocomplete_off: ['#pw'], puzzle: false });

    expect(clean?.violations.map((violation) => violation.rule)).not.toContain('target-size');
    const cleanSignals = wcag22PageSignalsSchema.parse(clean?.wcag22);
    expect(cleanSignals.focus_not_obscured.hidden).toEqual([]);
    expect(cleanSignals.dragging).toEqual([]);
    expect(cleanSignals.help.map((entry) => entry.kind)).toEqual(['faq', 'contact']);
    expect(cleanSignals.authentication).toEqual({ password_fields: 1, paste_blocked: [], autocomplete_off: [], puzzle: false });

    const saved = JSON.parse(readFileSync(join(request.outDir, 'accessibility-faults.json'), 'utf8')) as { standard: string; wcag22: unknown };
    expect(saved.standard).toBe('wcag22aa');
    expect(wcag22PageSignalsSchema.parse(saved.wcag22).authentication.paste_blocked).toEqual(['#pw']);
  }, 60_000);

  it('checks only WCAG 2.1 AA when a journey asks for it', async () => {
    const report = await executeJob(job([{ navigate: { url: '/faults' } }, { accessibility: { name: 'faults', standard: 'wcag21aa' } }], 'older'), new Map(), () => false);
    const result = report.steps[1]?.accessibility;
    expect(result?.violations.map((violation) => violation.rule)).not.toContain('target-size');
    expect(result?.wcag22).toBeUndefined();
  }, 60_000);

  it('notes a value typed again on a later page, keeping no copy of it', async () => {
    const request = job(
      [
        { navigate: { url: '/delivery' } },
        { fill: { selector: '#postcode', value: '2000' } },
        { click: { selector: 'button' } },
        { wait: { for: 'navigation' } },
        { fill: { selector: '#billing-postcode', value: '2000' } },
      ],
      'redundant',
    );
    const report = await executeJob(request, new Map(), () => false);
    expect(report.status, JSON.stringify(report.steps.map((step) => step.error))).toBe('passed');
    expect(report.steps[4]?.redundant_entry).toEqual({ earlier_step: 1, field: '#billing-postcode' });
    expect(JSON.stringify(report)).not.toMatch(/"value":"2000"/);
  }, 60_000);
});

describe('the redundant entry tracker', () => {
  it('ignores short values, the same page, and a field the site filled in', () => {
    const tracker = new RedundantEntryTracker();
    expect(tracker.observe({ step: 0, page: 'p1', field: '#a', value: 'NSW', before: '' })).toBeUndefined();
    expect(tracker.observe({ step: 1, page: 'p1', field: '#b', value: 'NSW', before: '' })).toBeUndefined();
    expect(tracker.observe({ step: 2, page: 'p2', field: '#c', value: 'NSW', before: 'NSW' })).toBeUndefined();
    expect(tracker.observe({ step: 3, page: 'p2', field: '#d', value: 'NSW', before: '' })).toEqual({ earlier_step: 0, field: '#d' });
    expect(tracker.observe({ step: 4, page: 'p3', field: '#e', value: 'ab', before: '' })).toBeUndefined();
    expect(pageKey('http://127.0.0.1:4173/#/checkout?x=1')).toBe('http://127.0.0.1:4173/#/checkout?x=1');
    expect(pageKey('http://127.0.0.1:4173/shop?x=1')).toBe('http://127.0.0.1:4173/shop');
  });
});
