import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hornet, clearSignins, home, localDocumentHash, root, secret } from './helper.js';

beforeAll(() => {
  clearSignins();
  const dir = join(home, 'projects/fixture/journeys');
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, 'examples/journeys/example-app/01-signin-dashboard.journey.yaml'), join(dir, '01-signin-dashboard.journey.yaml'));
  cpSync(join(root, 'examples/journeys/example-app/02-tenant-isolation.journey.yaml'), join(dir, '02-tenant-isolation.journey.yaml'));
  cpSync(join(root, 'test/e2e/journeys/flag.journey.yaml'), join(dir, 'flag.journey.yaml'));
  cpSync(join(root, 'test/e2e/journeys/both-users.journey.yaml'), join(dir, 'both-users.journey.yaml'));
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
document: { path: local.txt, sha256: "${localDocumentHash()}" }
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
  hornet(['kill', '--release', '--json']);
  clearSignins();
  hornet(['env', 'up', '--project', 'fixture', '--count', '1', '--json']);
});

describe('MCP server', () => {
  it('calls every tool over stdio and keeps secrets out of the replies', () => {
    const stdout = execFileSync(process.execPath, [join(root, 'test/e2e/mcp-client.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 240_000,
    });
    expect(stdout).not.toContain(secret);
    const body = JSON.parse(stdout) as {
      users: { users: { label: string }[] };
      invalid: { valid: boolean };
      byId: { valid: boolean; errors: string[] };
      lease: { ok: boolean };
      second: { ok: boolean; reason?: string };
      released: { ok: boolean };
      passwordRejected: { ok: boolean; error?: string };
      missingAgent: { ok?: boolean; error?: string };
      leasesUnchanged: boolean;
      signin: { status: string; run_id: string };
      summary: { detail?: string; text?: string };
      full: { schema_version?: string };
      journey: { status: string; users: { journeys: { id: string; status: string }[] }[] };
      filtered: { status: string; users: { label: string }[] };
      suite: { status: string; parent?: { validation_required?: boolean; evidence_zip?: string; instruction?: string; summary?: string } };
      latest: { validation_required?: boolean; evidence_zip?: string; summary?: string; instruction?: string; run_id?: string };
      reset: { idempotent?: boolean; healthy?: number; expected?: number; durationMs?: number };
      blocked: { ok?: boolean; error?: string };
      killed: { killed?: boolean };
      killFileAfterEngage: boolean;
      afterKill: { ok?: boolean; error?: string };
      releasedKill: { released?: boolean; ok?: boolean; error?: string };
      killFileAfterRelease: boolean;
      subA: { ok: boolean; agent_id: string };
      subB: { ok: boolean; agent_id: string };
      subLeaseA: { ok: boolean; agent_id: string };
      subLeaseB: { ok: boolean; agent_id: string };
      resetWhileBusy: { ok?: boolean; error?: string };
      traversal: { ok?: boolean; error?: string };
      written: { status: string; users: { journeys: { id: string; status: string }[] }[] };
      writtenOffsite: { ok?: boolean; error?: string };
      reliability: { runs: number; signin: { attempts: number }; journeys: { id: string }[] };
      notes: { label: string; notes: unknown[] };
      hardReset: { ok?: boolean; error?: string };
    };
    expect(body.users.users.some((user) => user.label === 'qa-user-1')).toBe(true);
    expect(body.invalid.valid).toBe(false);
    expect(body.byId.valid).toBe(true);
    expect(body.byId.errors).toEqual([]);
    expect(body.lease.ok).toBe(true);
    expect(body.second.ok).toBe(false);
    expect(body.released.ok).toBe(true);
    expect(body.passwordRejected.ok).toBe(false);
    expect(body.passwordRejected.error ?? '').not.toContain('should-not-stick');
    expect(body.missingAgent.ok).toBe(false);
    expect(body.leasesUnchanged).toBe(true);
    expect(body.signin.status).toBe('passed');
    expect(body.signin.agent_id).toMatch(/^mcp-/);
    expect(readFileSync(join(home, 'audit.log'), 'utf8')).toContain(`"agent":"${body.signin.agent_id}"`);
    expect(body.summary.text ?? '').toContain('Findings');
    expect(body.summary.text ?? '').toContain('[REDACTED:qa-user-1.password]');
    expect(body.summary.text ?? '').not.toContain(secret);
    expect(body.full.schema_version).toBe('1.0.0');
    expect(body.journey.status).toBe('passed');
    expect(body.journey.users[0]?.journeys.some((journey) => journey.id === 'flag-check' && journey.status === 'pass')).toBe(true);
    expect(body.filtered.status).toBe('passed');
    expect(body.filtered.users.map((user) => user.label)).toEqual(['qa-user-1']);
    expect(JSON.stringify(body.journey)).not.toContain(secret);
    expect(body.suite.status).toBe('passed');
    expect(body.suite.parent?.validation_required).toBe(true);
    expect(body.suite.parent?.evidence_zip ?? '').toContain('evidence.zip');
    expect(body.suite.parent?.instruction ?? '').toContain('does not grade');
    expect(body.suite.parent?.summary ?? '').toContain('Findings');
    expect(body.latest.validation_required).toBe(true);
    expect(body.latest.run_id).toBeTruthy();
    expect(body.latest.evidence_zip ?? '').toContain('evidence.zip');
    expect(body.latest.summary ?? '').toContain('Findings');
    expect(JSON.stringify(body.latest)).not.toContain(secret);
    expect(body.reset.idempotent).toBe(true);
    expect(body.reset.healthy).toBe(body.reset.expected);
    expect(body.reset.durationMs ?? 0).toBeGreaterThan(0);
    expect(body.blocked.error ?? JSON.stringify(body.blocked)).toMatch(/domain_not_authorised|authorisation/);
    expect(body.killed.killed).toBe(true);
    expect(body.killFileAfterEngage).toBe(true);
    expect(body.afterKill.error ?? '').toContain('kill switch');
    expect(body.releasedKill.released).toBe(false);
    expect(body.releasedKill.error ?? '').toContain('Only the owner');
    expect(body.killFileAfterRelease).toBe(true);
    expect(body.hardReset.ok).toBe(false);
    expect(body.subA.agent_id).not.toBe(body.subB.agent_id);
    expect(body.subA.agent_id.startsWith(body.signin.agent_id)).toBe(true);
    expect(body.subLeaseA.ok).toBe(true);
    expect(body.subLeaseB.ok).toBe(true);
    expect(body.subLeaseA.agent_id).toBe(body.subA.agent_id);
    expect(body.resetWhileBusy.ok).toBe(false);
    expect(body.resetWhileBusy.error ?? '').toContain('qa-user-2');
    expect(body.traversal.ok).toBe(false);
    expect(body.written.status).toBe('passed');
    expect(body.written.users[0]?.journeys.map((journey) => journey.id)).toEqual(['agent-written-flag']);
    expect(body.writtenOffsite.error ?? '').toContain('blocked_by_allowlist');
    expect(body.reliability.runs).toBeGreaterThan(0);
    expect(body.reliability.signin.attempts).toBeGreaterThan(0);
    expect(Array.isArray(body.notes.notes)).toBe(true);
  });
});
