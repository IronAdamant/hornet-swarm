import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { runnerFetch } from '../../packages/controller/src/runner-auth.ts';
import { hornet } from './helper.js';

const project = 'socketproof';
const runner = 'hornet-swarm-socketproof-qa-user-1';
const proxy = 'hornet-swarm-proxy-socketproof';

describe('control socket permissions', () => {
  afterAll(() => {
    docker(['rm', '-f', runner, proxy]);
  });

  it('keeps the browser user off the control socket while the controller can start a job', async () => {
    const up = hornet(['env', 'up', '--project', project, '--count', '1', '--json'], undefined, 180_000);
    expect(up.status, up.stdout + up.stderr).toBe(0);
    const status = JSON.parse(up.stdout) as { runners: { endpoint: string | null; health: string }[] };
    const endpoint = status.runners[0]?.endpoint;
    expect(status.runners[0]?.health).toBe('healthy');
    expect(endpoint).toBeTruthy();

    const listed = docker(['exec', '-u', '10001:10010', runner, 'node', '-e', socketScript()]);
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    expect(listed.stdout.trim()).toBe('660 10001 10010\n770 10001 10010');

    const denied = docker(['exec', '-u', '10002:10002', runner, 'node', '-e', connectScript()]);
    expect(denied.status, denied.stdout + denied.stderr).toBe(0);
    expect(denied.stdout.trim()).toBe('EACCES');

    const reachable = docker(['exec', '-u', '10002:10002', runner, 'node', '-e', tcpScript(proxy)]);
    expect(reachable.status, reachable.stdout + reachable.stderr).toBe(0);
    expect(reachable.stdout.trim()).toBe('TCP_OK');

    const probe = runnerFetch(project, endpoint ?? '', '/v1/probe', {
      method: 'POST',
      body: JSON.stringify({ holdMs: 12_000 }),
      signal: AbortSignal.timeout(60_000),
    });
    void probe.catch(() => undefined);
    const chrome = await waitForChrome();
    const chromeUids = chrome.stdout.trim();
    expect(chrome.status, chrome.stdout + chrome.stderr).toBe(0);
    expect(chromeUids, chromeUids).not.toBe('NONE');
    expect(chromeUids.split(',').every((uid) => uid === '10002'), chromeUids).toBe(true);

    const deniedWhileOpen = docker(['exec', '-u', '10002:10002', runner, 'node', '-e', connectScript()]);
    expect(deniedWhileOpen.status, deniedWhileOpen.stdout + deniedWhileOpen.stderr).toBe(0);
    expect(deniedWhileOpen.stdout.trim()).toBe('EACCES');

    const probeResponse = await probe;
    const probeBody = (await probeResponse.json()) as { ok?: boolean; error?: string };
    expect(probeResponse.status, JSON.stringify(probeBody)).toBe(200);
    expect(probeBody.ok).toBe(true);

    const job = await runnerFetch(project, endpoint ?? '', '/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({
        runId: 'socket-proof',
        label: 'qa-user-1',
        journeyId: 'socket-proof',
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

function socketScript(): string {
  return `
    const fs = require('fs');
    const sock = fs.statSync('/control/qa-user-1.sock');
    const dir = fs.statSync('/control');
    console.log((sock.mode & 511).toString(8) + ' ' + sock.uid + ' ' + sock.gid);
    console.log((dir.mode & 511).toString(8) + ' ' + dir.uid + ' ' + dir.gid);
  `;
}

function connectScript(): string {
  return `
    const net = require('net');
    const socket = net.connect({ path: '/control/qa-user-1.sock' });
    socket.on('connect', () => { console.log('OPEN'); process.exit(2); });
    socket.on('error', (error) => { console.log(error.code); process.exit(0); });
    setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 4000);
  `;
}

function tcpScript(host: string): string {
  return `
    const net = require('net');
    const socket = net.connect(8888, ${JSON.stringify(host)});
    socket.on('connect', () => { console.log('TCP_OK'); socket.destroy(); process.exit(0); });
    socket.on('error', (error) => { console.log('TCP_' + error.code); process.exit(1); });
    setTimeout(() => { console.log('TCP_TIMEOUT'); process.exit(3); }, 4000);
  `;
}

async function waitForChrome(): Promise<{ status: number; stdout: string; stderr: string }> {
  const deadline = Date.now() + 20_000;
  let last = { status: 1, stdout: '', stderr: '' };
  while (Date.now() < deadline) {
    last = docker(['exec', runner, 'node', '-e', chromeScript()]);
    const uids = last.stdout.trim();
    if (last.status === 0 && uids.length > 0 && uids !== 'NONE') return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return last;
}

function chromeScript(): string {
  return `
    const fs = require('fs');
    const uids = [];
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(pid) || pid === String(process.pid)) continue;
      let name = '';
      try { name = fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim(); } catch { continue; }
      if (!name.startsWith('chrome')) continue;
      const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
      const uid = (status.match(/^Uid:\\s+(\\d+)/m) || [])[1];
      if (uid) uids.push(uid);
    }
    console.log(uids.length ? uids.join(',') : 'NONE');
  `;
}

function docker(args: string[], timeout = 30_000): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('docker', args, { encoding: 'utf8', timeout });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: failed.status ?? 1,
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? ''),
    };
  }
}
