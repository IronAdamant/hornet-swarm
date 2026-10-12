import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Redactor, type RunResult } from '../../packages/core/src/index.ts';
import { containerChosen } from '../../packages/controller/src/env.ts';
import { startControlGateway } from '../../packages/controller/src/egress-proxy.ts';
import { acquireLease } from '../../packages/controller/src/leases-store.ts';
import { publishParent, selectRunLabels, writeErrorOutcome } from '../../packages/controller/src/suite.ts';
import { runnerHealth, swarmSnapshot } from '../../packages/controller/src/swarm.ts';
import { classifyBlockedReason, classifyChallenge } from '../../packages/runner/src/job.ts';
import { junitXml, summaryMarkdown, type RichUser } from '../../packages/report/src/render.ts';

const root = join(import.meta.dirname, '..', '..');

describe('honest swarm', () => {
  it('classifies proxy connection failure and HTTP 502 as proxy and an allowlist error as allowlist', () => {
    expect(classifyBlockedReason('ERR_PROXY_CONNECTION_FAILED')).toBe('proxy');
    expect(classifyBlockedReason('proxy connection failure and HTTP 502')).toBe('proxy');
    expect(classifyBlockedReason('net::ERR_BLOCKED_BY_CLIENT')).toBe('allowlist');
    expect(classifyBlockedReason('HTTP 502 from the origin')).toBeUndefined();
  });

  it('classifies a texted code and a six-digit field as 2fa and leaves a bare 403 alone', () => {
    expect(
      classifyChallenge({
        text: 'We texted you a code',
        inputs: [{ name: 'code', maxlength: '6' }],
      }),
    ).toBe('2fa');
    expect(
      classifyChallenge({
        text: 'Sign in access denied',
        inputs: [{ type: 'password', name: 'password' }],
      }),
    ).toBeUndefined();
    expect(
      classifyChallenge({
        text: 'verify you are human',
        frames: [{ src: '/captcha-frame', title: 'recaptcha', width: 300, height: 150, visible: true }],
        inputs: [],
      }),
    ).toBe('captcha');
  });

  it('a lowercased password and a short percent-encoding are redacted', () => {
    const spaced = new Redactor();
    spaced.register('qa-user-1.password', ' ');
    expect(spaced.redact('%20')).toBe('[REDACTED:qa-user-1.password]');
    const folded = new Redactor();
    folded.register('qa-user-1.password', 'SecretValue');
    expect(folded.redact('secretvalue')).toBe('[REDACTED:qa-user-1.password]');
    const totp = new Redactor();
    totp.register('qa-user-1.totp_secret', 'JBSWY3DPEHPK3PXP');
    expect(totp.redact('jbswy3dpehpk3pxp')).toBe('[REDACTED:qa-user-1.totp_secret]');
  });

  it('a blocked isolation journey returns the human-check sentence, and only a failed access check returns the cross-account sentence', () => {
    const blocked = summaryMarkdown([user('blocked', 'captcha')], 'blocked');
    expect(blocked).toContain('The site asked for a human check, so the checks stopped.');
    expect(blocked).not.toContain('another account');
    const breached = summaryMarkdown([user('fail', undefined, 'access_denied')], 'failed');
    expect(breached).toContain("A test account could open another account's page.");
    const ownPageFailed = summaryMarkdown([user('fail', undefined, "selector_visible [data-testid='resource-view']")], 'failed');
    expect(ownPageFailed).not.toContain('another account');
    expect(ownPageFailed).toContain('A check did not pass.');
  });

  it("a blocked step's JUnit contains <failure", () => {
    const blocked = junitXml(runWith('blocked'));
    expect(blocked).toContain('<failure');
    const skipped = junitXml(runWith('skipped'));
    expect(skipped).not.toContain('<failure');
  });

  it('keeps a label only when the journey also lists it', () => {
    expect(
      selectRunLabels({
        phase1Only: false,
        users: ['qa-user-1', 'qa-user-9'],
        projectUsers: ['qa-user-1', 'qa-user-2'],
        journeyUsers: ['qa-user-1', 'qa-user-2'],
      }),
    ).toEqual(['qa-user-1']);
    expect(
      selectRunLabels({
        phase1Only: false,
        projectUsers: ['qa-user-1', 'qa-user-2'],
        journeyUsers: ['qa-user-1', 'qa-user-2'],
      }),
    ).toEqual(['qa-user-1', 'qa-user-2']);
  });

  it('stops only the named runner', () => {
    expect(containerChosen({ Names: ['/hornet-swarm-fixture-qa-user-1'], Labels: {} }, 'fixture', 'qa-user-1')).toBe(true);
    expect(
      containerChosen({ Names: ['/hornet-swarm-fixture-qa-user-2'], Labels: { 'hornet-swarm.user': 'qa-user-2' } }, 'fixture', 'qa-user-1'),
    ).toBe(false);
    expect(containerChosen({ Names: ['/hornet-swarm-fixture-qa-user-2'] }, 'fixture')).toBe(true);
  });

  it('marks a runner healthy only when the health check passed', () => {
    expect(runnerHealth([{ label: 'qa-user-1', personality: '' }], [{ label: 'qa-user-1', health: 'unhealthy' }])).toEqual([
      { label: 'qa-user-1', healthy: false },
    ]);
    expect(runnerHealth([{ label: 'qa-user-1', personality: '' }], [{ label: 'qa-user-1', health: 'healthy' }])).toEqual([
      { label: 'qa-user-1', healthy: true },
    ]);
    expect(runnerHealth([{ label: 'qa-user-2', personality: '' }], [])).toEqual([{ label: 'qa-user-2', healthy: false }]);
  });

  it('keeps the board when runner health cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-swarm-view-'));
    const project = 'bad project';
    mkdirSync(join(dir, 'projects', project), { recursive: true });
    writeFileSync(
      join(dir, 'projects', project, 'swarm.json'),
      `${JSON.stringify({ ready: true, website: 'http://127.0.0.1:4173/login', agents: [{ label: 'qa-user-1', personality: 'Careful checker' }] })}\n`,
    );
    writeFileSync(join(dir, 'KILL'), 'on\n');
    const view = await swarmSnapshot(project, dir);
    expect(view.ready).toBe(true);
    expect(view.kill_switch).toBe(true);
    expect(view.runners).toEqual([{ label: 'qa-user-1', healthy: false }]);
    expect(JSON.stringify(view)).not.toContain('password');
    expect(view.website).toContain('127.0.0.1');
  });

  it('a dead-pid lock acquire succeeds and a corrupt leases.json is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-lease-'));
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    const pid = sleeper.pid;
    if (!pid) throw new Error('sleep did not start');
    sleeper.kill('SIGKILL');
    await new Promise((resolve) => sleeper.once('exit', resolve));
    const lock = join(dir, 'leases.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${pid}\n`);
    const acquired = acquireLease({ project: 'temp', label: 'qa-user-1', agentId: 'dead-lock', home: dir, via: 'cli' });
    expect(acquired.ok).toBe(true);

    const corruptDir = mkdtempSync(join(tmpdir(), 'hornet-lease-'));
    const file = join(corruptDir, 'leases.json');
    const bytes = '{not json';
    writeFileSync(file, bytes);
    expect(() => acquireLease({ project: 'temp', label: 'qa-user-1', agentId: 'corrupt-lock', home: corruptDir, via: 'cli' })).toThrow(
      /leases.json could not be read/,
    );
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('releases leases this process holds when SIGTERM arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-sigterm-'));
    const cli = viteNode();
    const env = { ...process.env };
    delete env.VITEST;
    const child = spawn(process.execPath, [cli, join(root, 'test/unit/lease-sigterm-holder.ts'), dir], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    let errorText = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errorText += chunk.toString();
    });
    const held = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 20_000);
      child.stdout?.on('data', () => {
        if (output.includes('held')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    expect(held, errorText || output).toBe(true);
    child.kill('SIGTERM');
    const code = await new Promise<number>((resolve) => child.once('exit', (status) => resolve(status ?? 1)));
    expect(code).toBe(143);
    const leases = JSON.parse(readFileSync(join(dir, 'leases.json'), 'utf8')) as { agentId: string }[];
    expect(leases.some((lease) => lease.agentId === 'sigterm-holder')).toBe(false);
  });

  it('writes an error packet that leaves the failure text out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-error-packet-'));
    const runDir = join(dir, 'runs', 'run_error');
    mkdirSync(runDir, { recursive: true });
    const secretText = 'handoff-secret-value';
    const wrote = writeErrorOutcome({
      home: dir,
      projectId: 'fixture',
      environment: 'test',
      authorisationId: 'fixture',
      runDir,
      runId: 'run_error',
      started: '2026-10-11T00:00:00+11:00',
      gate: 'all',
      message: `handoff failed ${secretText}`,
      codes: [secretText],
    });
    expect(wrote.run).toBe(true);
    expect(wrote.packet).toBe(true);
    expect(wrote.message).not.toContain(secretText);
    const packet = readFileSync(join(dir, 'projects/fixture/latest-parent-report.json'), 'utf8');
    const parsed = JSON.parse(packet) as { status: string; validation_required: boolean; instruction: string };
    expect(parsed.status).toBe('error');
    expect(parsed.validation_required).toBe(true);
    expect(parsed.instruction).toContain('does not grade');
    expect(packet).not.toContain(secretText);
    expect(readFileSync(join(runDir, 'run.json'), 'utf8')).not.toContain(secretText);
  });

  it('withholds a parent packet and quarantines only the files that contain a secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-withhold-'));
    const runDir = join(dir, 'runs', 'run_leak');
    mkdirSync(runDir, { recursive: true });
    const secretText = 'packet-secret-value';
    const dirty = join(runDir, 'dirty.png');
    const clean = join(runDir, 'clean.png');
    const zip = join(runDir, 'evidence.zip');
    const html = join(runDir, 'report.html');
    writeFileSync(dirty, secretText);
    writeFileSync(clean, 'clean-bytes');
    writeFileSync(zip, secretText);
    writeFileSync(html, secretText);
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', secretText);
    const packet = await publishParent({
      home: dir,
      projectId: 'fixture',
      runDir,
      runId: 'run_leak',
      result: { status: 'passed' } as RunResult,
      summary: `leaked ${secretText}`,
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
    expect(readFileSync(`${dirty}.quarantined`, 'utf8')).toContain('quarantined');
    expect(readFileSync(`${zip}.quarantined`, 'utf8')).toContain('quarantined');
    expect(readFileSync(`${html}.quarantined`, 'utf8')).toContain('quarantined');
    expect(readFileSync(clean, 'utf8')).toBe('clean-bytes');
  });

  it('closing the gateway client destroys the upstream request', async () => {
    let upstreamClosed = false;
    const upstream = createServer((req) => {
      req.socket.on('close', () => {
        upstreamClosed = true;
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    const upstreamPort = typeof address === 'object' && address ? address.port : 0;
    const gateway = await startControlGateway({ port: 0, project: 'fixture', upstreamHost: '127.0.0.1', upstreamPort });
    const client = httpRequest({ host: '127.0.0.1', port: gateway.port, path: '/r/qa-user-1/v1/jobs', method: 'POST' });
    client.on('error', () => undefined);
    client.end('{}');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(upstreamClosed).toBe(false);
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(upstreamClosed).toBe(true);
    await gateway.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});

function user(status: 'blocked' | 'fail', reason?: string, assertion?: string): RichUser {
  return {
    label: 'qa-user-1',
    phase1: { status: 'pass', duration_ms: 1 },
    journeys: [
      {
        id: 'tenant-isolation',
        name: 'Cross-tenant access is denied',
        status,
        duration_ms: 1,
        steps: [
          {
            index: 0,
            type: 'assert',
            status,
            duration_ms: 1,
            started_at: '2026-10-11T00:00:00+11:00',
            finished_at: '2026-10-11T00:00:01+11:00',
            ...(reason ? { blocked_reason: reason as 'captcha' } : {}),
            ...(assertion ? { assertion } : {}),
          },
        ],
      },
    ],
  };
}

function runWith(stepStatus: 'blocked' | 'skipped'): RunResult {
  return {
    schema_version: '1',
    run_id: 'run_junit',
    project: 'fixture',
    started_at: '2026-10-11T00:00:00+11:00',
    status: 'blocked',
    gate: 'all',
    gate_passed: false,
    totals: { users: 1, journeys: 1, steps: 1, passed: 0, failed: 0, skipped: stepStatus === 'skipped' ? 1 : 0 },
    users: [
      {
        label: 'qa-user-1',
        phase1: { status: 'pass', duration_ms: 1 },
        journeys: [
          {
            id: 'tenant-isolation',
            status: stepStatus,
            duration_ms: 1,
            steps: [
              {
                index: 0,
                type: 'assert',
                status: stepStatus,
                duration_ms: 1,
                started_at: '2026-10-11T00:00:00+11:00',
                finished_at: '2026-10-11T00:00:01+11:00',
              },
            ],
          },
        ],
      },
    ],
    environment: 'test',
    authorisation_id: 'fixture',
    redaction: 'pass',
  };
}

function viteNode(): string {
  const store = join(root, 'node_modules/.pnpm');
  const name = readdirSync(store).find((entry) => entry.startsWith('vite-node@'));
  if (!name) throw new Error('vite-node is not installed');
  return join(store, name, 'node_modules/vite-node/dist/cli.mjs');
}
