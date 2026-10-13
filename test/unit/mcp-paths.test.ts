import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

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
    execFileSync('pnpm', ['--filter', '@hornet-swarm/mcp-server', 'build'], { cwd: root, stdio: 'ignore' });
    writeFileSync(outside, 'version: 1\nid: outside\nsecret_marker: do-not-echo\n');
    mkdirSync(join(home, 'projects', 'paths'), { recursive: true });
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
    ];
    for (const [tool, args] of tools) {
      const body = await call(first, tool, { project: '../outside', ...args });
      expect(body.ok, tool).toBe(false);
      expect(body.error, tool).toBe('Unknown project.');
    }
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
