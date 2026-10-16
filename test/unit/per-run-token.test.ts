import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlTokenPath, readControlToken, rotateControlToken, runWithToken } from '../../packages/controller/src/runner-auth.ts';
import { startControlServer, type ControlServer } from '../../packages/runner/src/main.ts';

const project = 'run-project';
const label = 'qa-user-1';
const directory = mkdtempSync(join(tmpdir(), 'hornet-run-token-'));
const socketPath = join(directory, `${label}.sock`);
const tokenFile = controlTokenPath(project, label, directory);

let control: ControlServer;

beforeAll(async () => {
  rotateControlToken(project, label, directory);
  control = await startControlServer({ socketPath, tokenFile });
});

afterAll(async () => {
  await control?.close().catch(() => undefined);
});

describe('per-run control tokens', () => {
  it('refuses an ended run token, accepts the next run, and keeps rotation inside a run', async () => {
    let first = '';
    let rotated = '';
    await runWithToken(project, label, directory, async () => {
      first = readControlToken(project, label, directory);
      expect((await ask('GET', '/health', first)).status).toBe(200);
      rotated = rotateControlToken(project, label, directory);
      expect(rotated).not.toBe(first);
      const stale = await ask('POST', '/v1/abort', first, '{}');
      expect(stale.status).toBe(401);
      expect(control.abortRequested()).toBe(false);
      expect((await ask('GET', '/health', rotated)).status).toBe(200);
    });

    expect((await ask('POST', '/v1/abort', first, '{}')).status).toBe(401);
    expect((await ask('POST', '/v1/abort', rotated, '{}')).status).toBe(401);
    expect(control.abortRequested()).toBe(false);
    const idle = readControlToken(project, label, directory);
    expect(idle).not.toBe(first);
    expect(idle).not.toBe(rotated);
    expect((await ask('GET', '/health', idle)).status).toBe(200);

    let second = '';
    await runWithToken(project, label, directory, async () => {
      second = readControlToken(project, label, directory);
      expect(second).not.toBe(first);
      expect(second).not.toBe(rotated);
      expect(second).not.toBe(idle);
      expect((await ask('GET', '/health', second)).status).toBe(200);
    });

    expect((await ask('POST', '/v1/abort', second, '{}')).status).toBe(401);
    expect((await ask('GET', '/health', first)).status).toBe(401);
    expect(control.abortRequested()).toBe(false);
  });
});

function ask(method: string, path: string, token: string, body?: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET') headers['content-type'] = 'application/json';
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
