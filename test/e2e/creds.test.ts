import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { requestCredentials } from '../../packages/controller/dist/index.js';
import { hornet, clearSignins, home, readRun, secret } from './helper.js';

beforeAll(() => {
  clearSignins();
});

describe('credential requests', () => {
  it('lets the owner enter a login and never shows the secret to the agent', async () => {
    const log = join(home, 'touchid.log');
    process.env.AEGIS_TOUCHID_LOG = log;
    await expect(requestCredentials({ project: 'fixture', label: 'qa-user-1', reason: 'fixture sign-in', password: 'nope' }, home)).rejects.toThrow(/project, a label, and a reason/);
    const pending = await requestCredentials({ project: 'fixture', label: 'qa-user-1', reason: 'fixture sign-in' }, home);
    expect(pending.waiting).toBe(true);
    expect(JSON.stringify(pending)).not.toContain(secret);
    const notices = readFileSync(join(home, 'notifications.log'), 'utf8');
    expect(notices).toContain('fixture');
    expect(notices).toContain('qa-user-1');
    expect(notices).toContain('fixture sign-in');
    expect(notices).not.toContain(secret);
    const notice = notices.trim().split('\n').map((line) => JSON.parse(line) as { url?: string }).at(-1);
    const url = new URL(notice?.url ?? '');
    const token = url.searchParams.get('token') ?? '';
    const missing = await fetch('http://127.0.0.1:7781/requests');
    expect(missing.status).toBe(403);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('qa-user-1');
    expect(html).not.toContain(secret);
    const denied = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ site: 'https://example.com/', username: 'qa1@example.test', password: secret, decision: 'save' }),
    });
    expect(denied.status).toBe(400);
    expect(await denied.text()).not.toContain(secret);
    const touch = await fetch(`${url.origin}${url.pathname}?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ site: 'http://127.0.0.1:4173/', username: 'qa1@example.test', password: secret, decision: 'save' }),
    });
    const touchBody = await touch.text();
    expect(touchBody).not.toContain(secret);
    expect([200, 401]).toContain(touch.status);
    const reused = await fetch(`${url.origin}${url.pathname}?token=${token}`, { method: 'POST', body: 'decision=save' });
    expect(reused.status).toBe(403);
    if (touch.status === 401) {
      const captured = readFileSync(log, 'utf8');
      expect(captured).toMatch(/Authentication canceled|Touch ID|not available|not confirmed|ETIMEDOUT/i);
      const evidence = process.env.AEGIS_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, 'touchid.log'), captured);
      }
    }
    const stored = hornet(['creds', 'add', 'fixture', 'qa-user-1', '--json'], `qa1@example.test\n${secret}\n`);
    expect(stored.status, stored.stdout + stored.stderr).toBe(0);
    expect(stored.stdout).not.toContain(secret);
    const status = hornet(['credential-status', '--id', pending.id, '--json']);
    const body = JSON.parse(status.stdout) as { status?: string; waiting?: boolean };
    expect(body.status).toBe('ready');
    const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', 'examples/journeys/consistencyhub/01-signin-dashboard.journey.yaml']);
    expect(run.status, run.stdout).toBe(0);
    expect(readRun().result.users).toBeTruthy();
    const phase = (readRun().result.users as { phase1: { status: string } }[])[0]?.phase1.status;
    expect(phase).toBe('pass');
    expect(readFileSync(join(home, 'audit.log'), 'utf8')).not.toContain(secret);
  });
});
