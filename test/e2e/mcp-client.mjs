import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const root = join(import.meta.dirname, '..', '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'packages/mcp-server/dist/main.js')],
  cwd: root,
});
const client = new Client({ name: 'hornet-swarm-e2e', version: '0.1.0' });
await client.connect(transport);
const output = {};
output.users = await call('list_test_users', { project: 'fixture' });
output.invalid = await call('validate_journey', {
  project: 'fixture',
  journey_yaml: 'version: 1\nid: bad\nname: Bad\nusers: [qa-user-1]\nsteps:\n  - navigate: { url: "https://example.com/" }\n',
});
output.byId = await call('validate_journey', { project: 'fixture', journey_id: 'signin-dashboard' });
output.lease = await call('acquire_test_user', { project: 'fixture', label: 'qa-user-1', agent_id: 'mcp-e2e' });
output.second = await call('acquire_test_user', { project: 'fixture', label: 'qa-user-2', agent_id: 'mcp-e2e' });
output.released = await call('release_test_user', { project: 'fixture', agent_id: 'mcp-e2e' });
output.passwordRejected = await call('request_credentials', { project: 'fixture', label: 'qa-user-1', reason: 'mcp check', password: 'should-not-stick' });
const leasesBefore = leasesText();
output.missingAgent = await call('run_signin_check', { project: 'fixture', users: ['qa-user-1'], wait: true });
output.leasesUnchanged = leasesText() === leasesBefore;
output.signin = await call('run_signin_check', { project: 'fixture', users: ['qa-user-1'], agent_id: 'mcp-e2e-run', wait: true });
const summaryPath = join(homedir(), '.hornet-swarm', 'runs', output.signin.run_id, 'summary.md');
const originalSummary = readFileSync(summaryPath, 'utf8');
writeFileSync(summaryPath, `${originalSummary}\nFixtureOnly-s3cret"<&value>\n`);
try {
  output.summary = await call('get_results', { run_id: output.signin.run_id, detail: 'summary' });
  output.full = await call('get_results', { run_id: output.signin.run_id, detail: 'full' });
} finally {
  writeFileSync(summaryPath, originalSummary);
}
output.journey = await call('run_journey', { project: 'fixture', journey_id: 'flag-check', agent_id: 'mcp-e2e-journey', wait: true });
output.filtered = await call('run_journey', {
  project: 'fixture',
  journey_id: 'both-users',
  users: ['qa-user-1'],
  agent_id: 'mcp-e2e-filter',
  wait: true,
});
output.suite = await call('run_suite', {
  project: 'fixture',
  journeys: ['signin-dashboard', 'tenant-isolation'],
  gate: 'all',
  agent_id: 'mcp-e2e-suite',
  wait: true,
});
output.latest = await call('get_results', { project: 'fixture' });
output.reset = await call('reset_environment', { project: 'fixture' });
output.blocked = await call('run_suite', { project: 'unauth', journeys: ['signin-dashboard'], agent_id: 'mcp-e2e-blocked', wait: true });
output.killed = await call('reset_environment', { project: 'fixture', kill: true });
output.killFileAfterEngage = existsSync(join(homedir(), '.hornet-swarm', 'KILL'));
output.afterKill = await call('run_suite', { project: 'fixture', journeys: ['signin-dashboard'], agent_id: 'mcp-e2e-after', wait: true });
output.releasedKill = await call('reset_environment', { project: 'fixture', release: true });
output.killFileAfterRelease = existsSync(join(homedir(), '.hornet-swarm', 'KILL'));
await client.close();
process.stdout.write(`${JSON.stringify(output)}\n`);

function leasesText() {
  const file = join(homedir(), '.hornet-swarm', 'leases.json');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

async function call(name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.find((entry) => entry.type === 'text')?.text ?? '{}';
    if (result.isError) return { ok: false, error: text };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: text };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'The call failed.' };
  }
}
