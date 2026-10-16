import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redactor, type RunResult } from '../../packages/core/src/index.ts';
import { startCredentialPage } from '../../packages/controller/src/credentials.ts';
import { foldRunStatus, journeyFromJob, publishParent, type JobReport } from '../../packages/controller/src/suite.ts';
import { pollOperatorGate, resolveChallenge, settleOperatorAnswer, type OperatorSettlement } from '../../packages/runner/src/job.ts';
import { summaryMarkdown, type RichUser } from '../../packages/report/src/render.ts';

const project = 'fixture';
const label = 'qa-user-1';

describe('operator code', () => {
  let home = '';
  let page: { port: number; close: () => Promise<void> } | undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'hornet-operator-'));
    page = await startCredentialPage(home, 0);
  });

  afterAll(async () => {
    await page?.close();
  });

  it('asks for one code on the operator page, not a new password', async () => {
    const opened = await openGate(portOf(page));
    const response = await fetch(`http://127.0.0.1:${portOf(page)}/codes?token=${encodeURIComponent(opened.token)}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.includes('name="code"')).toBe(true);
    expect(html.includes('Decline')).toBe(true);
    expect(html.includes('type="password"')).toBe(false);
    expect(html.includes('name="password"')).toBe(false);
    expect(html.includes('name="username"')).toBe(false);
    expect(html.includes('name="totp"')).toBe(false);
    expect(html.includes('totp_secret')).toBe(false);
  });

  it('a decline blocks the journey and stores nothing', async () => {
    const opened = await openGate(portOf(page));
    const pending = pollOperatorGate(opened.pollUrl, Date.now() + 5_000, () => false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const posted = await postForm(portOf(page), opened.token, { decision: 'decline' });
    expect(posted.status).toBe(200);
    const settlement = await pending;
    const secrets = new Map<string, string>();
    const decision = await resolveChallenge({
      challenge: '2fa',
      fillsTotp: false,
      redactor: new Redactor(),
      secrets,
      ask: async () => settlement,
    });
    expect(settlement).toEqual({ action: 'block', reason: '2fa' });
    expect(decision).toEqual({ kind: 'stop', reason: '2fa' });
    expect(secrets.size).toBe(0);
    expect(existsSync(join(home, 'credential-requests.json'))).toBe(false);
    expect(existsSync(join(home, 'projects', project, 'secrets.sops.yaml'))).toBe(false);
  });

  it('no answer before the deadline blocks as a second code and submits nothing', async () => {
    const opened = await openGate(portOf(page));
    const started = Date.now();
    const deadline = started + 1_000;
    const settlement = await pollOperatorGate(opened.pollUrl, deadline, () => false);
    const secrets = new Map<string, string>();
    const decision = await resolveChallenge({
      challenge: '2fa',
      fillsTotp: false,
      redactor: new Redactor(),
      secrets,
      ask: async () => settlement,
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(settlement).toEqual({ action: 'block', reason: '2fa' });
    expect(decision).toEqual({ kind: 'stop', reason: '2fa' });
    expect(secrets.size).toBe(0);
    expect(existsSync(join(home, 'projects', project, 'secrets.sops.yaml'))).toBe(false);
  });

  it('a kill during the wait aborts and does not stage a code', async () => {
    const opened = await openGate(portOf(page));
    let aborted = false;
    const pending = pollOperatorGate(opened.pollUrl, Date.now() + 5_000, () => aborted);
    await new Promise((resolve) => setTimeout(resolve, 150));
    aborted = true;
    const settlement = await pending;
    const secrets = new Map<string, string>();
    const decision = await resolveChallenge({
      challenge: '2fa',
      fillsTotp: false,
      redactor: new Redactor(),
      secrets,
      ask: async () => settlement,
    });
    expect(settlement).toEqual({ action: 'abort', reason: 'kill' });
    expect(decision).toEqual({ kind: 'stop', reason: 'kill' });
    expect(secrets.size).toBe(0);
  });

  it('a failed Touch ID confirmation stores nothing and submits nothing', async () => {
    const opened = await openGate(portOf(page));
    const code = randomBytes(8).toString('hex');
    const previousLog = process.env.AEGIS_TOUCHID_LOG;
    process.env.AEGIS_TOUCHID_LOG = join(home, 'touchid.log');
    try {
      const unavailable = touchIdUnavailable();
      let posted: { status: number; body: string };
      try {
        posted = await postForm(portOf(page), opened.token, { decision: 'save', code });
      } finally {
        unavailable.restore();
      }
      expect(posted.body.includes(code)).toBe(false);
      expect(posted.status).toBe(401);
      const view = (await (await fetch(opened.pollUrl)).json()) as { status?: string; code?: string };
      expect(view.status).toBe('touchid');
      expect(view.code === undefined).toBe(true);
      const settlement = await pollOperatorGate(opened.pollUrl, Date.now() + 2_000, () => false);
      const secrets = new Map<string, string>();
      const decision = await resolveChallenge({
        challenge: '2fa',
        fillsTotp: false,
        redactor: new Redactor(),
        secrets,
        ask: async () => settlement,
      });
      expect(decision).toEqual({ kind: 'stop', reason: '2fa' });
      expect(secrets.size).toBe(0);
      expect(storedFiles(home).includes(code)).toBe(false);
    } finally {
      if (previousLog === undefined) delete process.env.AEGIS_TOUCHID_LOG;
      else process.env.AEGIS_TOUCHID_LOG = previousLog;
    }
  }, 70_000);

  it('a confirmed code is staged once, redacted, and the journey continues', async () => {
    const code = randomBytes(8).toString('hex');
    const secrets = new Map<string, string>();
    const redactor = new Redactor();
    let asked = 0;
    const decision = await resolveChallenge({
      challenge: '2fa',
      fillsTotp: false,
      redactor,
      secrets,
      ask: async () => {
        asked += 1;
        return settleOperatorAnswer('code', code);
      },
    });
    expect(decision).toEqual({ kind: 'continue' });
    expect(asked).toBe(1);
    expect(secrets.get('operator_code') === code).toBe(true);
    expect(secrets.has('totp_secret')).toBe(false);
    expect([...secrets.keys()].some((key) => key.includes('password'))).toBe(false);
    const next = await resolveChallenge({
      challenge: undefined,
      fillsTotp: false,
      redactor,
      secrets,
      ask: async () => {
        throw new Error('the next step must not ask again');
      },
    });
    expect(next).toEqual({ kind: 'continue' });
    const report = redactor.redactUnknown({ steps: [{ error: `filled ${code}` }], har: code }) as { steps: { error: string }[]; har: string };
    const encoded = JSON.stringify(report);
    expect(encoded.includes(code)).toBe(false);
    expect(encoded.includes('[REDACTED:operator_code]')).toBe(true);
    const har = redactor.redact(`{"postData":{"text":"${code}"}}`);
    expect(har.includes(code)).toBe(false);

    const runDir = join(home, 'runs', 'run_code');
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const packet = await publishParent({
      home,
      projectId: project,
      runDir,
      runId: 'run_code',
      result: { status: 'passed' } as RunResult,
      summary: redactor.redact(`continued after ${code}`),
      durationStop: false,
      killed: false,
      redactor: new Redactor(),
      artifacts: { screenshots: [], traces: [] },
      redactionFailed: true,
    });
    expect(packet.validation_required).toBe(true);
    const stored = readFileSync(packet.packet_path, 'utf8');
    expect(stored.includes(code)).toBe(false);
    expect(storedFiles(home).includes(code)).toBe(false);
  });

  it('a proxied poll reads a code posted on the real page and the journey continues', async () => {
    const opened = await openGate(portOf(page));
    const code = randomBytes(8).toString('hex');
    const dockerPollUrl = `http://host.docker.internal:${portOf(page)}/v1/operator-code/${encodeURIComponent(opened.id)}?token=${encodeURIComponent(opened.token)}`;
    let directFailed = false;
    try {
      await fetch(dockerPollUrl, { signal: AbortSignal.timeout(1_500) });
    } catch {
      directFailed = true;
    }
    expect(directFailed).toBe(true);

    const proxy = await startRewritingProxy();
    const previousProxy = process.env.AEGIS_PROXY;
    const previousLog = process.env.AEGIS_TOUCHID_LOG;
    process.env.AEGIS_PROXY = proxy.url;
    process.env.AEGIS_TOUCHID_LOG = join(home, 'touchid.log');
    const confirmed = touchIdResult(0);
    try {
      const posted = await postForm(portOf(page), opened.token, { decision: 'save', code });
      expect(posted.status).toBe(200);
      expect(posted.body.includes(code)).toBe(false);
      const settlement = await pollOperatorGate(dockerPollUrl, Date.now() + 5_000, () => false);
      const secrets = new Map<string, string>();
      const redactor = new Redactor();
      const decision = await resolveChallenge({
        challenge: '2fa',
        fillsTotp: false,
        redactor,
        secrets,
        ask: async () => settlement,
      });
      expect(settlement.action).toBe('continue');
      expect(settlement.action === 'continue' && settlement.code === code).toBe(true);
      expect(decision).toEqual({ kind: 'continue' });
      expect(secrets.get('operator_code') === code).toBe(true);
      expect(secrets.has('totp_secret')).toBe(false);
      expect([...secrets.keys()].some((key) => key.includes('password'))).toBe(false);
      const encoded = JSON.stringify(redactor.redactUnknown({ note: code }));
      expect(encoded.includes(code)).toBe(false);
      expect(encoded.includes('[REDACTED:operator_code]')).toBe(true);
      expect(storedFiles(home).includes(code)).toBe(false);
      expect(proxy.saw('POST')).toBe(true);
      expect(proxy.saw('GET')).toBe(true);
      expect(proxy.sawHost('host.docker.internal')).toBe(true);
    } finally {
      confirmed.restore();
      if (previousProxy === undefined) delete process.env.AEGIS_PROXY;
      else process.env.AEGIS_PROXY = previousProxy;
      if (previousLog === undefined) delete process.env.AEGIS_TOUCHID_LOG;
      else process.env.AEGIS_TOUCHID_LOG = previousLog;
      await proxy.close();
    }
  });

  it('captcha stops immediately and a totp fill does not wait', async () => {
    let captchaAsked = false;
    const captcha = await resolveChallenge({
      challenge: 'captcha',
      fillsTotp: false,
      redactor: new Redactor(),
      secrets: new Map(),
      ask: async () => {
        captchaAsked = true;
        return { action: 'block', reason: '2fa' };
      },
    });
    expect(captchaAsked).toBe(false);
    expect(captcha).toEqual({ kind: 'stop', reason: 'captcha' });

    let totpAsked = false;
    const totp = await resolveChallenge({
      challenge: '2fa',
      fillsTotp: true,
      redactor: new Redactor(),
      secrets: new Map(),
      ask: async () => {
        totpAsked = true;
        return { action: 'block', reason: '2fa' };
      },
    });
    expect(totpAsked).toBe(false);
    expect(totp).toEqual({ kind: 'continue' });
  });

  it('a second-code block uses the second-code sentence and captcha keeps the human-check sentence', () => {
    const second = summaryFor('2fa', 'SMS code page');
    expect(second).toContain('The site asked for a second code, so the checks stopped. This is high. A person needs to look at that page.');
    expect(second.includes('human check')).toBe(false);
    expect(second.includes('model')).toBe(false);
    const human = summaryFor('captcha', 'Human check stops the run');
    expect(human).toContain('The site asked for a human check, so the checks stopped. This is high. A person needs to look at that page.');
    expect(human.includes('model')).toBe(false);
    const journey = blockedJourney('2fa', 'SMS code page');
    expect(
      foldRunStatus({
        killed: false,
        gatePassed: true,
        users: [{ phase1: { status: 'pass' }, journeys: [journey] }],
      }),
    ).toBe('blocked');
    const cli = readFileSync(join(import.meta.dirname, '..', '..', 'packages/cli/src/main.ts'), 'utf8');
    expect(cli.includes("status === 'blocked' || status === 'rate_limited' ? 2")).toBe(true);
  });

  it('decline, a failed check, and a timeout all settle as a second code', () => {
    const blocked: OperatorSettlement = { action: 'block', reason: '2fa' };
    expect(settleOperatorAnswer('declined')).toEqual(blocked);
    expect(settleOperatorAnswer('touchid')).toEqual(blocked);
    expect(settleOperatorAnswer('timeout')).toEqual(blocked);
    expect(settleOperatorAnswer('code', '')).toEqual(blocked);
    expect(settleOperatorAnswer('kill')).toEqual({ action: 'abort', reason: 'kill' });
  });
});

function touchIdUnavailable(): { restore: () => void } {
  return touchIdResult(1);
}

function touchIdResult(exitCode: 0 | 1): { restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hornet-swift-'));
  const stub = join(dir, 'swift');
  const script = exitCode === 0 ? '#!/bin/sh\nexit 0\n' : '#!/bin/sh\necho "Touch ID is not available" >&2\nexit 1\n';
  writeFileSync(stub, script);
  chmodSync(stub, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previous ?? ''}`;
  return {
    restore: () => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    },
  };
}

function startRewritingProxy(): Promise<{ url: string; close: () => Promise<void>; saw: (method: string) => boolean; sawHost: (host: string) => boolean }> {
  const seen: { method: string; url: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' });
    forwardToHost(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        saw: (method) => seen.some((entry) => entry.method === method),
        sawHost: (host) => seen.some((entry) => entry.url.includes(host)),
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function forwardToHost(req: IncomingMessage, res: ServerResponse): void {
  let target: URL;
  try {
    target = new URL(req.url ?? '');
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  const host = target.hostname === 'host.docker.internal' ? '127.0.0.1' : target.hostname;
  const upstream = httpRequest(
    {
      host,
      port: Number(target.port || 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

function portOf(page: { port: number } | undefined): number {
  if (!page) throw new Error('The operator page is not open.');
  return page.port;
}

async function openGate(port: number): Promise<{ id: string; token: string; pollUrl: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/operator-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, label, reason: 'A texted or emailed code is needed.' }),
  });
  expect(response.status).toBe(200);
  const opened = (await response.json()) as { id: string; token: string };
  const pollUrl = `http://127.0.0.1:${port}/v1/operator-code/${encodeURIComponent(opened.id)}?token=${encodeURIComponent(opened.token)}`;
  return { id: opened.id, token: opened.token, pollUrl };
}

async function postForm(port: number, token: string, fields: Record<string, string>): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/codes?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, body: await response.text() };
}

function storedFiles(dir: string): string {
  const paths = [
    join(dir, 'credential-requests.json'),
    join(dir, 'notifications.log'),
    join(dir, 'touchid.log'),
    join(dir, 'projects', project, 'secrets.sops.yaml'),
    join(dir, 'projects', project, 'latest-parent-report.json'),
  ];
  return paths.filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8')).join('\n');
}

function blockedJourney(reason: '2fa' | 'captcha', name: string): ReturnType<typeof journeyFromJob> {
  const step: JobReport['steps'][number] = {
    index: 0,
    type: 'navigate',
    status: 'blocked',
    duration_ms: 1,
    started_at: '2026-10-11T00:00:00+11:00',
    finished_at: '2026-10-11T00:00:01+11:00',
    blocked_reason: reason,
  };
  return journeyFromJob({ ok: false, status: 'blocked', blocked_reason: reason, steps: [step], chaosApplied: [] }, { id: 'check', name, tries: 0 });
}

function summaryFor(reason: '2fa' | 'captcha', name: string): string {
  const user: RichUser = {
    label,
    phase1: { status: 'pass', duration_ms: 1 },
    journeys: [blockedJourney(reason, name)],
  };
  return summaryMarkdown([user], 'blocked');
}
