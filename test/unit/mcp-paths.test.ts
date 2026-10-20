import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { buildPackagesIfStale } from '../support/build-packages.ts';

const root = join(import.meta.dirname, '..', '..');
const mcp = join(root, 'packages/mcp-server/dist/main.js');

type ToolBody = { ok?: boolean; reason?: string; error?: string; valid?: boolean; errors?: string[] };

describe('agents name journeys and projects by id only', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-mcp-paths-'));
  // A file outside the project that a path-shaped journey id would point at.
  const outside = join(home, 'outside.journey.yaml');
  let first: Client;
  let second: Client;

  beforeAll(async () => {
    buildPackagesIfStale(['@hornet-swarm/mcp-server']);
    writeFileSync(outside, 'version: 1\nid: outside\nsecret_marker: do-not-echo\n');
    mkdirSync(join(home, 'projects', 'paths'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, 'projects', 'paths', 'project.yaml'),
      `id: paths
name: Paths
authorisation_id: paths-owner
environment: test
targets: { base_url: "http://127.0.0.1:4173", allowed_origins: ["http://127.0.0.1:4173"] }
auth:
  signin_url: /login
  selectors: { username: "#email", password: "#password", submit: "#submit" }
  success: [{ type: url_contains, value: /dashboard }]
runners: {}
limits: { max_parallel_runners: 1 }
users:
  - { label: qa-user-1, role: r, tenant: a }
  - { label: qa-user-2, role: r, tenant: b }
`,
    );
    first = await openSession(home);
    second = await openSession(home);
  }, 120_000);

  afterAll(async () => {
    await first?.close();
    await second?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses a path in run_suite, run_journey, and validate_journey without reading it', async () => {
    for (const journeys of [[outside], ['../../outside'], ['ok-id', 'x/y']]) {
      const body = await call(first, 'run_suite', { project: 'paths', journeys });
      expect(body.ok, JSON.stringify(journeys)).toBe(false);
      expect(body.error).toContain('not a journey id');
    }
    const ran = await call(first, 'run_journey', { project: 'paths', journey_id: outside });
    expect(ran.error).toContain('not a path');
    const validated = await call(first, 'validate_journey', { project: 'paths', journey_id: outside });
    expect(validated.ok).toBe(false);
    expect(JSON.stringify(validated)).not.toContain('do-not-echo');
  }, 30_000);

  it('refuses a project id that is a path on every tool that takes one', async () => {
    const tools: Array<[string, Record<string, unknown>]> = [
      ['list_test_users', {}],
      ['run_signin_check', {}],
      ['run_suite', {}],
      ['validate_journey', { journey_yaml: 'version: 1' }],
      ['acquire_test_user', { label: 'qa-user-1' }],
      ['release_test_user', {}],
      ['get_swarm', {}],
      ['request_credentials', { label: 'qa-user-1', reason: 'r' }],
      ['add_agent_note', { label: 'qa-user-1', note: 'n' }],
      ['get_reliability', {}],
      ['check_findings', { findings: [{}] }],
      ['inspect_page', { label: 'qa-user-1', url: '/login' }],
    ];
    for (const [tool, args] of tools) {
      const body = await call(first, tool, { project: '../outside', ...args });
      expect(body.ok, tool).toBe(false);
      expect(body.error, tool).toBe('Unknown project.');
    }
  }, 30_000);

  it('refuses an inspection for a label that is not a test account, or one with no stored login', async () => {
    const badLabel = await call(first, 'inspect_page', { project: 'paths', label: 'admin', url: '/login' });
    expect(badLabel.error).toBe('label must look like qa-user-1');
    const noLogin = await call(first, 'inspect_page', { project: 'paths', label: 'qa-user-1', url: '/login', sign_in: true });
    expect(noLogin.ok).toBe(false);
    expect(noLogin.error).toContain('qa-user-1 has no stored login. Pass sign_in: false');
    const unknown = await call(first, 'inspect_page', { project: 'paths', label: 'qa-user-9', url: '/login', sign_in: false });
    expect(unknown.error).toBe('Unknown label qa-user-9.');
  }, 30_000);

  it('holds a second agent back while the project already has max_parallel_runners logins in use', async () => {
    const held = await call(first, 'acquire_test_user', { project: 'paths', label: 'qa-user-1' });
    expect(held.ok).toBe(true);
    const refused = await call(second, 'acquire_test_user', { project: 'paths', label: 'qa-user-2' });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('parallel_limit');
    await call(first, 'release_test_user', { project: 'paths' });
    const granted = await call(second, 'acquire_test_user', { project: 'paths', label: 'qa-user-2' });
    expect(granted.ok).toBe(true);
    await call(second, 'release_test_user', { project: 'paths' });
  }, 30_000);
});

describe('a fresh MCP server serves the current journey rules and reliability split', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-mcp-fresh-'));
  let client: Client;

  beforeAll(async () => {
    mkdirSync(join(home, 'projects', 'shop'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, 'projects', 'shop', 'project.yaml'),
      `id: shop
name: Shop
authorisation_id: shop-owner
environment: test
targets: { base_url: "http://127.0.0.1:3010", allowed_origins: ["http://127.0.0.1:3010"] }
auth:
  signin_url: /login
  selectors: { username: "#email", password: "#password", submit: "#submit" }
  success: [{ type: url_contains, value: /account }]
runners: {}
limits: { max_parallel_runners: 1 }
users:
  - { label: qa-user-1, role: r, tenant: a, vars: { first_name: Dev } }
`,
    );
    // Two runs without chaos and one with it.
    const write = (id: string, status: 'pass' | 'fail', chaos: boolean) => {
      const dir = join(home, 'runs', id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(dir, 'run.json'),
        JSON.stringify({
          schema_version: '1',
          run_id: id,
          project: 'shop',
          started_at: `2026-10-14T0${id.slice(-1)}:00:00Z`,
          status: status === 'pass' ? 'passed' : 'failed',
          gate: 'per_user',
          gate_passed: true,
          totals: { users: 1, journeys: 1, steps: 1, passed: 1, failed: 0, skipped: 0 },
          users: [{ label: 'qa-user-1', phase1: { status: 'pass', duration_ms: 500 }, journeys: [{ id: 'contact', status, duration_ms: 900, steps: [] }] }],
          environment: 'test',
          authorisation_id: 'shop-owner',
          redaction: 'pass',
        }),
      );
      writeFileSync(join(dir, 'analysis.json'), JSON.stringify({ chaos: chaos ? { profile: 'default', seed: 's', actions: [] } : null }));
    };
    write('run_1', 'pass', false);
    write('run_2', 'pass', false);
    write('run_3', 'fail', true);
    // An owner authorisation that does not list chaos, with its signed statement.
    const statement = 'Test statement: shop owner allows sign-in and journeys, not chaos.\n';
    mkdirSync(join(home, 'authorisations', 'docs'), { recursive: true, mode: 0o700 });
    const doc = join(home, 'authorisations', 'docs', 'shop-owner.txt');
    writeFileSync(doc, statement);
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    writeFileSync(
      join(home, 'authorisations', 'shop-owner.yaml'),
      `id: shop-owner
basis: owner
client: Test shop
authoriser: { name: Test Owner, role: Owner, email: owner@example.com }
granted_to: Test runner
scope: { domains: [localhost], environments: [test] }
activities: [signin_smoke, functional_e2e]
valid_from: "${day(-1)}"
valid_until: "${day(30)}"
document: { path: "${doc}", sha256: "${createHash('sha256').update(statement).digest('hex')}" }
`,
    );
    client = await openSession(home);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('accepts a select step and a field_value assertion', async () => {
    const journey = [
      'version: 1',
      'id: profile-check',
      'name: Profile',
      'users: [qa-user-1]',
      'steps:',
      '  - navigate: { url: "/profile" }',
      '  - select: { selector: "#country", label: "Australia" }',
      '  - assert: { type: field_value, selector: "#first-name", value: "{{self.vars.first_name}}" }',
    ].join('\n');
    const body = await call(client, 'validate_journey', { project: 'shop', journey_yaml: journey });
    expect(body.valid, JSON.stringify(body)).toBe(true);
  }, 30_000);

  it('refuses an unknown chaos profile before anything runs', async () => {
    const result = await client.callTool({ name: 'run_suite', arguments: { project: 'shop', chaos: { profile: 'earthquake', seed: 'x' } } });
    const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find((entry) => entry.type === 'text')?.text ?? '';
    expect(result.isError, text).toBe(true);
    expect(text).toMatch(/profile/i);
  }, 30_000);

  it('refuses chaos when the authorisation does not list it', async () => {
    for (const tool of ['run_suite', 'run_journey']) {
      const args = tool === 'run_suite' ? { project: 'shop', chaos: { profile: 'latency', seed: 'shop-1' } } : { project: 'shop', journey_id: 'any', chaos: { profile: 'latency', seed: 'shop-1' } };
      const body = await call(client, tool, args);
      expect(body.ok, tool).toBe(false);
      expect(body.error, tool).toContain('chaos_not_authorised');
    }
  }, 30_000);

  it('leaves the chaos run out of get_reliability, and counts only it with chaos: true', async () => {
    const normal = (await call(client, 'get_reliability', { project: 'shop' })) as ToolBody & { runs?: number; journeys?: { pass_rate: number | null }[]; last_run?: string };
    expect(normal.runs).toBe(2);
    expect(normal.journeys?.[0]?.pass_rate).toBe(1);
    const chaos = (await call(client, 'get_reliability', { project: 'shop', chaos: true })) as ToolBody & { runs?: number; journeys?: { pass_rate: number | null }[] };
    expect(chaos.runs).toBe(1);
    expect(chaos.journeys?.[0]?.pass_rate).toBe(0);
  }, 30_000);
});

async function openSession(home: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.AEGIS_HOME = home;
  const client = new Client({ name: 'hornet-mcp-paths', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcp], cwd: root, env }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolBody> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find((entry) => entry.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as ToolBody;
}
