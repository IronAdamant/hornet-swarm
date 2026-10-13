import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redactor } from '../../packages/core/src/redactor.ts';
import { listFields, registerProjectSecrets } from '../../packages/controller/src/broker.ts';
import { startCredentialPage, storeOwnerLogin } from '../../packages/controller/src/credentials.ts';

const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'packages/cli/dist/main.js');
const SHORT_SECRET_ERROR = 'That secret is too short. It must be at least 8 characters.';

describe('short credentials', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-short-secret-'));
  let port = 0;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    execFileSync('pnpm', ['--filter', '@hornet-swarm/core', 'build'], { cwd: root, stdio: 'inherit' });
    execFileSync('pnpm', ['--filter', '@hornet-swarm/controller', 'build'], { cwd: root, stdio: 'inherit' });
    execFileSync('pnpm', ['--filter', '@hornet-swarm/cli', 'build'], { cwd: root, stdio: 'inherit' });
    const page = await startCredentialPage(home, 0);
    port = page.port;
    close = page.close;
  }, 120_000);

  afterAll(async () => {
    await close?.();
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses a short password on the request page and stores nothing', async () => {
    const response = await postLogin(port, home, { username: 'username', password: '1234567' });
    expect(response.status).toBe(400);
    expect(response.body).toBe(SHORT_SECRET_ERROR);
    expect(existsSync(join(home, 'projects', 'fixture', 'secrets.sops.yaml'))).toBe(false);
    expect(response.body).not.toContain('1234567');
    const requests = JSON.parse(readFileSync(join(home, 'credential-requests.json'), 'utf8')) as { tokenUsed: boolean }[];
    expect(requests.every((entry) => entry.tokenUsed === false)).toBe(true);
  });

  it('refuses a short one-time secret on the request page and stores nothing', async () => {
    const response = await postLogin(port, home, { username: 'username', password: 'password', totp: '1234567' });
    expect(response.status).toBe(400);
    expect(response.body).toBe(SHORT_SECRET_ERROR);
    expect(existsSync(join(home, 'projects', 'fixture', 'secrets.sops.yaml'))).toBe(false);
  });

  it('does not call an 8 character login too short', async () => {
    const response = await postLogin(port, home, { username: 'username', password: 'password' });
    expect(response.body).not.toBe(SHORT_SECRET_ERROR);
    expect(existsSync(join(home, 'projects', 'fixture', 'secrets.sops.yaml'))).toBe(false);
  });

  it('refuses a short password from creds add and stores nothing', () => {
    const cliHome = mkdtempSync(join(tmpdir(), 'hornet-short-cli-'));
    try {
      const short = runCli(cliHome, 'username\n1234567\n');
      expect(short.status).toBe(3);
      const body = JSON.parse(short.stdout) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe(SHORT_SECRET_ERROR);
      expect(existsSync(join(cliHome, 'projects', 'fixture', 'secrets.sops.yaml'))).toBe(false);

      const longEnough = runCli(cliHome, 'username\npassword\n');
      const longBody = JSON.parse(longEnough.stdout) as { ok: boolean; error: string };
      expect(longBody.error).not.toBe(SHORT_SECRET_ERROR);
      expect(existsSync(join(cliHome, 'projects', 'fixture', 'secrets.sops.yaml'))).toBe(false);
    } finally {
      rmSync(cliHome, { recursive: true, force: true });
    }
  });

  it('refuses a short login before storeOwnerLogin writes anything', () => {
    expect(() => storeOwnerLogin('fixture', 'qa-user-1', 'username', '1234567', undefined, home)).toThrow(SHORT_SECRET_ERROR);
    expect(() => storeOwnerLogin('fixture', 'qa-user-1', 'username', 'password', '1234567', home)).toThrow(SHORT_SECRET_ERROR);
    expect(existsSync(join(home, 'projects', 'fixture', 'secrets.sops.yaml'))).toBe(false);
  });

  it('stores a short username from the request page and redacts it', async () => {
    writeAuthorisedProject(home);
    const username = 'ab';
    const touch = allowTouchId();
    try {
      const response = await postLogin(port, home, { username, password: 's3cret-ok', site: 'http://127.0.0.1:4173/login' });
      expect(response.status).toBe(200);
      expect(response.body).toBe('Saved. You can close this page.');
      expect(storedUsernameIsRedacted(home, username)).toBe(true);
      expect(listFields('fixture', 'qa-user-1', home).sort()).toEqual(['password', 'username']);
    } finally {
      touch.restore();
    }
  });

  it('stores a username shorter than 4 characters from creds add and redacts it', () => {
    const cliHome = mkdtempSync(join(tmpdir(), 'hornet-short-user-'));
    const username = 'q';
    try {
      writeAuthorisedProject(cliHome);
      const stored = runCli(cliHome, `${username}\ns3cret-ok\n`);
      expect(stored.status).toBe(0);
      expect(storedUsernameIsRedacted(cliHome, username)).toBe(true);
      expect(existsSync(join(cliHome, 'projects', 'fixture', 'secrets.sops.yaml'))).toBe(true);
    } finally {
      rmSync(cliHome, { recursive: true, force: true });
    }
  });
});

async function postLogin(
  port: number,
  home: string,
  fields: { username: string; password: string; totp?: string; token?: string; site?: string },
): Promise<{ status: number; body: string }> {
  const token = fields.token ?? createRequest(home);
  const body = new URLSearchParams({ username: fields.username, password: fields.password, totp: fields.totp ?? '' });
  if (fields.site) body.set('site', fields.site);
  const response = await fetch(`http://127.0.0.1:${port}/requests?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { status: response.status, body: await response.text() };
}

function createRequest(home: string): string {
  const token = `token-${randomUUID()}`;
  const record = {
    id: randomUUID(),
    project: 'fixture',
    label: 'qa-user-1',
    reason: 'length check',
    status: 'pending',
    createdAt: Date.now(),
    tokenHash: createHash('sha256').update(token).digest('hex'),
    tokenUsed: false,
  };
  const file = join(home, 'credential-requests.json');
  const current = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown[]) : [];
  current.push(record);
  writeFileSync(file, `${JSON.stringify(current)}\n`);
  return token;
}

function runCli(home: string, input: string): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [cli, 'creds', 'add', 'fixture', 'qa-user-1', '--json'], {
    cwd: root,
    env: childEnv(home),
    input,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout };
}

function storedUsernameIsRedacted(home: string, username: string): boolean {
  const redactor = new Redactor();
  registerProjectSecrets('fixture', redactor, home);
  const sentence = `login ${username} here`;
  return redactor.redact(sentence) === 'login [REDACTED:qa-user-1.username] here';
}

function allowTouchId(): { restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hornet-swift-'));
  writeFileSync(join(dir, 'swift'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'swift'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previous ?? ''}`;
  return {
    restore: () => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    },
  };
}

function writeAuthorisedProject(home: string): void {
  const projectDir = join(home, 'projects', 'fixture');
  mkdirSync(join(home, 'authorisations'), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const documentBody = 'Fixture owner authorisation for the offline test app.\n';
  writeFileSync(join(home, 'authorisations', 'fixture-owner.txt'), documentBody);
  const documentHash = createHash('sha256').update(documentBody).digest('hex');
  writeFileSync(join(home, 'authorisations', 'fixture-owner.yaml'), `id: fixture-owner
basis: owner
client: Iron Adamant (self-owned)
authoriser:
  name: Aron Amos
  role: Owner
  email: aron.amos@ironadamant.com
granted_to: Aron Amos (Iron Adamant)
scope:
  domains: [localhost, host.docker.internal]
  environments: [test]
activities: [signin_smoke]
exclusions: []
valid_from: "2026-01-01"
valid_until: "2027-12-31"
document:
  path: fixture-owner.txt
  sha256: "${documentHash}"
notes: Local fixture only.
`);
  writeFileSync(join(projectDir, 'project.yaml'), `id: fixture
name: Fixture
authorisation_id: fixture-owner
environment: test
targets:
  base_url: http://127.0.0.1:4173
  allowed_origins:
    - http://127.0.0.1:4173
  allowed_third_party: []
auth:
  signin_url: /login
  selectors:
    username: "#email"
    password: "#password"
    submit: "role=button[name='Sign in']"
  success:
    - { type: url_contains, value: "/dashboard" }
  auth_endpoints: ["**/login"]
  totp:
    enabled: false
runners:
  count: 1
  memory: 1g
  cpus: 1
limits:
  max_parallel_runners: 1
  max_requests_per_second_per_runner: 5
  max_requests_per_second_total: 20
  min_step_delay_ms: 50
  max_run_duration_min: 30
  max_signin_attempts_per_user_per_hour: 30
phase2:
  gate: all
journeys_dir: ./journeys
users:
  - { label: qa-user-1, role: consultant, tenant: A1, vars: { tenant_slug: a1 } }
`);
}

function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.AEGIS_HOME = home;
  return env;
}
