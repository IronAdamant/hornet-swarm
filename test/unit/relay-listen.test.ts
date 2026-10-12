import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startControlGateway } from '../../packages/controller/src/egress-proxy.ts';

const directory = mkdtempSync(join(tmpdir(), 'hornet-relay-'));

describe('control relay listen address', () => {
  let gateway: { port: number; host: string; close: () => Promise<void> };

  afterAll(async () => {
    await gateway?.close().catch(() => undefined);
  });

  it('binds only the address it was given', async () => {
    gateway = await startControlGateway({ port: 0, project: 'relay-unit', controlDir: directory, host: '127.0.0.1' });
    expect(gateway.host).toBe('127.0.0.1');
    expect(gateway.port).toBeGreaterThan(0);
    const response = await ask(gateway.port);
    expect(response.status).toBe(404);
  });
});

function ask(port: number): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/missing', method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}
