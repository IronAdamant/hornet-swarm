import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { validateJourneyDocument, type Journey, type PageMap } from '@hornet-swarm/core';
import { loadProject } from './authorisation.js';
import { listFields, projectSecretValues } from './broker.js';
import { HornetError } from './errors.js';
import { aegisHome } from './home.js';
import { writeFileAtomic } from './leases-store.js';
import { runSuite, signInSteps } from './suite.js';

export type InspectRequest = {
  project: string;
  label: string;
  /** A path on the project's site, such as /checkout, or a full address the project allows. */
  url: string;
  /** Sign in first. Defaults to true when the label has a stored login, and false for a guest. */
  signIn?: boolean;
  /** Names the saved map. Defaults to one made from the path. */
  name?: string;
  agentId?: string;
  via?: 'cli' | 'mcp';
  home?: string;
};

export type InspectOutcome = {
  ok: boolean;
  run_id: string;
  status: string;
  page?: PageMap;
  screenshot?: string;
  error?: string;
  summary: string;
};

const NAME = /^[a-z0-9-]+$/;

export function inspectionName(url: string): string {
  let path = url;
  try {
    // A single-page app routes after the #, as in /#/order-history.
    const parsed = new URL(url, 'http://placeholder');
    path = `${parsed.pathname}${parsed.hash.replace(/^#/, '')}`;
  } catch {
    // Use it as written.
  }
  const name = path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return name || 'home';
}

/**
 * Opens one page as a label and returns a map of it for drafting a journey. It runs as an ordinary
 * single journey, so the authorisation, the allowed sites, the pacing, and the sign-in limit all
 * apply. The journey signs in when asked, opens the page, and reads it. It clicks nothing on the
 * page and submits nothing but the project's own sign-in.
 */
export async function inspectPage(request: InspectRequest): Promise<InspectOutcome> {
  const home = request.home ?? aegisHome();
  const project = loadProject(request.project, home);
  if (!project.users.some((user) => user.label === request.label)) throw new HornetError(`Unknown label ${request.label}.`, 3);
  const name = request.name ?? inspectionName(request.url);
  if (!NAME.test(name)) throw new HornetError('An inspection name uses lower-case letters, digits, and hyphens.', 3);
  const hasLogin = listFields(project.id, request.label, home).length > 0;
  const signIn = request.signIn ?? hasLogin;
  if (signIn && !hasLogin) {
    throw new HornetError(`${request.label} has no stored login. Pass sign_in: false to look as a guest, or store a login first.`, 3);
  }
  const id = `inspect-${name}`;
  const journey: Journey = {
    version: 1,
    id,
    name: `Inspect ${request.url}`,
    description: 'Written by an inspection. It reads one page and changes nothing.',
    users: [request.label],
    requires_phase1: signIn,
    tags: ['inspect'],
    vars: {},
    retries: 0,
    steps: [...(signIn ? signInSteps(project, request.label) : []), { navigate: { url: request.url } }, { inspect: { name } }],
  };
  const checked = validateJourneyDocument(journey, project, projectSecretValues(project.id, home));
  if (!checked.valid) throw new HornetError(checked.errors.join('; '), 3);
  // Inspections are kept apart from the project's journeys and the agents' journeys, so a suite
  // never runs one.
  const dir = join(home, 'projects', project.id, 'inspections');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${id}.journey.yaml`);
  writeFileAtomic(file, stringify(journey));
  const result = await runSuite({
    project: project.id,
    journeyFiles: [file],
    journeyPathsAllowed: true,
    includeRegressions: false,
    users: [request.label],
    via: request.via ?? 'cli',
    ...(request.agentId ? { agentId: request.agentId } : {}),
    home,
  });
  const runDir = join(home, 'runs', result.run_id, request.label, id);
  const mapPath = join(runDir, `inspect-${name}.json`);
  if (existsSync(mapPath)) {
    const screenshot = join(runDir, `inspect-${name}.png`);
    return {
      ok: true,
      run_id: result.run_id,
      status: result.status,
      page: JSON.parse(readFileSync(mapPath, 'utf8')) as PageMap,
      ...(existsSync(screenshot) ? { screenshot } : {}),
      summary: result.parent.summary,
    };
  }
  const steps = result.users.flatMap((user) => user.journeys.flatMap((entry) => entry.steps));
  const failed = steps.find((step) => step.status !== 'pass' && step.status !== 'skipped');
  return {
    ok: false,
    run_id: result.run_id,
    status: result.status,
    error: failed?.error ?? 'The page was not read. The summary says why.',
    summary: result.parent.summary,
  };
}
