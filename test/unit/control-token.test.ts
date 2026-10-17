import { chmodSync, closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rewritePrivateFileInPlace } from '../../packages/core/src/secure-fs.ts';
import { controlTokenFd, readControlToken, tokenSourceFromEnv } from '../../packages/runner/src/control-token.ts';
import { startControlServer, type ControlServer } from '../../packages/runner/src/main.ts';

const first = 'runner-token-one';
const second = 'runner-token-two';

describe('the runner control token', () => {
  const opened: number[] = [];
  const servers: ControlServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close().catch(() => undefined);
    for (const fd of opened.splice(0)) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    for (const directory of directories.splice(0)) {
      chmodTree(directory);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads a mode-0600 token through the descriptor after the path can no longer be opened', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hornet-token-fd-'));
    directories.push(directory);
    const file = join(directory, 'qa-user-1.token');
    writeFileSync(file, `${first}\n`, { mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const fd = openSync(file, 'r');
    opened.push(fd);
    const inode = statSync(file).ino;
    chmodSync(file, 0o000);

    expect(readControlToken({ file })).toBe('');
    const source = tokenSourceFromEnv({ AEGIS_CONTROL_TOKEN_FILE: file, AEGIS_CONTROL_TOKEN_FD: String(fd) });
    expect(readControlToken(source)).toBe(first);

    const socketPath = join(directory, 'qa-user-1.sock');
    const control = await startControlServer({ socketPath, tokenFile: source.file, tokenFd: source.fd });
    servers.push(control);
    expect((await ask(socketPath, first)).status).toBe(200);
    expect((await ask(socketPath, second)).status).toBe(401);

    chmodSync(file, 0o600);
    rewritePrivateFileInPlace(file, `${second}\n`);
    expect(statSync(file).ino).toBe(inode);
    chmodSync(file, 0o000);
    expect(readControlToken({ file })).toBe('');
    expect(readControlToken(source)).toBe(second);
    expect((await ask(socketPath, first)).status).toBe(401);
    expect((await ask(socketPath, second)).status).toBe(200);
  });

  it('ignores a descriptor number that is not the one the entrypoint opens', () => {
    expect(controlTokenFd(undefined)).toBeUndefined();
    expect(controlTokenFd('')).toBeUndefined();
    expect(controlTokenFd('nope')).toBeUndefined();
    expect(controlTokenFd('0')).toBeUndefined();
    expect(controlTokenFd('1')).toBeUndefined();
    expect(controlTokenFd('2')).toBeUndefined();
    expect(controlTokenFd('3')).toBe(3);
    expect(tokenSourceFromEnv({ AEGIS_CONTROL_TOKEN_FILE: '/tokens/qa-user-1.token' })).toEqual({ file: '/tokens/qa-user-1.token' });
    expect(tokenSourceFromEnv({ AEGIS_CONTROL_TOKEN_FILE: '/tokens/qa-user-1.token', AEGIS_CONTROL_TOKEN_FD: '3' })).toEqual({
      file: '/tokens/qa-user-1.token',
      fd: 3,
    });
  });
});

function chmodTree(directory: string): void {
  try {
    chmodSync(directory, 0o700);
    for (const name of readdirSync(directory)) chmodSync(join(directory, name), 0o600);
  } catch {
    // The directory is already gone.
  }
}

function ask(socketPath: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: '/health', method: 'GET', headers: { authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
