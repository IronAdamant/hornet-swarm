import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeJob, type JobRequest } from '../../packages/runner/src/job.ts';

const require = createRequire(join(import.meta.dirname, '../../packages/runner/package.json'));
const { chromium } = require('playwright') as typeof import('playwright');

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((path) =>
  existsSync(path),
);

// One server answers on two origins: 127.0.0.1 is the site, localhost stands in for a passive CDN.
let server: Server;
let port = 0;
const seen: string[] = [];

beforeAll(async () => {
  process.env.AEGIS_HEADLESS = '1';
  if (chrome) process.env.AEGIS_BROWSER = chrome;
  server = createServer((req, res) => {
    seen.push(`${req.headers.host}${req.url}`);
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body>${body}</body></html>`);
    };
    if (req.url === '/') {
      html(`<a id="away" href="http://localhost:${port}/away">away</a>
<p id="sw">sw-pending</p>
<script>
  navigator.serviceWorker.register('/sw.js').then(() => { document.getElementById('sw').textContent = 'sw-registered'; }, () => { document.getElementById('sw').textContent = 'sw-refused'; });
</script>`);
      return;
    }
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end("self.addEventListener('fetch', () => undefined);");
      return;
    }
    if (req.url === '/script-away') {
      html(`<p>leaving</p><script>setTimeout(() => { location.href = 'http://localhost:${port}/away'; }, 50);</script>`);
      return;
    }
    if (req.url === '/upload') {
      html('<input id="file" type="file"><p id="chosen"></p><script>const input = document.getElementById("file"); input.onchange = () => { document.getElementById("chosen").textContent = input.files[0].name; };</script>');
      return;
    }
    if (req.url === '/img') {
      html(`<p>Products page</p><img id="pixel" src="http://localhost:${port}/pixel.svg">`);
      return;
    }
    if (req.url === '/pixel.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }
    html('<h1>AWAY PAGE</h1>');
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
    runId: 'run_passive',
    label: 'qa-user-1',
    journeyId: name,
    baseUrl: `http://127.0.0.1:${port}`,
    steps,
    allowOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    passiveOrigins: [`http://localhost:${port}`],
    authEndpoints: [],
    minStepDelayMs: 0,
    rps: 50,
    burst: 50,
    accessDeniedMarkers: [],
    chaosActions: [],
    outDir: join(mkdtempSync(join(tmpdir(), 'hornet-passive-')), name),
    vars: {},
    users: {},
  };
}

const awayRequests = () => seen.filter((entry) => entry.endsWith('/away')).length;

describe('runner enforcement of passive origins and service workers', () => {
  it('blocks service workers, and saves the page text beside a screenshot', async () => {
    const request = job([{ navigate: { url: '/' } }, { wait: { for: 'timeout', ms: 800 } }, { screenshot: { name: 'home' } }], 'sw');
    const report = await executeJob(request, new Map(), () => false);
    expect(report.status, JSON.stringify(report.steps.map((step) => step.error))).toBe('passed');
    // The worker script is never fetched, so its requests can never skip the allowlist or the pacing.
    expect(seen.some((entry) => entry.endsWith('/sw.js'))).toBe(false);
    expect(readFileSync(join(request.outDir, 'home.txt'), 'utf8')).toContain('away');
    // Control: the same page in a browser that allows workers does fetch the script.
    const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForTimeout(800);
      expect(seen.some((entry) => entry.endsWith('/sw.js'))).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('never lets a click, a script, or a navigate step move the page to a passive origin', async () => {
    const before = awayRequests();
    // The browser shows its own "blocked" page instead. Nothing reaches the passive origin, and nothing can be typed there.
    const typeThere = { fill: { selector: 'body', value: 'typed' } } as const;
    const clicked = await executeJob(job([{ navigate: { url: '/' } }, { click: { selector: '#away' } }, { wait: { for: 'timeout', ms: 500 } }, typeThere], 'click'), new Map(), () => false);
    expect(clicked.status).toBe('blocked');
    expect(clicked.blocked_reason).toBe('allowlist');
    expect(clicked.steps.map((step) => step.status)).toEqual(['pass', 'blocked']);
    expect(clicked.steps.at(-1)?.error).toContain(`passive origin http://localhost:${port}`);
    const scripted = await executeJob(job([{ navigate: { url: '/script-away' } }, { wait: { for: 'timeout', ms: 500 } }, typeThere], 'script'), new Map(), () => false);
    expect(scripted.status).toBe('blocked');
    expect(scripted.blocked_reason).toBe('allowlist');
    expect(scripted.steps.at(-1)?.error).toContain('passive origin');
    const stepped = await executeJob(job([{ navigate: { url: `http://localhost:${port}/away` } }], 'step'), new Map(), () => false);
    expect(stepped.status).toBe('blocked');
    expect(stepped.blocked_reason).toBe('allowlist');
    expect(awayRequests()).toBe(before);
  }, 90_000);

  it('attaches a fixture the image ships, and names one it does not', async () => {
    process.env.AEGIS_FIXTURES_DIR = join(import.meta.dirname, '../../images/runner/fixtures');
    try {
      const shipped = await executeJob(job([{ navigate: { url: '/upload' } }, { upload: { selector: '#file', fixture: 'sample.pdf' } }, { assert: { type: 'text_visible', value: 'sample.pdf' } }], 'upload'), new Map(), () => false);
      expect(shipped.status, JSON.stringify(shipped.steps.map((step) => step.error))).toBe('passed');
      const missing = await executeJob(job([{ navigate: { url: '/upload' } }, { upload: { selector: '#file', fixture: 'absent.bin' } }], 'upload-missing'), new Map(), () => false);
      expect(missing.status).toBe('failed');
      expect(missing.steps.at(-1)?.error).toContain('absent.bin is not in the runner image');
    } finally {
      delete process.env.AEGIS_FIXTURES_DIR;
    }
  }, 60_000);

  it('still loads a passive origin into the page', async () => {
    const report = await executeJob(job([{ navigate: { url: '/img' } }, { wait: { for: 'timeout', ms: 300 } }], 'img'), new Map(), () => false);
    expect(report.status).toBe('passed');
    expect(seen).toContain(`localhost:${port}/pixel.svg`);
  }, 60_000);
});
