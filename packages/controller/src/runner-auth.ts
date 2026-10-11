import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { aegisHome, ensureDir } from './home.js';

export function controlTokenDir(project: string, home = aegisHome()): string {
  return join(home, 'control', project);
}

export function controlTokenPath(project: string, label: string, home = aegisHome()): string {
  return join(controlTokenDir(project, home), `${label}.token`);
}

export function ensureControlToken(project: string, label: string, home = aegisHome()): string {
  const file = controlTokenPath(project, label, home);
  ensureDir(controlTokenDir(project, home));
  chmodSync(controlTokenDir(project, home), 0o755);
  if (!existsSync(file)) return rotateControlToken(project, label, home);
  return readFileSync(file, 'utf8').trim();
}

export function rotateControlToken(project: string, label: string, home = aegisHome()): string {
  const directory = controlTokenDir(project, home);
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o755);
  const token = randomBytes(32).toString('hex');
  const file = join(directory, `${label}.token`);
  writeFileSync(file, `${token}\n`, { mode: 0o644 });
  chmodSync(file, 0o644);
  return token;
}

export function readControlToken(project: string, label: string, home = aegisHome()): string {
  try {
    return readFileSync(controlTokenPath(project, label, home), 'utf8').trim();
  } catch {
    return '';
  }
}

export function controlHeaders(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

export function labelFromEndpoint(endpoint: string): string | undefined {
  const match = /\/r\/([a-z0-9-]+)\/?$/.exec(endpoint);
  return match?.[1];
}

export async function runnerFetch(
  project: string,
  endpoint: string,
  path: string,
  init: { method: string; body?: string; signal?: AbortSignal },
  home = aegisHome(),
  label?: string,
): Promise<Response> {
  const resolved = label ?? labelFromEndpoint(endpoint);
  if (!resolved) throw new Error('Runner endpoint is missing a label.');
  const token = readControlToken(project, resolved, home);
  const url = new URL(`${endpoint}${path}`);
  const payload = init.body;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers: controlHeaders(token),
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve(new Response(body, { status: res.statusCode ?? 500, headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') } }));
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.end(payload);
    else req.end();
  });
}
