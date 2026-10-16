import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startControlGateway } from '../../packages/controller/src/egress-proxy.ts';
import { controlTokenPath, rotateControlToken } from '../../packages/controller/src/runner-auth.ts';
import { browserLaunchOptions } from '../../packages/runner/src/launch.ts';
import { startControlServer, type ControlServer } from '../../packages/runner/src/main.ts';

const require = createRequire(join(import.meta.dirname, '../../packages/runner/package.json'));
const { chromium } = require('playwright') as typeof import('playwright');

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((path) =>
  existsSync(path),
);
const password = 'stored-password-9f3a';
const directory = mkdtempSync(join(tmpdir(), 'hornet-control-'));
const socketPath = join(directory, 'qa-user-1.sock');
const tokenFile = controlTokenPath('socket-project', 'qa-user-1', directory);

let control: ControlServer;
let gateway: { port: number; close: () => Promise<void> };
let browser: import('playwright').Browser;

beforeAll(async () => {
  process.env.AEGIS_HEADLESS = '1';
  if (chrome) process.env.AEGIS_BROWSER = chrome;
  rotateControlToken('socket-project', 'qa-user-1', directory);
  control = await startControlServer({ socketPath, tokenFile });
  gateway = await startControlGateway({ port: 0, project: 'socket-project', controlDir: directory });
  browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}), args: ['--no-sandbox'] });
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await gateway?.close().catch(() => undefined);
  await control?.close().catch(() => undefined);
  delete process.env.AEGIS_HEADLESS;
  delete process.env.AEGIS_BROWSER;
});

describe('runner control API', () => {
  it('refuses a page inside the browser, a bad token, browser headers, and a non-JSON body', async () => {
    const page = await browser.newPage();
    try {
      const fromPage = await page.evaluate(async () => {
        const paths = ['/health', '/v1/abort', '/v1/abort-state', '/v1/secrets', '/v1/jobs', '/v1/probe'];
        const results: Array<{ path: string; reached: boolean }> = [];
        for (const path of paths) {
          try {
            await fetch(`http://127.0.0.1:8787${path}`, { method: path === '/health' || path === '/v1/abort-state' ? 'GET' : 'POST' });
            results.push({ path, reached: true });
          } catch {
            results.push({ path, reached: false });
          }
        }
        let navigated: boolean;
        try {
          await fetch('http://127.0.0.1:8787/v1/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runId: 'from-page' }),
          });
          navigated = true;
        } catch {
          navigated = false;
        }
        return { results, navigated };
      });
      expect(fromPage.results.every((entry) => entry.reached === false)).toBe(true);
      expect(fromPage.navigated).toBe(false);
      await expect(page.goto('http://127.0.0.1:8787/v1/secrets', { timeout: 3_000 })).rejects.toThrow();
    } finally {
      await page.close();
    }

    const tcpOpen = await tcpListening(8787);
    expect(tcpOpen).toBe(false);
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    expect(control.secretValues()).toEqual([]);
    expect(control.abortRequested()).toBe(false);

    const token = rotateControlToken('socket-project', 'qa-user-1', directory);
    const stored = await ask(socketPath, 'POST', '/v1/secrets', token, JSON.stringify({ credentials: [{ handle: 'qa-user-1.password', value: password }] }));
    expect(stored.status).toBe(200);
    expect(control.secretValues()).toEqual([password]);

    const missing = await ask(socketPath, 'POST', '/v1/abort', '', '{}');
    expect(missing.status).toBe(401);
    expect(control.abortRequested()).toBe(false);
    const wrong = await ask(socketPath, 'POST', '/v1/abort', 'not-the-token', '{}');
    expect(wrong.status).toBe(401);
    expect(control.abortRequested()).toBe(false);
    const origin = await ask(socketPath, 'POST', '/v1/secrets', token, JSON.stringify({ credentials: [{ handle: 'other', value: 'nope' }] }), {
      origin: 'http://evil.example',
    });
    expect(origin.status).toBe(403);
    const fetched = await ask(socketPath, 'POST', '/v1/abort', token, '{}', { 'sec-fetch-site': 'cross-site' });
    expect(fetched.status).toBe(403);
    const referer = await ask(socketPath, 'GET', '/health', token, undefined, { referer: 'http://evil.example/login' });
    expect(referer.status).toBe(403);
    const text = await ask(socketPath, 'POST', '/v1/secrets', token, 'password=plain', {}, 'text/plain');
    expect(text.status).toBe(415);
    expect(control.secretValues()).toEqual([password]);
    expect(control.abortRequested()).toBe(false);

    const health = await ask(socketPath, 'GET', '/health', token);
    expect(health.status).toBe(200);
    expect(health.body).toContain('"ok":true');

    const viaGateway = await gatewayAsk(gateway.port, 'GET', '/r/qa-user-1/health', { authorization: `Bearer ${token}`, 'content-type': 'application/json' });
    expect(viaGateway.status).toBe(200);
    const gatewayBrowser = await gatewayAsk(gateway.port, 'POST', '/r/qa-user-1/v1/abort', {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: 'http://evil.example',
    }, '{}');
    expect(gatewayBrowser.status).toBe(403);
    expect(control.abortRequested()).toBe(false);

    const outDir = join(directory, 'out');
    const job = await ask(
      socketPath,
      'POST',
      '/v1/jobs',
      token,
      JSON.stringify({
        runId: 'control-job',
        label: 'qa-user-1',
        journeyId: 'control',
        baseUrl: 'about:blank',
        steps: [],
        allowOrigins: ['about:blank'],
        authEndpoints: [],
        minStepDelayMs: 0,
        rps: 20,
        accessDeniedMarkers: [],
        chaosActions: [],
        outDir,
        vars: {},
        users: {},
      }),
    );
    expect(job.status).toBe(200);
    expect(job.body).toContain('"status":"passed"');
    expect(job.body).not.toContain(password);
    expect(control.secretValues()).toEqual([]);
  }, 120_000);

  it('launches the container browser through the unprivileged wrapper', () => {
    const previousBrowser = process.env.AEGIS_BROWSER;
    const previousUser = process.env.AEGIS_BROWSER_USER;
    const previousLaunch = process.env.AEGIS_BROWSER_LAUNCH;
    delete process.env.AEGIS_BROWSER;
    process.env.AEGIS_BROWSER_USER = 'browser';
    process.env.AEGIS_BROWSER_LAUNCH = '/opt/runner/browser-launch';
    try {
      expect(browserLaunchOptions().executablePath).toBe('/opt/runner/browser-launch');
      process.env.AEGIS_BROWSER = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      expect(browserLaunchOptions().executablePath).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } finally {
      if (previousBrowser === undefined) delete process.env.AEGIS_BROWSER;
      else process.env.AEGIS_BROWSER = previousBrowser;
      if (previousUser === undefined) delete process.env.AEGIS_BROWSER_USER;
      else process.env.AEGIS_BROWSER_USER = previousUser;
      if (previousLaunch === undefined) delete process.env.AEGIS_BROWSER_LAUNCH;
      else process.env.AEGIS_BROWSER_LAUNCH = previousLaunch;
    }
  });

  it('rejects the previous run token after the controller rotates it', async () => {
    const first = rotateControlToken('socket-project', 'qa-user-1', directory);
    const accepted = await ask(socketPath, 'GET', '/health', first);
    expect(accepted.status).toBe(200);
    const second = rotateControlToken('socket-project', 'qa-user-1', directory);
    const stale = await ask(socketPath, 'POST', '/v1/abort', first, '{}');
    expect(stale.status).toBe(401);
    expect(control.abortRequested()).toBe(false);
    const current = await ask(socketPath, 'GET', '/v1/abort-state', second);
    expect(current.status).toBe(200);
    expect(current.body).toContain('"abortRequested":false');
  });
});

function ask(
  socketPath: string,
  method: string,
  path: string,
  token: string,
  body?: string,
  extra: Record<string, string> = {},
  contentType = 'application/json',
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET') headers['content-type'] = contentType;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function gatewayAsk(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function tcpListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
