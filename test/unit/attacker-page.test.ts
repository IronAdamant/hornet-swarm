import { createServer, request as httpRequest, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EGRESS_HEADER, startControlGateway, startEgressProxy } from '../../packages/controller/src/egress-proxy.ts';
import { controlTokenPath, rotateControlToken } from '../../packages/controller/src/runner-auth.ts';
import { startControlServer } from '../../packages/runner/src/main.ts';
import { folderAt, hasRevision, REPO_ROOT } from '../support/git-history.ts';

const require = createRequire(join(REPO_ROOT, 'packages/runner/package.json'));
const { chromium } = require('playwright') as typeof import('playwright');

const project = 'attack-project';
const label = 'qa-user-1';
const BEFORE_THIS_CHANGE = '5723644';

type Listening = { port: number; close: () => Promise<void> };
type ProxyModule = {
  startEgressProxy: (options: { port: number; allow: string[]; rps: number; log?: (entry: Record<string, unknown>) => void }) => Promise<Listening>;
  startControlGateway: (options: { port: number; project: string; controlDir: string; host: string }) => Promise<Listening>;
};

/** A runner, its relay, and an egress proxy whose allow list opens every loopback port: the worst a project could write. */
async function stack(proxyModule: ProxyModule) {
  const directory = mkdtempSync(join(tmpdir(), 'hornet-attack-'));
  const token = rotateControlToken(project, label, directory);
  const control = await startControlServer({ socketPath: join(directory, `${label}.sock`), tokenFile: controlTokenPath(project, label, directory) });
  const gateway = await proxyModule.startControlGateway({ port: 0, project, controlDir: directory, host: '127.0.0.1' });
  const log: Record<string, unknown>[] = [];
  const proxy = await proxyModule.startEgressProxy({ port: 0, allow: ['127.0.0.1'], rps: 100, log: (entry) => log.push(entry) });
  return {
    token,
    control,
    gateway,
    proxy,
    log,
    close: async () => {
      await proxy.close();
      await gateway.close();
      await control.close();
    },
  };
}

/** Sends one request through the egress proxy the way a page's request leaves the runner. */
function throughProxy(proxyPort: number, url: string, headers: Record<string, string>, method = 'POST', body = '{}'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxyPort, method, path: url, headers: { ...headers, host: new URL(url).host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : body);
  });
}

describe('a hostile page in the runner browser', () => {
  let current: Awaited<ReturnType<typeof stack>>;
  let site: Server;
  let sitePort = 0;
  let browser: import('playwright').Browser;

  beforeAll(async () => {
    current = await stack({ startEgressProxy, startControlGateway });
    site = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>shop</title><p>shop</p>');
    });
    await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
    sitePort = (site.address() as { port: number }).port;
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', `--proxy-server=http://127.0.0.1:${current.proxy.port}`, '--proxy-bypass-list=<-loopback>'],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await new Promise((done) => site?.close(done));
    await current?.close();
  });

  it('cannot drive the runner through the proxy, even knowing the relay port and the run token', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${sitePort}/`);
    const attempts = await page.evaluate(
      async ({ relay, token }) => {
        const outcomes: Record<string, string> = {};
        const attempt = async (name: string, work: () => Promise<Response>) => {
          try {
            outcomes[name] = `status ${(await work()).status}`;
          } catch {
            outcomes[name] = 'refused';
          }
        };
        const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
        await attempt('relay with token', () => fetch(`http://127.0.0.1:${relay}/r/qa-user-1/v1/abort`, { method: 'POST', headers: auth, body: '{}' }));
        await attempt('relay simple post', () => fetch(`http://127.0.0.1:${relay}/r/qa-user-1/v1/abort`, { method: 'POST', mode: 'no-cors', body: '{}' }));
        await attempt('relay secrets', () => fetch(`http://127.0.0.1:${relay}/r/qa-user-1/v1/secrets`, { method: 'POST', mode: 'no-cors', body: '{"credentials":[{"handle":"x","value":"planted"}]}' }));
        await attempt('control port', () => fetch('http://127.0.0.1:8899/r/qa-user-1/v1/abort', { method: 'POST', mode: 'no-cors', body: '{}' }));
        outcomes.websocket = await new Promise<string>((done) => {
          const socket = new WebSocket(`ws://127.0.0.1:${relay}/r/qa-user-1/v1/abort`);
          socket.onopen = () => done('open');
          socket.onerror = () => done('refused');
          setTimeout(() => done('timeout'), 3_000);
        });
        return outcomes;
      },
      { relay: current.gateway.port, token: current.token },
    );
    const navigation = await page.goto(`http://127.0.0.1:${current.gateway.port}/r/qa-user-1/health`).catch(() => null);
    await page.close();

    expect(attempts.websocket).not.toBe('open');
    expect(attempts['relay with token']).toBe('refused');
    expect(navigation?.status() ?? 403).toBe(403);
    expect(current.control.abortRequested()).toBe(false);
    expect(current.control.secretValues()).toEqual([]);
    expect(current.log).toContainEqual(expect.objectContaining({ event: 'deny', port: 8899 }));

    // The relay itself works for the controller, so the refusals above are the isolation, not a broken relay.
    expect(await throughRelay(current.gateway.port, current.token)).toBe(200);
  }, 60_000);

  it('is refused by the relay even with the token, because the proxy marks everything it forwards', async () => {
    const url = `http://127.0.0.1:${current.gateway.port}/r/qa-user-1/v1/abort`;
    expect(await throughProxy(current.proxy.port, url, { authorization: `Bearer ${current.token}`, 'content-type': 'application/json' })).toBe(403);
    expect(await throughProxy(current.proxy.port, 'http://127.0.0.1:8899/r/qa-user-1/v1/abort', {})).toBe(403);
    expect(await throughRelay(current.gateway.port, current.token, { [EGRESS_HEADER]: '1' })).toBe(403);
    expect(current.control.abortRequested()).toBe(false);
  });

  it.skipIf(!hasRevision(BEFORE_THIS_CHANGE))('proof: the proxy and relay before this change let a request carrying the token reach the runner', async () => {
    const past = folderAt(BEFORE_THIS_CHANGE, 'packages/controller/src', join(REPO_ROOT, 'packages/controller'));
    const old = await stack((await import(join(past.path, 'egress-proxy.ts'))) as ProxyModule);
    try {
      const url = `http://127.0.0.1:${old.gateway.port}/r/qa-user-1/v1/abort`;
      expect(await throughProxy(old.proxy.port, url, { authorization: `Bearer ${old.token}`, 'content-type': 'application/json' })).toBe(200);
      expect(old.control.abortRequested()).toBe(true);
    } finally {
      await old.close();
      past.cleanup();
    }
  });
});

function throughRelay(port: number, token: string, extra: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'GET', path: '/r/qa-user-1/health', headers: { authorization: `Bearer ${token}`, ...extra } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
