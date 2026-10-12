import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitControlRequest, wipeSecretStore, type HeaderMap } from './control.js';
import { executeJob, type JobRequest } from './job.js';
import { browserLaunchOptions } from './launch.js';

export type ControlServer = {
  socketPath: string;
  close: () => Promise<void>;
  secretValues: () => string[];
  abortRequested: () => boolean;
};

export function startControlServer(options: { socketPath: string; token: string; tokenFile?: string }): Promise<ControlServer> {
  const secrets = new Map<string, string>();
  let abortRequested = false;
  const tokenFile = options.tokenFile;
  const expectedToken = (): string => {
    if (tokenFile && existsSync(tokenFile)) {
      try {
        const value = readFileSync(tokenFile, 'utf8').trim();
        if (value) return value;
      } catch {
        return '';
      }
    }
    return options.token;
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const decision = admitControlRequest({
      method: req.method ?? 'GET',
      headers: req.headers as HeaderMap,
      expectedToken: expectedToken(),
    });
    if (!decision.ok) {
      send(res, decision.status, { ok: false, error: decision.error });
      return;
    }
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    try {
      if (req.method === 'GET' && path === '/health') {
        send(res, 200, { ok: true, role: 'runner' });
        return;
      }
      if (req.method === 'POST' && path === '/v1/abort') {
        await readJson(req);
        abortRequested = true;
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && path === '/v1/abort-state') {
        send(res, 200, { abortRequested });
        return;
      }
      if (req.method === 'POST' && path === '/v1/secrets') {
        const body = (await readJson(req)) as { credentials?: { handle?: string; value?: string }[] };
        const handles: string[] = [];
        for (const entry of body.credentials ?? []) {
          if (!entry.handle || typeof entry.value !== 'string') continue;
          secrets.set(entry.handle, entry.value);
          handles.push(entry.handle);
          entry.value = '';
        }
        send(res, 200, { ok: true, handles });
        return;
      }
      if (req.method === 'POST' && path === '/v1/jobs') {
        const body = (await readJson(req)) as unknown as JobRequest;
        abortRequested = false;
        let clientGone = false;
        res.on('close', () => {
          if (!res.writableEnded) clientGone = true;
        });
        try {
          const report = await executeJob(body, secrets, () => abortRequested || clientGone);
          if (!res.writableEnded) send(res, 200, report);
        } finally {
          wipeSecretStore(secrets);
        }
        return;
      }
      if (req.method === 'POST' && path === '/v1/probe') {
        const body = await readJson(req);
        const holdMs = Number(body.holdMs ?? 0);
        const result = await probe(Number.isFinite(holdMs) ? holdMs : 0);
        send(res, 200, result);
        return;
      }
      send(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      if (!res.writableEnded) send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  mkdirSync(dirname(options.socketPath), { recursive: true });
  if (existsSync(options.socketPath)) rmSync(options.socketPath);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      chmodSync(options.socketPath, 0o660);
      resolve({
        socketPath: options.socketPath,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => {
              rmSync(options.socketPath, { force: true });
              if (error) fail(error);
              else done();
            });
          }),
        secretValues: () => [...secrets.values()].filter((value) => value.length > 0),
        abortRequested: () => abortRequested,
      });
    });
  });
}

async function probe(holdMs: number): Promise<{ ok: true; launchMs: number }> {
  const { chromium } = await import('playwright');
  const started = Date.now();
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const launchMs = Date.now() - started;
    if (holdMs > 0) await delay(holdMs);
    return { ok: true, launchMs };
  } finally {
    await browser.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const socketPath = process.env.AEGIS_CONTROL_SOCKET ?? '/tmp/hornet-swarm-control.sock';
  const tokenFile = process.env.AEGIS_CONTROL_TOKEN_FILE;
  void startControlServer({ socketPath, token: '', ...(tokenFile ? { tokenFile } : {}) }).then((control) => {
    process.stderr.write(`hornet-swarm-runner listening on ${control.socketPath}\n`);
  });
}
