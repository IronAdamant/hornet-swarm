import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { authorisationSchema, authorisationStatus, containerHost, domainCovered, projectSchema, Redactor, shortSecretError, type Project } from '@hornet-swarm/core';
import { listLabels, registerProjectSecrets, setSecret } from './broker.js';
import { envStatus } from './env.js';
import { HornetError } from './errors.js';
import { aegisHome, ensureDir } from './home.js';
import { leaseHolder, withFileLock, writeFileAtomic } from './leases-store.js';

/** One sub-agent: its login label, the personality it plays, and the owner's rules for it. */
export type SwarmAgent = { label: string; personality: string; rules?: string };

export type AgentNote = { at: string; agent: string; text: string };

const NOTE_LIMIT = 2_000;
const NOTES_KEPT = 50;
const NOTES_SHOWN = 10;

export type SwarmView = {
  ready: boolean;
  project: string;
  website: string;
  agents: SwarmAgent[];
};

export type SwarmSnapshot = Omit<SwarmView, 'agents'> & {
  agents: (SwarmAgent & { rules: string; notes: AgentNote[] })[];
  kill_switch: boolean;
  runners: { label: string; healthy: boolean }[];
};

export type SwarmCard = { username: string; password: string; personality: string; rules?: string };

export type SwarmSelectors = { username: string; password: string; submit: string; success: string };

const FIXTURE_SELECTORS: SwarmSelectors = {
  username: '#email',
  password: '#password',
  submit: "role=button[name='Sign in']",
  success: '/dashboard',
};

const FIXTURE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

const CARD_COUNT = 10;

/** Healthy means the runner is running and its health check answered. An endpoint alone is not enough. */
export function runnerHealth(
  agents: SwarmAgent[],
  runners: { label: string; health: string }[] | null,
): { label: string; healthy: boolean }[] {
  return agents.map((agent) => ({
    label: agent.label,
    healthy: runners?.some((runner) => runner.label === agent.label && runner.health === 'healthy') ?? false,
  }));
}

export async function swarmSnapshot(project: string, home = aegisHome()): Promise<SwarmSnapshot> {
  const view = readSwarm(project, home);
  let runners: { label: string; health: string }[] | null;
  try {
    runners = (await envStatus(project)).runners;
  } catch {
    runners = null;
  }
  return {
    ...view,
    agents: view.agents.map((agent) => ({ ...agent, rules: agent.rules ?? '', notes: readAgentNotes(project, agent.label, home).slice(-NOTES_SHOWN) })),
    kill_switch: existsSync(join(home, 'KILL')),
    runners: runnerHealth(view.agents, runners),
  };
}

function notesPath(home: string, project: string, label: string): string {
  return join(home, 'projects', project, 'notes', `${label}.json`);
}

export function readAgentNotes(project: string, label: string, home = aegisHome()): AgentNote[] {
  try {
    const parsed = JSON.parse(readFileSync(notesPath(home, project, label), 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as AgentNote[]) : [];
  } catch {
    return [];
  }
}

/**
 * Notes are what a sub-agent learned about the site, kept with its label for the next session.
 * A note is redacted before it is stored. The last 50 notes are kept. A label that another agent
 * holds right now cannot be written to.
 */
export function addAgentNote(project: string, label: string, agentId: string, text: string, home = aegisHome()): { ok: true; notes: number } {
  if (!/^[a-z0-9-]+$/.test(project)) throw new HornetError('Unknown project.', 3);
  if (!/^qa-user-\d+$/.test(label)) throw new HornetError('label must look like qa-user-1', 3);
  if (!readSwarm(project, home).agents.some((agent) => agent.label === label)) throw new HornetError(`${label} is not on the swarm board.`, 3);
  const trimmed = text.trim();
  if (!trimmed) throw new HornetError('A note cannot be empty.', 3);
  if (trimmed.length > NOTE_LIMIT) throw new HornetError(`A note can be at most ${NOTE_LIMIT} characters.`, 3);
  const holder = leaseHolder(project, label, home);
  if (holder && holder !== agentId) throw new HornetError(`${label} is in use by another agent.`, 3);
  const redactor = new Redactor();
  registerProjectSecrets(project, redactor, home);
  const note: AgentNote = { at: new Date().toISOString(), agent: agentId, text: redactor.redact(trimmed) };
  const file = notesPath(home, project, label);
  mkdirSync(join(home, 'projects', project, 'notes'), { recursive: true, mode: 0o700 });
  const count = withFileLock(home, `notes-${project}-${label}`, () => {
    const notes = [...readAgentNotes(project, label, home), note].slice(-NOTES_KEPT);
    writeFileAtomic(file, `${JSON.stringify(notes, null, 2)}\n`);
    return notes.length;
  });
  return { ok: true, notes: count };
}

export function readSwarm(project: string, home = aegisHome()): SwarmView {
  try {
    const stored = JSON.parse(readFileSync(swarmPath(home, project), 'utf8')) as Partial<SwarmView>;
    const agents = Array.isArray(stored.agents) ? stored.agents : [];
    return {
      ready: stored.ready === true,
      project,
      website: typeof stored.website === 'string' ? stored.website : '',
      agents: agents
        .filter((agent): agent is SwarmAgent => Boolean(agent) && typeof agent.label === 'string')
        .map((agent) => ({
          label: agent.label,
          personality: typeof agent.personality === 'string' ? agent.personality : '',
          rules: typeof agent.rules === 'string' ? agent.rules : '',
        })),
    };
  } catch {
    return { ready: false, project, website: '', agents: [] };
  }
}

export function saveSwarmBoard(
  input: { project: string; website: string; cards: SwarmCard[]; selectors?: SwarmSelectors },
  home = aegisHome(),
): SwarmView {
  const projectId = input.project.trim();
  if (!/^[a-z0-9-]+$/.test(projectId)) throw new HornetError('Enter a project name made of letters, numbers, and dashes.', 3);
  let website: URL;
  try {
    website = new URL(input.website.trim());
  } catch {
    throw new HornetError('Enter a full website address, including http:// or https://.', 3);
  }
  if (website.protocol !== 'http:' && website.protocol !== 'https:') {
    throw new HornetError('The website address must start with http:// or https://.', 3);
  }
  const filled = input.cards
    .slice(0, CARD_COUNT)
    .map((card) => ({ username: card.username.trim(), password: card.password, personality: card.personality.trim(), rules: (card.rules ?? '').trim() }))
    .filter((card) => card.username.length > 0 || card.password.length > 0 || card.personality.length > 0 || card.rules.length > 0);
  if (filled.length === 0) throw new HornetError('Enter at least one login.', 3);
  for (const card of filled) {
    if (!card.username || !card.password) throw new HornetError('Each login needs a username and a password.', 3);
    const problem = shortSecretError(card.password);
    if (problem) throw new HornetError(problem, 3);
  }
  const file = join(home, 'projects', projectId, 'project.yaml');
  let project: Project;
  try {
    project = projectSchema.parse(parse(readFileSync(file, 'utf8')));
  } catch {
    throw new HornetError(`Project ${projectId} is not set up yet.`, 3);
  }
  if (!hostAuthorised(projectId, website.hostname, home)) throw new HornetError('That site is not authorised.', 3);
  const selectors = resolveSelectors(project, input.selectors);
  if (!fixtureHost(website.hostname) && sameFixtureSelectors(selectors)) {
    throw new HornetError('Those login selectors belong to the practice site. Enter the selectors for this website.', 3);
  }

  const agents: SwarmAgent[] = filled.map((card, index) => {
    const label = `qa-user-${index + 1}`;
    setSecret(projectId, label, 'username', card.username, home);
    setSecret(projectId, label, 'password', card.password, home);
    return { label, personality: card.personality, rules: card.rules };
  });
  const redactor = new Redactor();
  registerProjectSecrets(projectId, redactor, home);
  for (const agent of agents) {
    agent.personality = redactor.redact(agent.personality);
    agent.rules = redactor.redact(agent.rules ?? '');
  }

  const origins = new Set<string>([website.origin]);
  if (containerHost(website.hostname, localAddresses()) === 'host.docker.internal') {
    const docker = new URL(website.toString());
    docker.hostname = 'host.docker.internal';
    origins.add(docker.origin);
  }
  project.targets.base_url = website.toString();
  project.targets.allowed_origins = [...origins];
  project.auth.selectors = {
    username: selectors.username,
    password: selectors.password,
    submit: selectors.submit,
    totp: project.auth.selectors.totp,
  };
  project.auth.success = [{ type: 'url_contains', value: selectors.success }];
  project.runners.count = agents.length;
  project.limits.max_parallel_runners = agents.length;
  project.users = agents.map((agent) => {
    const previous = project.users.find((user) => user.label === agent.label);
    return {
      label: agent.label,
      role: previous?.role ?? 'tester',
      tenant: previous?.tenant ?? 'local',
      vars: { ...(previous?.vars ?? {}), personality: agent.personality },
    };
  });
  writeFileSync(file, stringify(projectSchema.parse(project)));
  const view: SwarmView = { ready: true, project: projectId, website: website.toString(), agents };
  ensureDir(join(home, 'projects', projectId));
  writeFileAtomic(swarmPath(home, projectId), `${JSON.stringify(view, null, 2)}\n`);
  return view;
}

export function swarmBoardHtml(project: string, home = aegisHome(), formToken = ''): string {
  const view = readSwarm(project, home);
  const selectors = selectorsForHtml(project, home);
  let stored: string[] = [];
  try {
    stored = listLabels(project, home);
  } catch {
    stored = [];
  }
  const cards = Array.from({ length: CARD_COUNT }, (_unused, index) => {
    const label = `qa-user-${index + 1}`;
    const agent = view.agents.find((entry) => entry.label === label);
    const saved = stored.includes(label) ? '<p class="saved">Password stored on this Mac.</p>' : '';
    return `<section class="card">
      <h2>${label}</h2>
      ${saved}
      <label>Username <input name="username_${index + 1}" autocomplete="off"></label>
      <label>Password <input name="password_${index + 1}" type="password" autocomplete="off"></label>
      <label>Personality <textarea name="personality_${index + 1}">${escapeText(agent?.personality ?? '')}</textarea></label>
      <label>Rules <textarea name="rules_${index + 1}" placeholder="What this sub-agent must and must not do">${escapeText(agent?.rules ?? '')}</textarea></label>
    </section>`;
  }).join('');
  return `<!doctype html><html><head><title>Hornet Swarm</title><style>
    body { margin: 0; background: #111; color: #f4f4f4; font-family: sans-serif; }
    main { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
    input, textarea, button { background: #f4f4f4; color: #111; border: 0; border-radius: 6px; padding: 8px 10px; font: inherit; }
    textarea { width: 100%; min-height: 72px; box-sizing: border-box; }
    label { display: block; margin: 10px 0; }
    .card { border: 1px solid #333; border-radius: 12px; padding: 16px; margin: 16px 0; }
    .saved { color: #b7ebc6; }
    button { font-weight: 700; padding: 12px 20px; cursor: pointer; }
  </style></head><body><main>
    <h1>Prepare the swarm</h1>
    <p>Put the website address in first. Then fill up to ten logins, in order. A personality is who the sub-agent plays. Rules are what it must and must not do. Agents can also keep notes for their label. Do not type a password into any of these. Agents never see the passwords.</p>
    <form method="post" action="/setup">
      <input type="hidden" name="form_token" value="${escapeText(formToken)}">
      <label>Project <input name="project" value="${escapeText(project)}" required></label>
      <label>Website <input name="website" type="url" required value="${escapeText(view.website)}" placeholder="http://127.0.0.1:4173"></label>
      <label>Username selector <input name="selector_username" value="${escapeText(selectors.username)}" required></label>
      <label>Password selector <input name="selector_password" value="${escapeText(selectors.password)}" required></label>
      <label>Submit selector <input name="selector_submit" value="${escapeText(selectors.submit)}" required></label>
      <label>Success check <input name="selector_success" value="${escapeText(selectors.success)}" required></label>
      ${cards}
      <button name="decision" value="ready">Ready</button>
    </form>
  </main></body></html>`;
}

export function cardsFromForm(body: URLSearchParams): SwarmCard[] {
  return Array.from({ length: CARD_COUNT }, (_unused, index) => ({
    username: body.get(`username_${index + 1}`) ?? '',
    password: body.get(`password_${index + 1}`) ?? '',
    personality: body.get(`personality_${index + 1}`) ?? '',
    rules: body.get(`rules_${index + 1}`) ?? '',
  }));
}

function resolveSelectors(project: Project, given: SwarmSelectors | undefined): SwarmSelectors {
  const current = selectorsFromProject(project);
  const selectors = {
    username: (given?.username ?? current.username).trim(),
    password: (given?.password ?? current.password).trim(),
    submit: (given?.submit ?? current.submit).trim(),
    success: (given?.success ?? current.success).trim(),
  };
  if (!selectors.username || !selectors.password || !selectors.submit || !selectors.success) {
    throw new HornetError('Enter the username, password, and submit selectors, and the success check.', 3);
  }
  return selectors;
}

function selectorsFromProject(project: Project): SwarmSelectors {
  const success = project.auth.success.find((item) => item.type === 'url_contains')?.value ?? FIXTURE_SELECTORS.success;
  return {
    username: project.auth.selectors.username,
    password: project.auth.selectors.password,
    submit: project.auth.selectors.submit,
    success,
  };
}

function selectorsForHtml(projectId: string, home: string): SwarmSelectors {
  try {
    const project = projectSchema.parse(parse(readFileSync(join(home, 'projects', projectId, 'project.yaml'), 'utf8')));
    return selectorsFromProject(project);
  } catch {
    return { ...FIXTURE_SELECTORS };
  }
}

function sameFixtureSelectors(selectors: SwarmSelectors): boolean {
  return (
    selectors.username === FIXTURE_SELECTORS.username &&
    selectors.password === FIXTURE_SELECTORS.password &&
    selectors.submit === FIXTURE_SELECTORS.submit &&
    selectors.success === FIXTURE_SELECTORS.success
  );
}

function fixtureHost(hostname: string): boolean {
  return FIXTURE_HOSTS.has(hostname.toLowerCase().replace(/^\[|\]$/g, ''));
}

function localAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.push(entry.address);
  }
  return addresses;
}

function swarmPath(home: string, project: string): string {
  return join(home, 'projects', project, 'swarm.json');
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function hostAuthorised(projectId: string, hostname: string, home: string): boolean {
  try {
    const project = projectSchema.parse(parse(readFileSync(join(home, 'projects', projectId, 'project.yaml'), 'utf8')));
    const auth = authorisationSchema.parse(parse(readFileSync(join(home, 'authorisations', `${project.authorisation_id}.yaml`), 'utf8')));
    if (!authorisationStatus(auth).ok) return false;
    return domainCovered(auth, hostname);
  } catch {
    return false;
  }
}
