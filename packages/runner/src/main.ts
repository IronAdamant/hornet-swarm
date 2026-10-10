import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { executeJob, type JobRequest } from './job.js';
import { browserLaunchOptions } from './launch.js';

const port = Number(process.env.AEGIS_PORT ?? 8787);
let abortRequested = false;
const secrets = new Map<string, string>();

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(port, '0.0.0.0', () => {
  process.stderr.write(`hornet-swarm-runner listening on ${port}\n`);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      send(res, 200, { ok: true, role: 'runner' });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/abort') {
      abortRequested = true;
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/abort-state') {
      send(res, 200, { abortRequested });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/secrets') {
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
    if (req.method === 'POST' && req.url === '/v1/jobs') {
      const body = (await readJson(req)) as unknown as JobRequest;
      abortRequested = false;
      let clientGone = false;
      res.on('close', () => {
        if (!res.writableEnded) clientGone = true;
      });
      const report = await executeJob(body, secrets, () => abortRequested || clientGone);
      if (!res.writableEnded) send(res, 200, report);
      return;
    }
    if (req.method === 'POST' && (req.url === '/v1/probe' || req.url?.startsWith('/v1/probe?'))) {
      const body = await readJson(req);
      const holdMs = Number(body.holdMs ?? 0);
      const result = await probe(Number.isFinite(holdMs) ? holdMs : 0);
      send(res, 200, result);
      return;
    }
    send(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function probe(holdMs: number): Promise<{ ok: true; launchMs: number }> {
  const { chromium } = await import('playwright');
  const started = Date.now();
  const browser = await chromium.launch(browserLaunchOptions);
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
