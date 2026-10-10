#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { projectSchema, Redactor, validateJourneyYaml } from '@aegis/core';
import {
  acquireLease,
  AegisError,
  credentialStatus,
  engageKill,
  envReset,
  envStatus,
  listProjectUsers,
  registerProjectSecrets,
  releaseStoredLease,
  requestCredentials,
  runSuite,
  stopRunners,
} from '@aegis/controller';
import { parse } from 'yaml';
import { homedir } from 'node:os';

const home = () => process.env.AEGIS_HOME ?? join(homedir(), '.aegis');

const server = new McpServer({ name: 'aegis', version: '0.1.0' });

server.registerTool(
  'list_test_users',
  { description: 'List test-user labels for a project', inputSchema: z.object({ project: z.string() }) },
  async ({ project }) => pack(project, { users: listProjectUsers(project, home()) }),
);

server.registerTool(
  'run_signin_check',
  {
    description: 'Run the sign-in check',
    inputSchema: z.object({ project: z.string(), users: z.array(z.string()).optional(), wait: z.boolean().optional() }),
  },
  async ({ project, users }) =>
    guard(project, () => runSuite({ project, phase1Only: true, ...(users ? { users } : {}), via: 'mcp', agentId: 'mcp' })),
);

server.registerTool(
  'run_journey',
  {
    description: 'Run one journey',
    inputSchema: z.object({ project: z.string(), journey_id: z.string(), users: z.array(z.string()).optional(), wait: z.boolean().optional() }),
  },
  async ({ project, journey_id }) =>
    guard(project, () => runSuite({ project, journeyFiles: [journey_id], via: 'mcp', agentId: 'mcp' })),
);

server.registerTool(
  'run_suite',
  {
    description: 'Run a suite',
    inputSchema: z.object({
      project: z.string(),
      journeys: z.array(z.string()).optional(),
      gate: z.enum(['all', 'per_user']).optional(),
      confirm_production: z.boolean().optional(),
      wait: z.boolean().optional(),
    }),
  },
  async ({ project, journeys, gate, confirm_production }) =>
    guard(project, () =>
      runSuite({
        project,
        ...(journeys ? { journeyFiles: journeys } : {}),
        ...(gate ? { gate } : {}),
        confirmProduction: Boolean(confirm_production),
        via: 'mcp',
        agentId: 'mcp',
      }),
    ),
);

server.registerTool(
  'get_results',
  {
    description: 'Read a run report',
    inputSchema: z.object({
      run_id: z.string(),
      format: z.enum(['json', 'junit', 'summary']).optional(),
      detail: z.enum(['summary', 'full']).optional(),
    }),
  },
  async ({ run_id, format, detail }) => {
    const dir = join(home(), 'runs', run_id);
    const kind = detail === 'summary' || format === 'summary' ? 'summary' : detail === 'full' ? 'full' : format ?? 'json';
    const file = kind === 'summary' ? 'summary.md' : kind === 'junit' ? 'junit.xml' : kind === 'full' ? 'analysis.json' : 'run.json';
    const text = readFileSync(join(dir, file), 'utf8');
    return pack(undefined, kind === 'summary' || kind === 'junit' ? { detail: kind, text } : JSON.parse(text));
  },
);

server.registerTool(
  'reset_environment',
  {
    description: 'Reset runners or engage the kill switch',
    inputSchema: z.object({ project: z.string().optional(), hard: z.boolean().optional(), kill: z.boolean().optional() }),
  },
  async ({ project, hard, kill }) => {
    const id = project ?? 'fixture';
    if (kill) {
      engageKill(home());
      await stopRunners(id);
      return pack(id, { ok: true, killed: true });
    }
    if (hard) {
      const status = await envReset({ project: id, hard: true });
      return pack(id, status);
    }
    return pack(id, await envStatus(id));
  },
);

server.registerTool(
  'validate_journey',
  {
    description: 'Validate a journey without running it',
    inputSchema: z.object({ project: z.string().optional(), journey_yaml: z.string().optional(), journey_id: z.string().optional() }),
  },
  async ({ project, journey_yaml }) => {
    const id = project ?? 'fixture';
    const loaded = projectSchema.parse(parse(readFileSync(join(home(), 'projects', id, 'project.yaml'), 'utf8')));
    const checked = validateJourneyYaml(journey_yaml ?? '', loaded);
    return pack(id, { valid: checked.valid, errors: checked.errors });
  },
);

server.registerTool(
  'acquire_test_user',
  {
    description: 'Acquire an exclusive login lease',
    inputSchema: z.object({ project: z.string(), label: z.string(), agent_id: z.string(), run_id: z.string().optional() }),
  },
  async ({ project, label, agent_id, run_id }) => {
    const decision = acquireLease({ project, label, agentId: agent_id, ...(run_id ? { runId: run_id } : {}), home: home(), via: 'mcp' });
    if (!decision.ok) {
      return pack(project, {
        ok: false,
        reason: decision.reason,
        ...(decision.busyUntil ? { busy_until: decision.busyUntil } : {}),
        ...(decision.nextFreeLabel ? { next_free_label: decision.nextFreeLabel } : {}),
      });
    }
    return pack(project, { ok: true, label: decision.lease.label, expires_at: decision.lease.expiresAt });
  },
);

server.registerTool(
  'release_test_user',
  {
    description: 'Release the login lease held by an agent',
    inputSchema: z.object({ project: z.string(), agent_id: z.string() }),
  },
  async ({ project, agent_id }) => {
    releaseStoredLease(project, agent_id, home(), 'mcp');
    return pack(project, { ok: true, released: true });
  },
);

server.registerTool(
  'request_credentials',
  {
    description: 'Ask the owner to enter a test login',
    inputSchema: z.object({ project: z.string(), label: z.string(), reason: z.string() }).passthrough(),
  },
  async (args) => {
    const extra = Object.keys(args).filter((key) => !['project', 'label', 'reason'].includes(key));
    if (extra.length > 0) return pack(args.project, { ok: false, error: 'Agents cannot pass a password.' });
    try {
      const result = await requestCredentials({ project: args.project, label: args.label, reason: args.reason }, home());
      return pack(args.project, result);
    } catch (error) {
      const message = error instanceof AegisError ? error.message : 'The request was refused.';
      return pack(args.project, { ok: false, error: message });
    }
  },
);

server.registerTool(
  'credential_status',
  {
    description: 'Read whether a credential request is ready, declined, or expired',
    inputSchema: z.object({ id: z.string() }),
  },
  async ({ id }) => pack(undefined, credentialStatus(id, home())),
);

const transport = new StdioServerTransport();
await server.connect(transport);

async function guard(project: string, fn: () => Promise<unknown>): Promise<{ content: { type: 'text'; text: string }[] }> {
  if (killed()) return pack(project, { ok: false, error: 'The kill switch is on.' });
  try {
    return pack(project, await fn());
  } catch (error) {
    const message = error instanceof AegisError ? error.message : 'The run failed.';
    return pack(project, { ok: false, error: message });
  }
}

function killed(): boolean {
  try {
    readFileSync(join(home(), 'KILL'));
    return true;
  } catch {
    return false;
  }
}

function pack(project: string | undefined, value: unknown): { content: { type: 'text'; text: string }[] } {
  const redactor = new Redactor();
  if (project) {
    try {
      registerProjectSecrets(project, redactor, home());
    } catch {
      // A project without a store still has to return redacted JSON.
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(redactor.redactUnknown(value)) }] };
}

