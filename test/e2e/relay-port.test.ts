import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { readControlToken, runnerFetch } from '../../packages/controller/src/runner-auth.ts';
import { hornet } from './helper.js';

const project = 'relayproof';
const runner = 'hornet-swarm-relayproof-qa-user-1';
const proxy = 'hornet-swarm-proxy-relayproof';

describe('proxy relay port', () => {
  afterAll(() => {
    docker(['rm', '-f', runner, proxy]);
  });

  it('keeps port 8899 closed to the browser and open to the host controller', async () => {
    const up = hornet(['env', 'up', '--project', project, '--count', '1', '--json'], undefined, 180_000);
    expect(up.status, up.stdout + up.stderr).toBe(0);
    const status = JSON.parse(up.stdout) as { runners: { endpoint: string | null; health: string }[] };
    const endpoint = status.runners[0]?.endpoint ?? '';
    expect(status.runners[0]?.health).toBe('healthy');

    const closed = docker(['exec', '-u', '10002:10002', runner, 'node', '-e', tcpScript(proxy, 8899)]);
    expect(closed.status, closed.stdout + closed.stderr).toBe(0);
    expect(closed.stdout.trim()).not.toBe('TCP_OK');

    const egress = docker(['exec', '-u', '10002:10002', runner, 'node', '-e', tcpScript(proxy, 8888)]);
    expect(egress.status, egress.stdout + egress.stderr).toBe(0);
    expect(egress.stdout.trim()).toBe('TCP_OK');

    const before = await runnerFetch(project, endpoint, '/v1/abort-state', { method: 'GET', signal: AbortSignal.timeout(10_000) });
    expect(before.status).toBe(200);
    expect(await before.text()).toContain('"abortRequested":false');

    const page = docker(
      [
        'exec',
        '-w',
        '/opt/runner',
        '-e',
        `RELAY_URL=http://${proxy}:8899/r/qa-user-1/v1/jobs`,
        runner,
        'setpriv',
        '--reuid=10001',
        '--regid=10010',
        '--clear-groups',
        '--inh-caps=+setuid,+setgid,+setpcap',
        '--ambient-caps=+setuid,+setgid,+setpcap',
        '--',
        'node',
        '--input-type=module',
        '-e',
        pageScript(),
      ],
      90_000,
    );
    expect(page.status, page.stdout + page.stderr).toBe(0);
    expect(page.stdout).toContain('NET_FAIL:net::ERR_');
    expect(page.stdout).not.toContain('HTTP_RESPONSE:2');
    expect(page.stdout).not.toContain('HTTP_RESPONSE:4');
    expect(page.stdout).toContain('HTTP_RESPONSE:');

    const after = await runnerFetch(project, endpoint, '/v1/abort-state', { method: 'GET', signal: AbortSignal.timeout(10_000) });
    expect(await after.text()).toContain('"abortRequested":false');

    const wrong = await relayAsk(endpoint, 'POST', '/v1/abort', { authorization: 'Bearer not-the-token', 'content-type': 'application/json' }, '{}');
    expect(wrong.status).toBe(401);
    const browserHeader = await relayAsk(
      endpoint,
      'POST',
      '/v1/abort',
      { authorization: `Bearer ${readControlToken(project, 'qa-user-1')}`, 'content-type': 'application/json', origin: 'http://evil.example' },
      '{}',
    );
    expect(browserHeader.status).toBe(403);

    const job = await runnerFetch(project, endpoint, '/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({
        runId: 'relay-proof',
        label: 'qa-user-1',
        journeyId: 'relay-proof',
        baseUrl: 'about:blank',
        steps: [],
        allowOrigins: ['about:blank'],
        authEndpoints: [],
        minStepDelayMs: 0,
        rps: 20,
        accessDeniedMarkers: [],
        chaosActions: [],
        outDir: '/out',
        vars: {},
        users: {},
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const jobText = await job.text();
    expect(job.status, jobText).toBe(200);
    expect(jobText).toContain('"status":"passed"');
  }, 180_000);
});

function tcpScript(host: string, port: number): string {
  return `
    const net = require('net');
    const socket = net.connect(${port}, ${JSON.stringify(host)});
    socket.on('connect', () => { console.log('TCP_OK'); socket.destroy(); process.exit(0); });
    socket.on('error', (error) => { console.log('TCP_' + error.code); process.exit(0); });
    setTimeout(() => { console.log('TCP_TIMEOUT'); process.exit(0); }, 4000);
  `;
}

function pageScript(): string {
  return `
    import { chromium } from 'playwright';
    const target = process.env.RELAY_URL;
    const browser = await chromium.launch({
      executablePath: process.env.AEGIS_BROWSER_LAUNCH,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    let failed = '';
    let status = '';
    page.on('requestfailed', (request) => {
      if (request.url().includes(':8899')) failed = request.failure()?.errorText ?? 'failed';
    });
    page.on('response', (response) => {
      if (response.url().includes(':8899')) status = String(response.status());
    });
    await page.goto('about:blank');
    await page.evaluate(async (url) => {
      try {
        await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      } catch {
        // The browser reports the network failure on the request.
      }
    }, target);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log('NET_FAIL:' + failed);
    console.log('HTTP_RESPONSE:' + status);
    await browser.close();
  `;
}

function relayAsk(endpoint: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  const url = new URL(`${endpoint}${path}`);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function docker(args: string[], timeout = 30_000): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('docker', args, { encoding: 'utf8', timeout });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return { status: failed.status ?? 1, stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? '') };
  }
}
