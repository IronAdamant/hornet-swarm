import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { acquireLease, releaseStoredLease } from '../../packages/controller/dist/index.js';
import { aegis, clearSignins, cli, home, journeys, root, secret } from './helper.js';

beforeAll(() => {
  clearSignins();
});

describe('exclusive logins', () => {
  it('grants one label to one agent at a time', async () => {
    clearSignins();
    const [first, second] = await Promise.all([
      leaseProcess('agent-a', 'qa-user-1'),
      leaseProcess('agent-b', 'qa-user-1'),
    ]);
    const grants = [first, second].filter((result) => result.ok);
    const refusals = [first, second].filter((result) => !result.ok);
    expect(grants).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason === 'busy' || Boolean(refusals[0]?.nextFreeLabel)).toBe(true);
    const winner = first.ok ? 'agent-a' : 'agent-b';
    const held = acquireLease({
      project: 'fixture',
      label: 'qa-user-2',
      agentId: winner,
      candidates: ['qa-user-1', 'qa-user-2'],
      home,
    });
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.reason).toBe('agent_already_holds');
    releaseStoredLease('fixture', 'agent-a', home, 'cli');
    releaseStoredLease('fixture', 'agent-b', home, 'cli');
    const again = acquireLease({ project: 'fixture', label: 'qa-user-2', agentId: 'agent-a', home });
    expect(again.ok).toBe(true);
    releaseStoredLease('fixture', 'agent-a', home, 'cli');

    const short = acquireLease({ project: 'fixture', label: 'qa-user-1', agentId: 'agent-expire', ttlMs: 40, home });
    expect(short.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const reclaimed = acquireLease({ project: 'fixture', label: 'qa-user-1', agentId: 'agent-new', home });
    expect(reclaimed.ok).toBe(true);
    releaseStoredLease('fixture', 'agent-new', home, 'cli');

    const child = spawn(process.execPath, [cli, 'suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'kill-wait.journey.yaml')], { cwd: root });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const overlap = aegis(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
    expect(overlap.status).toBe(3);
    expect(overlap.stdout + overlap.stderr).toMatch(/busy until|already holds/);
    const status = JSON.parse(aegis(['env', 'status', '--project', 'fixture', '--json']).stdout) as { runners: { label: string }[] };
    const labels = status.runners.map((runner) => runner.label);
    expect(new Set(labels).size).toBe(labels.length);
    child.kill();
    await new Promise((resolve) => child.on('exit', resolve));
    clearSignins();
    const audit = readFileSync(join(home, 'audit.log'), 'utf8');
    expect(audit).toContain('lease_acquire');
    expect(audit).not.toContain(secret);
  });
});

function leaseProcess(agentId: string, label: string): Promise<{ ok: boolean; reason?: string; nextFreeLabel?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { acquireLease } from ${JSON.stringify(join(root, 'packages/controller/dist/index.js'))};
      const decision = acquireLease({ project: 'fixture', label: ${JSON.stringify(label)}, agentId: ${JSON.stringify(agentId)}, candidates: ['qa-user-1', 'qa-user-2'], home: ${JSON.stringify(home)} });
      process.stdout.write(JSON.stringify(decision.ok ? { ok: true } : { ok: false, reason: decision.reason, busyUntil: decision.busyUntil, nextFreeLabel: decision.nextFreeLabel }));
    `], { cwd: root });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(out));
      else resolve(JSON.parse(out) as { ok: boolean; reason?: string; nextFreeLabel?: string });
    });
  });
}
