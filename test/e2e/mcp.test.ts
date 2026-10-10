import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aegis, clearSignins, home, root, secret } from './helper.js';

beforeAll(() => {
  clearSignins();
  const dir = join(home, 'projects/fixture/journeys');
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, 'examples/journeys/consistencyhub/01-signin-dashboard.journey.yaml'), join(dir, '01-signin-dashboard.journey.yaml'));
  cpSync(join(root, 'examples/journeys/consistencyhub/02-tenant-isolation.journey.yaml'), join(dir, '02-tenant-isolation.journey.yaml'));
  mkdirSync(join(home, 'authorisations'), { recursive: true });
  mkdirSync(join(home, 'projects/unauth'), { recursive: true });
  writeFileSync(join(home, 'authorisations/unauth.yaml'), `id: unauth
basis: owner
client: self
authoriser: { name: Aron Amos, role: Owner, email: aron.amos@ironadamant.com }
granted_to: Aron Amos
scope:
  domains: [localhost]
  environments: [test]
activities: [signin_smoke]
exclusions: []
valid_from: "2026-01-01"
valid_until: "2027-12-31"
document: { path: local.txt, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }
`);
  writeFileSync(join(home, 'projects/unauth/project.yaml'), `id: unauth
name: unauth
authorisation_id: unauth
environment: test
targets:
  base_url: https://not-allowed.example
  allowed_origins: ["https://not-allowed.example"]
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
  - { label: qa-user-1, role: consultant, tenant: A1, vars: {} }
`);
});

afterAll(() => {
  aegis(['kill', '--release', '--json']);
  clearSignins();
  aegis(['env', 'up', '--project', 'fixture', '--count', '1', '--json']);
});

describe('MCP server', () => {
  it('calls every tool over stdio and keeps secrets out of the replies', () => {
    const stdout = execFileSync(process.execPath, [join(root, 'test/e2e/mcp-client.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 180_000,
    });
    expect(stdout).not.toContain(secret);
    const body = JSON.parse(stdout) as {
      users: { users: { label: string }[] };
      invalid: { valid: boolean };
      lease: { ok: boolean };
      second: { ok: boolean; reason?: string };
      released: { ok: boolean };
      passwordRejected: { ok: boolean; error?: string };
      signin: { status: string; run_id: string };
      summary: { detail?: string; text?: string };
      full: { schema_version?: string };
      suite: { status: string };
      blocked: { ok?: boolean; error?: string };
      killed: { killed?: boolean };
      afterKill: { ok?: boolean; error?: string };
    };
    expect(body.users.users.some((user) => user.label === 'qa-user-1')).toBe(true);
    expect(body.invalid.valid).toBe(false);
    expect(body.lease.ok).toBe(true);
    expect(body.second.ok).toBe(false);
    expect(body.released.ok).toBe(true);
    expect(body.passwordRejected.ok).toBe(false);
    expect(body.passwordRejected.error ?? '').not.toContain('should-not-stick');
    expect(body.signin.status).toBe('passed');
    expect(body.summary.text ?? '').toContain('Findings');
    expect(body.summary.text ?? '').not.toContain(secret);
    expect(body.full.schema_version).toBe('1.0.0');
    expect(body.suite.status).toBe('passed');
    expect(body.blocked.error ?? JSON.stringify(body.blocked)).toMatch(/domain_not_authorised|authorisation/);
    expect(body.killed.killed).toBe(true);
    expect(body.afterKill.error ?? '').toContain('kill switch');
  });
});
