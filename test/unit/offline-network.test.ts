import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOfflineHost } from '../../eslint-rules/hornet-swarm-rules.js';

const root = join(import.meta.dirname, '../..');

describe('the offline network guard', () => {
  it('refuses a live host before connecting, through fetch, https, and raw sockets', async () => {
    // eslint-disable-next-line hornet-swarm/no-live-hosts-in-tests -- proves the runtime guard refuses it
    const fetched = await fetch('https://www.saucedemo.com/').catch((error: Error) => error);
    expect((fetched as Error & { cause?: Error }).cause?.name).toBe('LiveHostError');
    expect(() => httpsRequest({ host: 'www.google.com', path: '/' }).end()).toThrow(/A test tried to reach www.google.com/);
    expect(() => connect(443, 'the-internet.herokuapp.com')).toThrow(/A test tried to reach the-internet.herokuapp.com/);
  });

  it('still lets a test reach this machine', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe('ok');
    } finally {
      server.close();
    }
  });

  it('keeps a script a test starts offline: setup-practice without its offline switches cannot reach Sauce Demo', () => {
    const home = mkdtempSync(join(tmpdir(), 'hornet-offline-'));
    const env = { ...process.env, AEGIS_HOME: home };
    delete env.HORNET_PRACTICE_PASSWORD;
    const run = spawnSync(process.execPath, [join(root, 'scripts/setup-practice.mjs'), 'saucedemo'], { cwd: root, env, encoding: 'utf8', input: '' });
    expect(run.stderr).toContain('A test tried to reach www.saucedemo.com');
    expect(run.status).toBe(5);
    expect(run.stdout).not.toContain('Installed saucedemo');
  });

  it('treats only this machine, local containers, and reserved names as offline', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal', 'shop.test', 'off-list.invalid', 'evil.example', 'hornet-swarm-proxy-shop', '172.18.0.2']) {
      expect(isOfflineHost(host), host).toBe(true);
    }
    for (const host of ['example.com', 'www.saucedemo.com', 'the-internet.herokuapp.com', '8.8.8.8', '172.32.0.1', 'localhost.evil.com']) {
      expect(isOfflineHost(host), host).toBe(false);
    }
  });
});
