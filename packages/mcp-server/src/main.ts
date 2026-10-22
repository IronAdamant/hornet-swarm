#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CHAOS_PROFILES, parallelRunners, Redactor, validateJourneyYaml } from '@hornet-swarm/core';
import {
  acquireLease,
  addAgentNote,
  checkFindings,
  HornetError,
  credentialStatus,
  inspectPage,
  engageKill,
  envReset,
  leasesHeldByOthers,
  listProjectUsers,
  loadProject,
  readAgentNotes,
  readJourneyYaml,
  projectSecretValues,
  registerProjectSecrets,
  releaseStoredLease,
  reliabilityReport,
  requestCredentials,
  runSuite,
  saveAgentJourney,
  stopRunners,
  swarmSnapshot,
} from '@hornet-swarm/controller';
import { homedir } from 'node:os';
import { changedSince, settledFingerprints, staleBuilds } from './freshness.js';

const home = () => process.env.AEGIS_HOME ?? join(homedir(), '.hornet-swarm');
const sessionAgentId = `mcp-${randomBytes(16).toString('hex')}`;
/** Ids this session minted with register_agent. Sub-agents that share one connection each get their own. */
const subAgentIds = new Map<string, string>();
const MAX_SUB_AGENTS = 30;
const PROJECT_ID = /^[a-z0-9-]+$/;
const RUN_ID = /^run_[A-Za-z0-9_-]+$/;
const JOURNEY_ID = /^[a-z0-9-]+$/;
const LABEL = /^qa-user-\d+$/;
/**
 * Chaos for run_suite and run_journey: delays, lost requests, refreshes, and double clicks. The
 * project's authorisation must list chaos; runSuite refuses it otherwise, and on any public
 * practice site.
 */
const chaosInput = z
  .object({
    profile: z.enum(CHAOS_PROFILES),
    seed: z.string().regex(/^[A-Za-z0-9-]{1,40}$/, 'seed is 1 to 40 letters, digits, or dashes'),
  })
  .strict()
  .optional();

/** An agent names a project and its journeys by id. A path is refused before any file is read. */
function badProject(project: string | undefined): { content: { type: 'text'; text: string }[] } | undefined {
  if (project === undefined || PROJECT_ID.test(project)) return undefined;
  return pack(undefined, { ok: false, error: 'Unknown project.' });
}

function badJourneyIds(ids: string[] | undefined, project: string): { content: { type: 'text'; text: string }[] } | undefined {
  const bad = (ids ?? []).find((id) => !JOURNEY_ID.test(id));
  if (bad === undefined) return undefined;
  return pack(project, { ok: false, error: `${bad} is not a journey id. Name journeys by id, not by path.` });
}

function useAgent(supplied: string | undefined): { ok: true; agentId: string } | { ok: false; error: string } {
  if (supplied === undefined || supplied === sessionAgentId) return { ok: true, agentId: sessionAgentId };
  if (subAgentIds.has(supplied)) return { ok: true, agentId: supplied };
  return { ok: false, error: 'That agent id belongs to another session.' };
}



// A server started before `pnpm build` keeps serving the old journey rules. It refuses to start on
// a stale build, and once the build changes under it, every tool asks for a restart instead.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const startedAt = Date.now();
const startPrints = settledFingerprints(repoRoot);
const staleAtStart = staleBuilds(repoRoot);
if (staleAtStart.length > 0) {
  process.stderr.write(`Hornet Swarm's source is newer than its build in ${staleAtStart.join(', ')}. Run pnpm build, then start the MCP server again.\n`);
  process.exit(1);
}
let freshness = { checkedAt: 0, message: '' };
function rebuiltMessage(): string {
  if (Date.now() - freshness.checkedAt < 2_000) return freshness.message;
  const rebuilt = changedSince(repoRoot, startPrints);
  freshness = {
    checkedAt: Date.now(),
    message:
      rebuilt.length > 0
        ? `Hornet Swarm was rebuilt (${rebuilt.join(', ')}) after this MCP server started at ${new Date(startedAt).toISOString()}. Restart the MCP server so it uses the new code. Nothing was run.`
        : '',
  };
  return freshness.message;
}

const server = new McpServer({ name: 'hornet-swarm', version: '0.1.0' });
type ToolHandler = (...args: unknown[]) => unknown;
const registerOriginal = server.registerTool.bind(server) as unknown as (name: string, config: unknown, handler: ToolHandler) => unknown;
(server as unknown as { registerTool: typeof registerOriginal }).registerTool = (name, config, handler) =>
  registerOriginal(name, config, async (...args: unknown[]) => {
    const stale = rebuiltMessage();
    return stale ? pack(undefined, { ok: false, error: stale }) : handler(...args);
  });

server.registerTool(
  'register_agent',
  {
    description:
      'Get a new agent id for one sub-agent in this session. Give each sub-agent its own id and pass it as agent_id on every call. One id holds one login at a time.',
    inputSchema: z.object({ name: z.string().max(80).optional() }),
  },
  async ({ name }) => {
    if (subAgentIds.size >= MAX_SUB_AGENTS) return pack(undefined, { ok: false, error: `A session can register at most ${MAX_SUB_AGENTS} sub-agents.` });
    const agentId = `${sessionAgentId}-${randomBytes(6).toString('hex')}`;
    subAgentIds.set(agentId, (name ?? '').replace(/[^\w .-]/g, '').slice(0, 80));
    return pack(undefined, { ok: true, agent_id: agentId, ...(name ? { name: subAgentIds.get(agentId) } : {}) }, agentId);
  },
);

server.registerTool(
  'list_test_users',
  { description: 'List test-user labels for a project', inputSchema: z.object({ project: z.string() }) },
  async ({ project }) => badProject(project) ?? pack(project, { users: listProjectUsers(project, home()) }),
);

server.registerTool(
  'run_signin_check',
  {
    description: 'Run the sign-in check',
    inputSchema: z.object({
      project: z.string(),
      users: z.array(z.string()).optional(),
      agent_id: z.string().min(1).optional(),
    }),
  },
  async ({ project, users, agent_id }) => {
    const invalid = badProject(project);
    if (invalid) return invalid;
    const agent = useAgent(agent_id);
    if (!agent.ok) return pack(project, { ok: false, error: agent.error });
    return guard(project, () =>
      runSuite({ project, phase1Only: true, ...(users ? { users } : {}), via: 'mcp', agentId: agent.agentId }),
      agent.agentId,
    );
  },
);

server.registerTool(
  'run_journey',
  {
    description:
      'Run one journey. Pass journey_id for a saved journey, or journey_yaml to write your own. A written journey gets the same checks as any other: allowed sites only, no literal passwords, credentials by handle such as qa-user-1.password. A passive_security step runs only when the authorisation lists passive_security_checks. It is saved under the project for reuse.',
    inputSchema: z.object({
      project: z.string(),
      journey_id: z.string().optional(),
      journey_yaml: z.string().max(100_000).optional(),
      users: z.array(z.string()).optional(),
      agent_id: z.string().min(1).optional(),
      chaos: chaosInput,
    }),
  },
  async ({ project, journey_id, journey_yaml, users, agent_id, chaos }) => {
    const agent = useAgent(agent_id);
    if (!agent.ok) return pack(project, { ok: false, error: agent.error }, agent_id);
    if (!PROJECT_ID.test(project)) return pack(undefined, { ok: false, error: 'Unknown project.' }, agent.agentId);
    if (Boolean(journey_id) === Boolean(journey_yaml)) return pack(project, { ok: false, error: 'Pass journey_id or journey_yaml, not both.' }, agent.agentId);
    if (journey_id && !JOURNEY_ID.test(journey_id)) return pack(project, { ok: false, error: 'journey_id is a journey id, not a path.' }, agent.agentId);
    return guard(
      project,
      async () => {
        const id = journey_yaml ? saveAgentJourney(project, journey_yaml, home()).id : (journey_id as string);
        return runSuite({
          project,
          journeyFiles: [id],
          journeyPathsAllowed: false,
          includeRegressions: false,
          ...(users ? { users } : {}),
          ...(chaos ? { chaos } : {}),
          via: 'mcp',
          agentId: agent.agentId,
        });
      },
      agent.agentId,
    );
  },
);

server.registerTool(
  'inspect_page',
  {
    description:
      'Open one allowed page as a label and get a map of it for writing a journey: headings, links, buttons, and form fields, each with a selector a journey step accepts, plus the visible words and a screenshot path. `checked: true` means the selector matched exactly one element. It signs in first when the label has a stored login (pass sign_in: false to look as a guest), opens the page, and reads it. It clicks and submits nothing on the page. Draft the journey from the map, then call validate_journey and run_journey, and fix it from the failure clues.',
    inputSchema: z.object({
      project: z.string(),
      label: z.string(),
      url: z.string().min(1).max(2_000),
      sign_in: z.boolean().optional(),
      name: z.string().optional(),
      agent_id: z.string().min(1).optional(),
    }),
  },
  async ({ project, label, url, sign_in, name, agent_id }) => {
    const agent = useAgent(agent_id);
    if (!agent.ok) return pack(project, { ok: false, error: agent.error }, agent_id);
    if (!PROJECT_ID.test(project)) return pack(undefined, { ok: false, error: 'Unknown project.' }, agent.agentId);
    if (!LABEL.test(label)) return pack(project, { ok: false, error: 'label must look like qa-user-1' }, agent.agentId);
    return guard(
      project,
      () =>
        inspectPage({
          project,
          label,
          url,
          ...(sign_in !== undefined ? { signIn: sign_in } : {}),
          ...(name ? { name } : {}),
          agentId: agent.agentId,
          via: 'mcp',
        }),
      agent.agentId,
    );
  },
);

server.registerTool(
  'run_suite',
  {
    description:
      'Run a suite. Pass chaos { profile, seed } to add delays, lost requests, refreshes, and double clicks; the authorisation must list chaos. Compare a chaos run with a normal run of the same journeys.',
    inputSchema: z.object({
      project: z.string(),
      journeys: z.array(z.string()).optional(),
      users: z.array(z.string()).optional(),
      gate: z.enum(['all', 'per_user']).optional(),
      confirm_production: z.boolean().optional(),
      agent_id: z.string().min(1).optional(),
      chaos: chaosInput,
    }),
  },
  async ({ project, journeys, users, gate, confirm_production, agent_id, chaos }) => {
    const invalid = badProject(project) ?? badJourneyIds(journeys, project);
    if (invalid) return invalid;
    const agent = useAgent(agent_id);
    if (!agent.ok) return pack(project, { ok: false, error: agent.error });
    return guard(project, () =>
      runSuite({
        project,
        ...(journeys ? { journeyFiles: journeys } : {}),
        journeyPathsAllowed: false,
        ...(users ? { users } : {}),
        ...(gate ? { gate } : {}),
        confirmProduction: Boolean(confirm_production),
        ...(chaos ? { chaos } : {}),
        via: 'mcp',
        agentId: agent.agentId,
      }),
      agent.agentId,
    );
  },
);

server.registerTool(
  'get_results',
  {
    description: 'Read a run report',
    inputSchema: z.object({
      project: z.string().optional(),
      run_id: z.string().optional(),
      format: z.enum(['json', 'junit', 'summary']).optional(),
      detail: z.enum(['summary', 'full']).optional(),
    }),
  },
  async ({ project, run_id, format, detail }) => {
    if (project !== undefined && !PROJECT_ID.test(project)) return pack(undefined, { ok: false, error: 'Unknown project.' });
    if (run_id !== undefined && !RUN_ID.test(run_id)) return pack(project, { ok: false, error: 'Unknown run id.' });
    if (!run_id) {
      const id = project ?? 'fixture';
      try {
        const packet = JSON.parse(readFileSync(join(home(), 'projects', id, 'latest-parent-report.json'), 'utf8')) as unknown;
        return pack(id, packet);
      } catch {
        return pack(id, { ok: false, error: 'No parent report has been written for this project.' });
      }
    }
    const dir = join(home(), 'runs', run_id);
    let stored: { project?: string };
    try {
      stored = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { project?: string };
    } catch {
      return pack(project, { ok: false, error: 'Unknown run id.' });
    }
    if (project && stored.project !== project) return pack(project, { ok: false, error: 'That run belongs to another project.' });
    const kind = detail === 'summary' || format === 'summary' ? 'summary' : detail === 'full' ? 'full' : format ?? 'json';
    const file = kind === 'summary' ? 'summary.md' : kind === 'junit' ? 'junit.xml' : kind === 'full' ? 'analysis.json' : 'run.json';
    const text = readFileSync(join(dir, file), 'utf8');
    return pack(stored.project, kind === 'summary' || kind === 'junit' ? { detail: kind, text } : JSON.parse(text));
  },
);

server.registerTool(
  'reset_environment',
  {
    description:
      'Engage the kill switch, or recreate this project\'s runners. Any agent can engage the kill switch. Only the owner can release it, with `hornet-swarm kill --release`. A reset is refused while another agent holds a login, and a hard reset (image rebuild) is owner-only.',
    inputSchema: z.object({
      project: z.string().optional(),
      hard: z.boolean().optional(),
      kill: z.boolean().optional(),
      release: z.boolean().optional(),
      agent_id: z.string().min(1).optional(),
    }),
  },
  async ({ project, hard, kill, release, agent_id }) => {
    const id = project ?? 'fixture';
    if (!PROJECT_ID.test(id)) return pack(undefined, { ok: false, error: 'Unknown project.' });
    const agent = useAgent(agent_id);
    if (!agent.ok) return pack(id, { ok: false, error: agent.error });
    if (kill) {
      engageKill(home());
      await stopRunners(id);
      return pack(id, { ok: true, killed: true, ...(release ? { released: false } : {}) }, agent.agentId);
    }
    if (release) {
      return pack(id, { ok: false, released: false, error: 'Only the owner can release the kill switch. Ask them to run: hornet-swarm kill --release' }, agent.agentId);
    }
    if (hard) return pack(id, { ok: false, error: 'A hard reset rebuilds images. Ask the owner to run: hornet-swarm env reset --hard' }, agent.agentId);
    const busy = leasesHeldByOthers(id, agent.agentId, home());
    if (busy.length > 0) return pack(id, { ok: false, error: `Another agent is using ${busy.join(', ')}. A reset would cut off that run.` }, agent.agentId);
    const status = await envReset({ project: id, hard: false });
    return pack(id, status, agent.agentId);
  },
);

server.registerTool(
  'validate_journey',
  {
    description: 'Validate a journey without running it',
    inputSchema: z.object({ project: z.string().optional(), journey_yaml: z.string().optional(), journey_id: z.string().optional() }),
  },
  async ({ project, journey_yaml, journey_id }) => {
    const id = project ?? 'fixture';
    const invalid = badProject(id) ?? badJourneyIds(journey_id ? [journey_id] : [], id);
    if (invalid) return invalid;
    let loaded;
    try {
      loaded = loadProject(id, home());
    } catch {
      return pack(id, { valid: false, errors: ['Unknown project.'] });
    }
    let source = journey_yaml ?? '';
    if (journey_id) {
      try {
        source = readJourneyYaml(id, journey_id, home());
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown journey.';
        return pack(id, { valid: false, errors: [message] });
      }
    }
    if (!source.trim()) return pack(id, { valid: false, errors: ['Provide a journey file or journey YAML.'] });
    const checked = validateJourneyYaml(source, loaded, projectSecretValues(id, home()));
    return pack(id, { valid: checked.valid, errors: checked.errors });
  },
);

server.registerTool(
  'acquire_test_user',
  {
    description: 'Acquire an exclusive login lease. Refused with reason parallel_limit while the project already has max_parallel_runners logins in use; try again after busy_until.',
    inputSchema: z.object({ project: z.string(), label: z.string(), agent_id: z.string().min(1).optional(), run_id: z.string().optional() }),
  },
  async ({ project, label, agent_id, run_id }) => {
    const invalid = badProject(project);
    if (invalid) return invalid;
    if (!LABEL.test(label)) return pack(project, { ok: false, error: 'label must look like qa-user-1' });
    const agent = useAgent(agent_id);
    if (!agent.ok) return pack(project, { ok: false, error: agent.error });
    let maxActive: number;
    try {
      maxActive = parallelRunners(loadProject(project, home()));
    } catch {
      return pack(project, { ok: false, error: 'Unknown project.' });
    }
    // Each held login is one working runner, so the project's runner cap applies here too.
    const decision = acquireLease({ project, label, agentId: agent.agentId, ...(run_id ? { runId: run_id } : {}), maxActive, home: home(), via: 'mcp' });
    if (!decision.ok) {
      return pack(project, {
        ok: false,
        reason: decision.reason,
        ...(decision.busyUntil ? { busy_until: decision.busyUntil } : {}),
        ...(decision.nextFreeLabel ? { next_free_label: decision.nextFreeLabel } : {}),
      }, agent.agentId);
    }
    return pack(project, { ok: true, label: decision.lease.label, expires_at: decision.lease.expiresAt }, agent.agentId);
  },
);

server.registerTool(
  'release_test_user',
  {
    description: 'Release the login lease held by an agent',
    inputSchema: z.object({ project: z.string(), agent_id: z.string().min(1).optional() }),
  },
  async ({ project, agent_id }) => {
    const invalid = badProject(project);
    if (invalid) return invalid;
    const agent = useAgent(agent_id);
    if (!agent.ok) return pack(project, { ok: false, error: agent.error });
    releaseStoredLease(project, agent.agentId, home(), 'mcp');
    return pack(project, { ok: true, released: true }, agent.agentId);
  },
);

server.registerTool(
  'get_swarm',
  {
    description: 'Read the website, account labels, and personalities after the owner presses Ready. Passwords are not included.',
    inputSchema: z.object({ project: z.string() }),
  },
  async ({ project }) => badProject(project) ?? pack(project, await swarmSnapshot(project, home())),
);

server.registerTool(
  'request_credentials',
  {
    description: 'Ask the owner to enter a test login',
    inputSchema: z.object({ project: z.string(), label: z.string(), reason: z.string() }).passthrough(),
  },
  async (args) => {
    const invalid = badProject(args.project);
    if (invalid) return invalid;
    const extra = Object.keys(args).filter((key) => !['project', 'label', 'reason'].includes(key));
    if (extra.length > 0) return pack(args.project, { ok: false, error: 'Agents cannot pass a password.' });
    try {
      const result = await requestCredentials({ project: args.project, label: args.label, reason: args.reason }, home());
      return pack(args.project, result);
    } catch (error) {
      const message = error instanceof HornetError ? error.message : 'The request was refused.';
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

server.registerTool(
  'add_agent_note',
  {
    description:
      'Keep a note for a sub-agent label, such as something learned about the site. Notes are redacted, kept with the label across sessions, and shown by get_swarm. Never put a password in a note.',
    inputSchema: z.object({ project: z.string(), label: z.string(), note: z.string().max(2_000), agent_id: z.string().min(1).optional() }),
  },
  async ({ project, label, note, agent_id }) => {
    const invalid = badProject(project);
    if (invalid) return invalid;
    const agent = useAgent(agent_id);
    if (!agent.ok) return pack(project, { ok: false, error: agent.error });
    try {
      return pack(project, addAgentNote(project, label, agent.agentId, note, home()), agent.agentId);
    } catch (error) {
      return pack(project, { ok: false, error: error instanceof HornetError ? error.message : 'The note was not saved.' }, agent.agentId);
    }
  },
);

server.registerTool(
  'get_agent_notes',
  {
    description: 'Read every note kept for a sub-agent label, oldest first.',
    inputSchema: z.object({ project: z.string(), label: z.string() }),
  },
  async ({ project, label }) => {
    if (!PROJECT_ID.test(project) || !/^qa-user-\d+$/.test(label)) return pack(undefined, { ok: false, error: 'Unknown project or label.' });
    return pack(project, { label, notes: readAgentNotes(project, label, home()) });
  },
);

server.registerTool(
  'get_reliability',
  {
    description:
      'How reliable the site has been across recent runs: pass rate, p50 and p95 timings, failing streaks, and retries, per journey and for sign-in. Chaos runs are left out unless chaos is true, which counts only them.',
    inputSchema: z.object({ project: z.string(), last: z.number().int().min(1).max(500).optional(), chaos: z.boolean().optional() }),
  },
  async ({ project, last, chaos }) => {
    const invalid = badProject(project);
    if (invalid) return invalid;
    try {
      return pack(project, reliabilityReport(project, last ?? 20, home(), chaos ? 'only' : 'exclude'));
    } catch (error) {
      return pack(project, { ok: false, error: error instanceof HornetError ? error.message : 'No reliability data.' });
    }
  },
);

server.registerTool(
  'check_findings',
  {
    description:
      'Check report findings against saved runs before you report them. Each finding has an id like F-01, a severity of High, Medium, or Low, a title, a claim, and evidence: a step with the status the run recorded, a sign-in status, a quote from that step\'s saved page text or error, or a file in the run folder. Returns the findings as Markdown with how often each happened, or the evidence that is missing. Report only findings this accepts.',
    inputSchema: z.object({ project: z.string(), findings: z.array(z.unknown()).min(1) }),
  },
  async ({ project, findings }) => {
    const invalid = badProject(project);
    if (invalid) return invalid;
    try {
      return pack(project, checkFindings({ project, findings }, { home: home() }));
    } catch (error) {
      return pack(project, { ok: false, error: error instanceof HornetError ? error.message : 'The findings could not be checked.' });
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

async function guard(project: string, fn: () => Promise<unknown>, agentId = sessionAgentId): Promise<{ content: { type: 'text'; text: string }[] }> {
  if (killed()) return pack(project, { ok: false, error: 'The kill switch is on.' }, agentId);
  try {
    return pack(project, await fn(), agentId);
  } catch (error) {
    const message = error instanceof HornetError ? error.message : 'The run failed.';
    return pack(project, { ok: false, error: message }, agentId);
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

function pack(project: string | undefined, value: unknown, agentId = sessionAgentId): { content: { type: 'text'; text: string }[] } {
  const redactor = new Redactor();
  if (project && PROJECT_ID.test(project)) {
    try {
      registerProjectSecrets(project, redactor, home());
    } catch {
      // A project without a store still has to return redacted JSON.
    }
  }
  const body =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>), agent_id: agentId }
      : { agent_id: agentId, value };
  return { content: [{ type: 'text', text: JSON.stringify(redactor.redactUnknown(body)) }] };
}

