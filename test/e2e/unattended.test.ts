import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { chaosSequence, Redactor } from '../../packages/core/dist/index.js';
import { acquireLease, publishParent, releaseStoredLease, runSuite, saveSwarmBoard } from '../../packages/controller/dist/index.js';
import type { RunResult } from '../../packages/core/dist/index.js';
import { clearSignins, containsSecret, home, hornet, journeys, latestRun, readRun, root, secret } from './helper.js';

const projectFile = join(home, 'projects/fixture/project.yaml');
const mcp = join(root, 'packages/mcp-server/dist/main.js');

describe('unattended swarm', () => {
  it('lets two sessions hold two labels and refuses a second session using the first id', async () => {
    clearSignins();
    const firstSession = await openMcp();
    const secondSession = await openMcp();
    try {
      const first = await sessionCall(firstSession, 'acquire_test_user', { project: 'fixture', label: 'qa-user-1' });
      const second = await sessionCall(secondSession, 'acquire_test_user', { project: 'fixture', label: 'qa-user-2' });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(first.agent_id).toMatch(/^mcp-/);
      expect(second.agent_id).toMatch(/^mcp-/);
      expect(second.agent_id).not.toBe(first.agent_id);
      const stolen = await sessionCall(secondSession, 'acquire_test_user', { project: 'fixture', label: 'qa-user-1', agent_id: first.agent_id });
      expect(stolen.ok).toBe(false);
      expect(stolen.error).toContain('another session');
      const third = await sessionCall(firstSession, 'acquire_test_user', { project: 'fixture', label: 'qa-user-2' });
      expect(third.ok).toBe(false);
      expect(third.reason).toBe('agent_already_holds');
      const released = await sessionCall(secondSession, 'release_test_user', { project: 'fixture', agent_id: first.agent_id });
      expect(released.ok).toBe(false);
      const stillHeld = JSON.parse(readFileSync(join(home, 'leases.json'), 'utf8')) as { agentId: string; label: string }[];
      expect(stillHeld.some((lease) => lease.agentId === first.agent_id && lease.label === 'qa-user-1')).toBe(true);
      await sessionCall(firstSession, 'release_test_user', { project: 'fixture' });
      await sessionCall(secondSession, 'release_test_user', { project: 'fixture' });
    } finally {
      await firstSession.close();
      await secondSession.close();
    }
  });

  it('renews a short lease until the hold ends', async () => {
    clearSignins();
    const pending = runSuite({
      project: 'fixture',
      journeyFiles: [join(journeys, 'kill-wait.journey.yaml')],
      home,
      agentId: 'renew-holder',
      leaseTtlMs: 300,
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const during = acquireLease({ project: 'fixture', label: 'qa-user-1', agentId: 'renew-other', home });
    expect(during.ok).toBe(false);
    if (!during.ok) expect(during.reason).toBe('busy');
    const audit = readFileSync(join(home, 'audit.log'), 'utf8');
    expect(audit).toContain('lease_renew');
    expect(audit).not.toContain(secret);
    await pending;
    const after = acquireLease({ project: 'fixture', label: 'qa-user-1', agentId: 'renew-other', home });
    expect(after.ok).toBe(true);
    releaseStoredLease('fixture', 'renew-other', home, 'cli');
    clearSignins();
  });

  it('runs with the selectors saved on the board', () => {
    clearSignins();
    const original = readFileSync(projectFile, 'utf8');
    try {
      saveSwarmBoard(
        {
          project: 'fixture',
          website: 'http://127.0.0.1:4173/login',
          cards: [{ username: 'qa1@example.test', password: secret, personality: 'Careful checker' }],
          selectors: { username: '#missing-user', password: '#password', submit: "role=button[name='Sign in']", success: '/dashboard' },
        },
        home,
      );
      const missed = hornet(['sign-in', '--project', 'fixture', '--user', 'qa-user-1', '--json']);
      expect(missed.status).not.toBe(0);
      expect(readFileSync(projectFile, 'utf8')).toContain('#missing-user');
      saveSwarmBoard(
        {
          project: 'fixture',
          website: 'http://127.0.0.1:4173/login',
          cards: [{ username: 'qa1@example.test', password: secret, personality: 'Careful checker' }],
          selectors: { username: '#email', password: '#password', submit: "role=button[name='Sign in']", success: '/dashboard' },
        },
        home,
      );
      const signed = hornet(['sign-in', '--project', 'fixture', '--user', 'qa-user-1', '--json']);
      expect(signed.status, signed.stdout + signed.stderr).toBe(0);
      const body = JSON.parse(signed.stdout) as { status: string; parent: { validation_required: boolean; packet_path: string; evidence_zip: string } };
      expect(body.status).toBe('passed');
      expect(body.parent.validation_required).toBe(true);
      expect(body.parent.packet_path).toContain('latest-parent-report.json');
      expect(existsSync(body.parent.evidence_zip)).toBe(true);
    } finally {
      writeFileSync(projectFile, original);
      clearSignins();
    }
  });

  it('records two clicks for a double-click chaos seed and hands the parent a clean packet', async () => {
    clearSignins();
    let seed = 'dbl-0';
    for (let index = 0; index < 40; index += 1) {
      const candidate = `dbl-${index}`;
      if (chaosSequence(candidate, 'double-click', 2).some((action) => action.kind === 'double-click')) {
        seed = candidate;
        break;
      }
    }
    const run = hornet([
      'suite',
      '--project',
      'fixture',
      '--json',
      '--chaos',
      'double-click',
      '--seed',
      seed,
      '--journey',
      join(journeys, 'flag.journey.yaml'),
    ]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const report = readRun();
    const actions = (report.analysis.chaos as { actions?: string[] } | null)?.actions ?? [];
    expect(actions.filter((action) => action === 'click').length).toBeGreaterThanOrEqual(2);
    const packetPath = join(home, 'projects/fixture/latest-parent-report.json');
    const packet = readFileSync(packetPath, 'utf8');
    const parsed = JSON.parse(packet) as { validation_required: boolean; evidence_zip: string; instruction: string; summary: string; html_path: string };
    expect(parsed.validation_required).toBe(true);
    expect(parsed.summary).toContain('Findings');
    expect(parsed.instruction).toContain('does not grade');
    expect(packet).not.toContain(secret);
    expect(packet).not.toContain('FixtureOnly-other');
    const hits = await containsSecret(latestRun());
    expect(hits).toEqual([]);
    const html = readFileSync(parsed.html_path, 'utf8');
    expect(html).toContain('Data isolation');
    expect(html).toContain('Redaction: PASS');
    const human = hornet(['sign-in', '--project', 'fixture', '--user', 'qa-user-1']);
    expect(human.status, human.stdout + human.stderr).toBe(0);
    const lines = human.stdout.split('\n');
    expect(lines[0]).toBe('The parent must validate this run.');
    expect(lines[1]).toMatch(/^run_/);
    expect(lines[2]).toContain('latest-parent-report.json');
  });

  it('stops at the run limit without turning on the kill switch', () => {
    clearSignins();
    const original = readFileSync(projectFile, 'utf8');
    writeFileSync(projectFile, original.replace('max_run_duration_min: 30', 'max_run_duration_min: 0.01'));
    try {
      const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'kill-wait.journey.yaml')]);
      expect(run.status).toBe(2);
      const body = JSON.parse(run.stdout) as { status: string; parent: { status: string; killed: boolean } };
      expect(body.status).toBe('blocked');
      expect(body.parent.status).toBe('duration');
      expect(body.parent.killed).toBe(false);
      expect(JSON.stringify(readRun().result)).toContain('duration');
      expect(existsSync(join(home, 'KILL'))).toBe(false);
      const released = acquireLease({ project: 'fixture', label: 'qa-user-1', agentId: 'duration-next', home });
      expect(released.ok).toBe(true);
      releaseStoredLease('fixture', 'duration-next', home, 'cli');
    } finally {
      writeFileSync(projectFile, original);
      clearSignins();
      const up = hornet(['env', 'up', '--project', 'fixture', '--count', '1', '--json']);
      expect(up.status, up.stdout + up.stderr).toBe(0);
    }
  });

  it('a redaction failure packet has empty evidence and artifact paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-withhold-'));
    const runDir = join(dir, 'runs', 'run_leak');
    mkdirSync(runDir, { recursive: true });
    const leaked = 'packet-leak-value';
    const dirty = join(runDir, 'dirty.png');
    const clean = join(runDir, 'clean.png');
    const zip = join(runDir, 'evidence.zip');
    writeFileSync(dirty, leaked);
    writeFileSync(clean, 'clean-bytes');
    writeFileSync(zip, leaked);
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', leaked);
    const packet = await publishParent({
      home: dir,
      projectId: 'fixture',
      runDir,
      runId: 'run_leak',
      result: { status: 'passed' } as RunResult,
      summary: `leaked ${leaked}`,
      durationStop: false,
      killed: false,
      redactor,
      artifacts: { screenshots: [dirty, clean], traces: [] },
      redactionFailed: true,
    });
    expect(packet.status).toBe('redaction_failure');
    expect(packet.evidence_zip).toBe('');
    expect(packet.screenshot_paths).toEqual([]);
    expect(packet.trace_paths).toEqual([]);
    expect(packet.html_path).toBe('');
    expect(existsSync(`${zip}.quarantined`)).toBe(true);
    expect(existsSync(clean)).toBe(true);
    expect(readFileSync(join(dir, 'projects/fixture/latest-parent-report.json'), 'utf8')).not.toContain(leaked);
  });

  it('runs only qa-user-1 when that label is the filter on a two-user journey', () => {
    clearSignins();
    const run = hornet([
      'suite',
      '--project',
      'fixture',
      '--json',
      '--user',
      'qa-user-1',
      '--journey',
      join(journeys, 'both-users.journey.yaml'),
    ]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const users = readRun().result.users as { label: string }[];
    expect(users.map((user) => user.label)).toEqual(['qa-user-1']);
    const signins = JSON.parse(readFileSync(join(home, 'projects/fixture/signin.json'), 'utf8')) as { label: string }[];
    expect(signins.some((entry) => entry.label === 'qa-user-2')).toBe(false);
    expect(signins.some((entry) => entry.label === 'qa-user-1')).toBe(true);
  });

  it('prints kill_switch and runners on both swarm reads', () => {
    const first = hornet(['swarm', '--project', 'fixture', '--json']);
    const second = hornet(['swarm', '--project', 'fixture', '--json']);
    for (const run of [first, second]) {
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const view = JSON.parse(run.stdout) as { kill_switch: boolean; ready: boolean; runners: { label: string; healthy: boolean }[] };
      expect(typeof view.kill_switch).toBe('boolean');
      expect(Array.isArray(view.runners)).toBe(true);
      expect(view.runners.length).toBeGreaterThan(0);
      expect(run.stdout).not.toContain(secret);
      expect(run.stdout).not.toContain('FixtureOnly-other');
    }
  });

  it('does not create a missing runner and still writes an error packet', () => {
    clearSignins();
    const target = 'hornet-swarm-fixture-qa-user-2';
    const before = dockerNames();
    const existed = before.includes(target);
    const run = hornet(['sign-in', '--project', 'fixture', '--json', '--user', 'qa-user-2']);
    const after = dockerNames();
    if (!existed) expect(after).not.toContain(target);
    const packet = JSON.parse(readFileSync(join(home, 'projects/fixture/latest-parent-report.json'), 'utf8')) as {
      status: string;
      validation_required: boolean;
      instruction: string;
    };
    if (!existed) {
      expect(run.status).toBe(4);
      expect(packet.status).toBe('error');
      expect(packet.validation_required).toBe(true);
      expect(packet.instruction).toContain('does not grade');
    }
    expect(JSON.stringify(packet)).not.toContain(secret);
    expect(run.stdout + run.stderr).not.toContain(secret);
  });

  it('starts a stopped fixture runner or reports an error packet', () => {
    clearSignins();
    execFileSync('docker', ['stop', 'hornet-swarm-fixture-qa-user-1'], { encoding: 'utf8' });
    try {
      const run = hornet(['sign-in', '--project', 'fixture', '--json', '--user', 'qa-user-1']);
      const packet = JSON.parse(readFileSync(join(home, 'projects/fixture/latest-parent-report.json'), 'utf8')) as {
        status: string;
        validation_required: boolean;
        instruction: string;
      };
      if (run.status === 0) expect(JSON.parse(run.stdout).status).toBe('passed');
      else {
        expect(packet.status).toBe('error');
        expect(packet.validation_required).toBe(true);
        expect(packet.instruction).toContain('does not grade');
      }
      expect(run.stdout + run.stderr).not.toContain(secret);
      expect(JSON.stringify(packet)).not.toContain(secret);
    } finally {
      const up = hornet(['env', 'up', '--project', 'fixture', '--count', '1', '--json']);
      expect(up.status, up.stdout + up.stderr).toBe(0);
      clearSignins();
    }
  });
});

function dockerNames(): string[] {
  return execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' }).split('\n');
}

async function openMcp(): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp], cwd: root });
  const client = new Client({ name: 'hornet-unattended', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

async function sessionCall(client: Client, name: string, args: Record<string, unknown>): Promise<{ ok?: boolean; reason?: string; error?: string; agent_id?: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((entry) => entry.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as { ok?: boolean; reason?: string; error?: string; agent_id?: string };
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<{ ok?: boolean; reason?: string }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp], cwd: root });
  const client = new Client({ name: 'hornet-unattended', version: '0.1.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.find((entry) => entry.type === 'text')?.text ?? '{}';
    return JSON.parse(text) as { ok?: boolean; reason?: string };
  } finally {
    await client.close();
  }
}
