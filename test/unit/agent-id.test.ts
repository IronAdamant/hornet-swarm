import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const root = join(import.meta.dirname, '..', '..');
const mcp = join(root, 'packages/mcp-server/dist/main.js');
const cli = join(root, 'packages/cli/dist/main.js');

type Lease = { agentId: string; label: string; project: string };
type ToolBody = { ok?: boolean; reason?: string; error?: string; agent_id?: string };

describe('agent identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-agent-id-'));
  let firstSession: Client;
  let secondSession: Client;

  beforeAll(async () => {
    execFileSync('pnpm', ['--filter', '@hornet-swarm/mcp-server', '--filter', '@hornet-swarm/cli', 'build'], {
      cwd: root,
      stdio: 'inherit',
    });
    writeLeaseProject(home);
    firstSession = await openSession(home);
    secondSession = await openSession(home);
  }, 120_000);

  afterAll(async () => {
    await firstSession?.close();
    await secondSession?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses a second session the first session id and leaves that lease in place', async () => {
    const first = await sessionCall(firstSession, 'acquire_test_user', { project: 'fixture', label: 'qa-user-1' });
    expect(first.ok).toBe(true);
    expect(first.agent_id).toMatch(/^mcp-[0-9a-f]{32}$/);

    const stolen = await sessionCall(secondSession, 'acquire_test_user', {
      project: 'fixture',
      label: 'qa-user-1',
      agent_id: first.agent_id,
    });
    expect(stolen.ok).toBe(false);
    expect(stolen.error).toContain('another session');
    expect(stolen.agent_id).not.toBe(first.agent_id);

    const released = await sessionCall(secondSession, 'release_test_user', {
      project: 'fixture',
      agent_id: first.agent_id,
    });
    expect(released.ok).toBe(false);
    expect(released.error).toContain('another session');
    expect(leases(home)).toEqual([expect.objectContaining({ agentId: first.agent_id, label: 'qa-user-1', project: 'fixture' })]);

    const signin = await sessionCall(secondSession, 'run_signin_check', {
      project: 'fixture',
      agent_id: first.agent_id,
    });
    expect(signin.ok).toBe(false);
    expect(signin.error).toContain('another session');
    expect(leases(home).some((lease) => lease.agentId === first.agent_id && lease.label === 'qa-user-1')).toBe(true);

    const secondLabel = await sessionCall(firstSession, 'acquire_test_user', { project: 'fixture', label: 'qa-user-2' });
    expect(secondLabel.ok).toBe(false);
    expect(secondLabel.reason).toBe('agent_already_holds');

    const busy = await sessionCall(secondSession, 'acquire_test_user', { project: 'fixture', label: 'qa-user-1' });
    expect(busy.ok).toBe(false);
    expect(busy.reason).toBe('busy');
    expect(busy.agent_id).toMatch(/^mcp-/);
    expect(busy.agent_id).not.toBe(first.agent_id);

    const other = await sessionCall(secondSession, 'acquire_test_user', { project: 'fixture', label: 'qa-user-2' });
    expect(other.ok).toBe(true);
    expect(other.agent_id).toBe(busy.agent_id);

    const renewed = await sessionCall(firstSession, 'acquire_test_user', {
      project: 'fixture',
      label: 'qa-user-1',
      agent_id: first.agent_id,
    });
    expect(renewed.ok).toBe(true);

    await sessionCall(firstSession, 'release_test_user', { project: 'fixture' });
    await sessionCall(secondSession, 'release_test_user', { project: 'fixture' });
    expect(leases(home)).toEqual([]);
  });

  it('gives a CLI process its own id and refuses another process id', () => {
    const cliHome = mkdtempSync(join(tmpdir(), 'hornet-agent-cli-'));
    try {
      const own = runCli(cliHome, ['sign-in', '--project', 'missing-project', '--json']);
      expect(own.status).not.toBe(0);
      const ownBody = JSON.parse(own.stdout) as { ok: boolean; error: string; agent_id: string };
      expect(ownBody.ok).toBe(false);
      expect(ownBody.agent_id).toBe(`cli-${own.pid}`);

      const foreign = runCli(cliHome, ['sign-in', '--project', 'missing-project', '--json', '--agent-id', ownBody.agent_id]);
      expect(foreign.status).toBe(3);
      const foreignBody = JSON.parse(foreign.stdout) as { ok: boolean; error: string };
      expect(foreignBody.ok).toBe(false);
      expect(foreignBody.error).toContain('another process');

      const invented = runCli(cliHome, ['sign-in', '--project', 'missing-project', '--json', '--agent-id', 'cli-1']);
      expect(invented.status).toBe(3);
      expect(JSON.parse(invented.stdout).error).toContain('another process');
    } finally {
      rmSync(cliHome, { recursive: true, force: true });
    }
  });
});

/** acquire_test_user reads the project's runner cap, so the leases need a project to belong to. */
function writeLeaseProject(home: string): void {
  mkdirSync(join(home, 'projects', 'fixture'), { recursive: true });
  writeFileSync(
    join(home, 'projects', 'fixture', 'project.yaml'),
    `id: fixture
name: Fixture
authorisation_id: fixture-owner
environment: test
targets:
  base_url: http://127.0.0.1:4173
  allowed_origins: [http://127.0.0.1:4173]
auth:
  signin_url: /login
  selectors: { username: "#email", password: "#password", submit: "#submit" }
  success: [{ type: url_contains, value: /dashboard }]
runners: {}
limits: { max_parallel_runners: 2 }
users:
  - { label: qa-user-1, role: consultant, tenant: A1 }
  - { label: qa-user-2, role: consultant, tenant: B1 }
`,
  );
}

function leases(home: string): Lease[] {
  return JSON.parse(readFileSync(join(home, 'leases.json'), 'utf8')) as Lease[];
}

function runCli(home: string, args: string[]): { status: number | null; stdout: string; pid: number } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: childEnv(home),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, pid: result.pid ?? -1 };
}

async function openSession(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcp],
    cwd: root,
    env: childEnv(home),
  });
  const client = new Client({ name: 'hornet-agent-id', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

async function sessionCall(client: Client, name: string, args: Record<string, unknown>): Promise<ToolBody> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((entry) => entry.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as ToolBody;
}

function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.AEGIS_HOME = home;
  return env;
}
