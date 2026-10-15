import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { setSecret } from '../../packages/controller/dist/index.js';
import { validateJourneyYaml, projectSchema } from '../../packages/core/dist/index.js';
import { parse } from 'yaml';
import { totpCode } from '../../packages/controller/src/totp.ts';
import { hornet, clearSignins, cli, home, journeys, latestRun, localDocumentHash, readRun, resetFixture, root, secret } from './helper.js';

const projectFile = join(home, 'projects/fixture/project.yaml');

beforeAll(() => {
  clearSignins();
});

describe('phase gate and safety', () => {
  it('skips later checks when sign-in fails', () => {
    setSecret('fixture', 'qa-user-1', 'password', 'wrong-password-value', home);
    try {
      const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
      expect(run.status).toBe(1);
      const report = readRun();
      const users = report.result.users as { phase1: { status: string }; journeys: { status: string }[] }[];
      expect(users[0]?.phase1.status).not.toBe('pass');
      expect(users[0]?.journeys.every((journey) => journey.status === 'skipped')).toBe(true);
      expect(report.summary.toLowerCase()).toContain('sign-in');
    } finally {
      setSecret('fixture', 'qa-user-1', 'password', secret, home);
    }
  });

  it('does not treat a hidden six-digit field as a second factor', async () => {
    const login = await fetch('http://127.0.0.1:4173/login');
    const html = await login.text();
    expect(html).toContain('maxlength="6"');
    expect(html).toContain('hidden');
    const run = hornet(['sign-in', '--project', 'fixture', '--json', '--user', 'qa-user-1']);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  it('rejects a journey that pastes a stored password', () => {
    const file = join(journeys, 'pasted-secret.journey.yaml');
    writeFileSync(
      file,
      `version: 1
id: pasted-secret
name: Pasted secret
users: [qa-user-1]
requires_phase1: false
tags: []
vars: {}
retries: 0
steps:
  - fill: { selector: "#email", value: ${JSON.stringify(secret)} }
`,
    );
    try {
      const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', file]);
      expect(run.status, run.stdout + run.stderr).toBe(3);
      expect(run.stdout + run.stderr).toContain('stored secret');
      expect(run.stdout + run.stderr).not.toContain(secret);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('rejects a screenshot name that contains a stored secret', () => {
    const file = join(journeys, 'screenshot-secret.journey.yaml');
    writeFileSync(
      file,
      `version: 1
id: screenshot-secret
name: Screenshot secret
users: [qa-user-1]
requires_phase1: false
tags: []
vars: {}
retries: 0
steps:
  - screenshot: { name: ${JSON.stringify(secret)} }
`,
    );
    try {
      const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', file]);
      expect(run.status, run.stdout + run.stderr).toBe(3);
      expect(run.stdout + run.stderr).toContain('stored secret');
      expect(run.stdout + run.stderr).not.toContain(secret);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('blocks a journey that leaves the allowlist', () => {
    const project = projectSchema.parse(parse(readFileSync(projectFile, 'utf8')));
    const checked = validateJourneyYaml('version: 1\nid: bad\nname: Bad\nusers: [qa-user-1]\nsteps:\n  - navigate: { url: "https://example.com/" }\n', project);
    expect(checked.valid).toBe(false);
    const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'off-allowlist.journey.yaml')]);
    expect(run.status).toBe(2);
    const report = readRun();
    const text = JSON.stringify(report.result);
    expect(text).toContain('allowlist');
  });

  it('refuses a domain with no active authorisation', () => {
    writeMiniProject('unauth', 'https://not-allowed.example', ['localhost'], ['test']);
    const run = hornet(['suite', '--project', 'unauth', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
    expect(run.status).toBe(3);
    expect(run.stdout + run.stderr).toContain('domain_not_authorised');
  });

  it('refuses a production-looking host unless the record and the flag both allow it', () => {
    writeMiniProject('prodlook', 'https://app.invalid', ['app.invalid'], ['test']);
    const refused = hornet(['suite', '--project', 'prodlook', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
    expect(refused.status).toBe(3);
    expect(refused.stdout + refused.stderr).toContain('production_not_authorised');
    writeMiniProject('prodlook', 'https://app.invalid', ['app.invalid'], ['test', 'production'], 'production');
    const unconfirmed = hornet(['suite', '--project', 'prodlook', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
    expect(unconfirmed.status).toBe(3);
    expect(unconfirmed.stdout + unconfirmed.stderr).toContain('production_confirmation_required');
    const confirmed = hornet(['suite', '--project', 'prodlook', '--confirm-production', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
    expect(confirmed.status).not.toBe(3);
    expect(confirmed.stdout + confirmed.stderr).not.toContain('production_confirmation_required');
  });

  it('stops a live run within five seconds of the kill switch', async () => {
    const child = spawn(process.execPath, [cli, 'suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'kill-wait.journey.yaml')], { cwd: root });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const started = Date.now();
    writeFileSync(join(home, 'KILL'), 'stop\n');
    const code = await new Promise<number>((resolve) => child.on('exit', (status) => resolve(status ?? 1)));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(code).toBe(2);
    expect(output).not.toContain(secret);
    const released = hornet(['kill', '--release', '--json']);
    expect(released.status).toBe(0);
    const up = hornet(['env', 'up', '--project', 'fixture', '--count', '1', '--json']);
    expect(up.status, up.stdout + up.stderr).toBe(0);
  });

  it('stops on a human check and on a second code, and can fill an owner code', async () => {
    const captcha = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'captcha.journey.yaml')]);
    expect(captcha.status).toBe(2);
    expect(JSON.stringify(readRun().result)).toContain('captcha');
    // The run cap stays at 30 minutes. A 12 second cap expired while a runner was still queued and
    // the result was duration instead of a second code. The owner is only asked for 2 seconds, so
    // the suite returns as soon as the page is seen.
    const original = readFileSync(projectFile, 'utf8');
    writeFileSync(projectFile, withOperatorWait(original, 2));
    try {
      const otp = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'otp.journey.yaml')]);
      expect(otp.status, otp.stdout + otp.stderr).toBe(2);
      expect(JSON.stringify(readRun().result)).toContain('2fa');
      const smsBefore = (await fetch('http://127.0.0.1:4173/__admin/stats').then((response) => response.json())) as { smsPosts: number };
      const sms = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'sms.journey.yaml')]);
      expect(sms.status).toBe(2);
      expect(JSON.stringify(readRun().result)).toContain('2fa');
      const smsAfter = (await fetch('http://127.0.0.1:4173/__admin/stats').then((response) => response.json())) as { smsPosts: number };
      expect(smsAfter.smsPosts).toBe(smsBefore.smsPosts);

      setSecret('fixture', 'qa-user-1', 'totp_secret', 'JBSWY3DPEHPK3PXP', home);
      const totpProject = original.replace('enabled: false', 'enabled: true').replace('signin_url: /login', 'signin_url: /login?totp=1');
      writeFileSync(projectFile, withOperatorWait(totpProject, 2));
      await resetFixture({ user1: { totp: 'JBSWY3DPEHPK3PXP' } });
      const totp = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'totp.journey.yaml')]);
      expect(totp.status, totp.stdout + totp.stderr).toBe(0);
      expect(JSON.stringify(readRun().result)).toContain('totp-fill');
      const stats = (await fetch('http://127.0.0.1:4173/__admin/stats').then((response) => response.json())) as { otpFilled: boolean };
      expect(stats.otpFilled).toBe(true);
      const harPath = findHar(latestRun());
      const har = readFileSync(harPath, 'utf8');
      const now = Date.now();
      const codes = [totpCode('JBSWY3DPEHPK3PXP', now), totpCode('JBSWY3DPEHPK3PXP', now - 30_000), totpCode('JBSWY3DPEHPK3PXP', now + 30_000)];
      if (codes.some((code) => har.includes(code))) throw new Error('The one-time code was still present');
      const prompted = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'otp.journey.yaml')]);
      expect(prompted.status).toBe(2);
      expect(JSON.stringify(readRun().result)).toContain('2fa');
    } finally {
      writeFileSync(projectFile, original);
      await resetFixture();
    }
  });

  it('enforces the sign-in attempt limit', async () => {
    const original = readFileSync(projectFile, 'utf8');
    const statsBefore = await fetch('http://127.0.0.1:4173/__admin/stats').then((response) => response.json()) as { loginPosts: number };
    writeFileSync(projectFile, original.replace('max_signin_attempts_per_user_per_hour: 30', 'max_signin_attempts_per_user_per_hour: 1'));
    writeFileSync(join(home, 'projects/fixture/signin.json'), `${JSON.stringify([{ label: 'qa-user-1', at: Date.now() }])}\n`);
    try {
      const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
      expect(run.status).toBe(2);
      expect(JSON.stringify(readRun().result)).toContain('signin_limit');
      const statsAfter = await fetch('http://127.0.0.1:4173/__admin/stats').then((response) => response.json()) as { loginPosts: number };
      expect(statsAfter.loginPosts).toBe(statsBefore.loginPosts);
    } finally {
      writeFileSync(projectFile, original);
      clearSignins();
    }
  });
});

/** The default owner wait is 10 minutes. These checks only need the page to be classed as a second code. */
function withOperatorWait(yaml: string, seconds: number): string {
  if (/operator_code_wait_sec:/.test(yaml)) return yaml.replace(/operator_code_wait_sec:\s*\d+/, `operator_code_wait_sec: ${seconds}`);
  return yaml.replace(/^auth:\n/m, `auth:\n  operator_code_wait_sec: ${seconds}\n`);
}

function writeMiniProject(id: string, base: string, domains: string[], environments: string[], environment = 'test'): void {
  mkdirSync(join(home, 'authorisations'), { recursive: true });
  mkdirSync(join(home, 'projects', id), { recursive: true });
  writeFileSync(join(home, 'authorisations', `${id}.yaml`), `id: ${id}
basis: owner
client: self
authoriser: { name: Aron Amos, role: Owner, email: aron.amos@ironadamant.com }
granted_to: Aron Amos
scope:
  domains: [${domains.join(', ')}]
  environments: [${environments.join(', ')}]
activities: [signin_smoke, functional_e2e]
exclusions: []
valid_from: "2026-01-01"
valid_until: "2027-12-31"
document: { path: local.txt, sha256: "${localDocumentHash()}" }
`);
  writeFileSync(join(home, 'projects', id, 'project.yaml'), `id: ${id}
name: ${id}
authorisation_id: ${id}
environment: ${environment}
targets:
  base_url: ${base}
  allowed_origins: ["${base}"]
  allowed_third_party: []
auth:
  signin_url: /login
  selectors: { username: "#email", password: "#password", submit: "role=button[name='Sign in']" }
  success: [{ type: url_contains, value: "/dashboard" }]
  auth_endpoints: ["**/login"]
  totp: { enabled: false }
  access_denied_markers: ["access denied"]
runners: { count: 1, memory: 1g, cpus: 1 }
limits:
  max_parallel_runners: 1
  max_requests_per_second_per_runner: 5
  max_requests_per_second_total: 20
  min_step_delay_ms: 50
  max_run_duration_min: 30
  max_signin_attempts_per_user_per_hour: 5
phase2: { gate: all }
journeys_dir: ./journeys
users:
  - { label: qa-user-1, role: consultant, tenant: A1, vars: { tenant_slug: a1, owned_resource_id: res_a1_001 } }
`);
}

function findHar(dir: string): string {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === 'network.har') found.push(path);
    }
  };
  walk(dir);
  const har = found[0];
  if (!har) throw new Error('network.har was not written');
  return har;
}
