import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { aegisHome } from './home.js';

export function controlTokenDir(project: string, home = aegisHome()): string {
  return join(home, 'control', project);
}

export function controlTokenPath(project: string, label: string, home = aegisHome()): string {
  return join(controlTokenDir(project, home), `${label}.token`);
}

export function ensureControlToken(project: string, label: string, home = aegisHome()): string {
  const directory = controlTokenDir(project, home);
  const file = controlTokenPath(project, label, home);
  if (!existsSync(file)) return rotateControlToken(project, label, home);
  assertOwnerOnly(directory, 0o700, 'directory');
  assertOwnerOnly(file, 0o600, 'file');
  return readFileSync(file, 'utf8').trim();
}

export function rotateControlToken(project: string, label: string, home = aegisHome()): string {
  const directory = controlTokenDir(project, home);
  prepareTokenDirectory(directory);
  const file = join(directory, `${label}.token`);
  // A file other accounts can read is left as it is. The run does not receive a replacement.
  if (existsSync(file)) assertOwnerOnly(file, 0o600, 'file');
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function revokeControlToken(project: string, label: string, home = aegisHome()): void {
  // The ended run does not receive this replacement. Health checks can still read the file.
  rotateControlToken(project, label, home);
}

export async function runWithToken<T>(project: string, label: string, home: string, body: () => Promise<T>): Promise<T> {
  rotateControlToken(project, label, home);
  try {
    return await body();
  } finally {
    revokeControlToken(project, label, home);
  }
}

function prepareTokenDirectory(directory: string): void {
  if (existsSync(directory)) {
    assertOwnerOnly(directory, 0o700, 'directory');
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function assertOwnerOnly(path: string, limit: number, kind: string): void {
  const actual = statSync(path).mode & 0o777;
  if ((actual & ~limit) !== 0) throw new Error(`The control token ${kind} is open to other accounts.`);
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
