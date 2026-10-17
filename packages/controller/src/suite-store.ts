import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { copyPrivateFile, copyPrivateTree, globalConfigSchema, privateDir, Redactor, rewriteForContainer, runResultSchema, validateJourneyYaml, writePrivateFile, type Journey, type Project, type RunResult } from '@hornet-swarm/core';
import { compareScreenshots, quarantineFile, redactTree, sanitizeNetworkLogs, summarizeReliability, timingChanged, writeEvidenceZip, type ReliabilityReport, type RichUser } from '@hornet-swarm/report';
import { loadProject } from './authorisation.js';
import { projectSecretValues, registerProjectSecrets } from './broker.js';
import { HornetError } from './errors.js';
import { aegisHome } from './home.js';

/**
 * Each label has its own baseline, because accounts can be meant to look different, such as a
 * visual-test account. A baseline saved before baselines were per label is still read for any
 * label that has none of its own.
 */
export function baselineDir(home: string, project: string, label: string, journeyId: string): string {
  const own = join(home, 'baselines', project, label, journeyId);
  if (existsSync(own)) return own;
  const shared = join(home, 'baselines', project, journeyId);
  return existsSync(join(shared, 'timings.json')) ? shared : own;
}

/** Words on the page compare equal when only their spacing differs. */
export function textChanged(before: string, after: string): boolean {
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
  return squash(before) !== squash(after);
}

export function applyBaselines(home: string, project: string, users: RichUser[]): void {
  for (const user of users) {
    for (const journey of user.journeys) {
      const base = baselineDir(home, project, user.label, journey.id);
      const timingFile = join(base, 'timings.json');
      const saved = existsSync(timingFile) ? (JSON.parse(readFileSync(timingFile, 'utf8')) as Record<string, number>) : {};
      for (const step of journey.steps) {
        const shot = step.screenshot_paths?.[0];
        const baseShot = join(base, `${step.index}.png`);
        let visual: 'same' | 'changed' | 'no_baseline' = 'same';
        let ratio: number | undefined;
        if (shot && existsSync(baseShot)) {
          const compared = compareScreenshots(readFileSync(baseShot), readFileSync(shot));
          visual = compared.visual;
          ratio = compared.ratio;
        } else if (shot) visual = 'no_baseline';
        const before = saved[String(step.index)];
        const timing = before === undefined ? 'no_baseline' : timingChanged(before, step.duration_ms) ? 'slower' : 'same';
        const shotText = shot ? shot.replace(/\.png$/, '.txt') : '';
        const baseText = join(base, `${step.index}.txt`);
        const text: 'same' | 'changed' | 'no_baseline' =
          shotText && existsSync(shotText) && existsSync(baseText)
            ? textChanged(readFileSync(baseText, 'utf8'), readFileSync(shotText, 'utf8'))
              ? 'changed'
              : 'same'
            : 'no_baseline';
        const notes: string[] = [];
        if (visual === 'changed') notes.push('The page looks different from the saved baseline.');
        if (text === 'changed') notes.push('The words on the page differ from the saved baseline.');
        if (timing === 'slower') notes.push('This step took longer than the saved baseline.');
        step.diff = {
          visual,
          ...(ratio !== undefined ? { visual_mismatch_ratio: ratio } : {}),
          timing,
          text,
          console: (step.console_error_count ?? 0) > (saved[`console-${step.index}`] ?? 0) ? 'new_errors' : before === undefined ? 'no_baseline' : 'same',
          network: (step.network_errors?.length ?? 0) > (saved[`network-${step.index}`] ?? 0) ? 'new_errors' : before === undefined ? 'no_baseline' : 'same',
          notes,
        };
      }
    }
  }
}

export function isInside(root: string, file: string): boolean {
  const base = resolve(root);
  const target = resolve(file);
  return target === base || target.startsWith(`${base}${sep}`);
}

export function acceptBaseline(project: string, runId: string, home = aegisHome()): { ok: true } {
  if (!/^[a-z0-9-]+$/.test(project)) throw new HornetError('Unknown project.', 3);
  if (!RUN_ID.test(runId)) throw new HornetError('Unknown run id.', 3);
  const runDir = join(home, 'runs', runId);
  const analysis = JSON.parse(readFileSync(join(runDir, 'analysis.json'), 'utf8')) as {
    project?: string;
    users: RichUser[];
  };
  if (analysis.project !== project) throw new HornetError('That run belongs to another project.', 3);
  for (const user of analysis.users) {
    if (!/^qa-user-\d+$/.test(user.label)) continue;
    for (const journey of user.journeys) {
      if (!/^[a-z0-9-]+$/.test(journey.id)) continue;
      const dir = privateDir(join(home, 'baselines', project, user.label, journey.id));
      const timings: Record<string, number> = {};
      for (const step of journey.steps) {
        timings[String(step.index)] = step.duration_ms;
        timings[`console-${step.index}`] = step.console_error_count ?? 0;
        timings[`network-${step.index}`] = step.network_errors?.length ?? 0;
        // Only files inside this run are copied. A prefix check still allows runDir/../../elsewhere.
        const shot = step.screenshot_paths?.[0];
        if (!shot || !isInside(runDir, shot) || !existsSync(shot)) continue;
        copyPrivateFile(shot, join(dir, `${step.index}.png`));
        const text = shot.replace(/\.png$/, '.txt');
        if (existsSync(text)) copyPrivateFile(text, join(dir, `${step.index}.txt`));
      }
      writePrivateFile(join(dir, 'timings.json'), `${JSON.stringify(timings)}\n`);
    }
  }
  return { ok: true };
}

export async function exportEvidence(project: string, runId: string, destination: string, home = aegisHome()): Promise<{ ok: true; path: string }> {
  const redactor = new Redactor();
  registerProjectSecrets(project, redactor, home);
  const runDir = join(home, 'runs', runId);
  if ((await redactTree(runDir, redactor)).length > 0) throw new Error('evidence failed the redaction scan');
  await writeEvidenceZip(runDir, destination, redactor);
  return { ok: true, path: destination };
}

export function cleanupRetention(home = aegisHome(), days?: number): string[] {
  const keepDays = days ?? retentionDays(home);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const root = join(home, 'runs');
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    if (statSync(dir).mtimeMs < cutoff) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

export function retentionDays(home: string): number {
  try {
    const parsed = globalConfigSchema.parse(parse(readFileSync(join(home, 'config.yaml'), 'utf8')));
    return parsed.results_retention_days;
  } catch {
    return globalConfigSchema.parse({}).results_retention_days;
  }
}

/** Reliability for one project across its saved runs, newest `last` runs only. */
/**
 * Reliability across recent runs. Chaos runs are left out by default, because a disruption the
 * harness added is not the site's everyday reliability. `chaos: 'only'` reports on them alone.
 */
export function reliabilityReport(projectId: string, last = 20, home = aegisHome(), chaos: 'exclude' | 'only' = 'exclude'): ReliabilityReport {
  if (!/^[a-z0-9-]+$/.test(projectId)) throw new HornetError('Unknown project.', 3);
  const root = join(home, 'runs');
  const runs: RunResult[] = [];
  let leftOut = 0;
  if (existsSync(root)) {
    for (const name of readdirSync(root).filter((entry) => entry.startsWith('run_')).sort()) {
      try {
        const parsed = runResultSchema.safeParse(JSON.parse(readFileSync(join(root, name, 'run.json'), 'utf8')));
        if (!parsed.success || parsed.data.project !== projectId) continue;
        const withChaos = runUsedChaos(join(root, name));
        if (withChaos === (chaos === 'only')) runs.push(parsed.data);
        else leftOut += 1;
      } catch {
        // A run folder without a readable run.json is skipped.
      }
    }
  }
  const size = Math.max(1, Math.min(500, Math.trunc(last)));
  const report = summarizeReliability(projectId, runs.sort((left, right) => left.started_at.localeCompare(right.started_at)).slice(-size));
  if (leftOut > 0) {
    report.notes.push(
      chaos === 'only'
        ? `Only chaos runs are counted. ${leftOut} run${leftOut === 1 ? '' : 's'} without chaos ${leftOut === 1 ? 'was' : 'were'} left out.`
        : `${leftOut} chaos run${leftOut === 1 ? ' was' : 's were'} left out. See them with --chaos.`,
    );
  }
  return report;
}

export function runUsedChaos(runDir: string): boolean {
  try {
    const analysis = JSON.parse(readFileSync(join(runDir, 'analysis.json'), 'utf8')) as { chaos?: unknown };
    return Boolean(analysis.chaos);
  } catch {
    return false;
  }
}

export function listProjectUsers(projectId: string, home = aegisHome()): { label: string; role: string; tenant: string }[] {
  const project = loadProject(projectId, home);
  return project.users.map((user) => ({ label: user.label, role: user.role, tenant: user.tenant }));
}

export function quarantineHit(hit: string): void {
  const file = hit.split('!')[0] ?? hit;
  if (existsSync(file)) quarantineFile(file);
}

export function fileContainsSecret(file: string, redactor: Redactor): boolean {
  if (!file || !existsSync(file)) return false;
  try {
    const bytes = readFileSync(file);
    return redactor.contains(bytes.toString('utf8')) || redactor.contains(bytes.toString('latin1'));
  } catch {
    return false;
  }
}

/**
 * Moves a job's files out of the runner folder into the run folder. Symbolic links written by
 * the runner are skipped. Session headers are masked and auth endpoint bodies are dropped
 * before anything else reads the files. The runner copy is deleted, so no unredacted trace
 * stays behind in the runner folder.
 */
export async function moveArtifacts(home: string, project: Project, label: string, runId: string, journeyId: string): Promise<void> {
  const runEntry = join(home, 'runners', project.id, label, runId);
  if (!lstatExists(runEntry)) return;
  // The run's folder is first moved out of the runner's reach in one rename. A rename moves a
  // link itself rather than what it points to, so a runner that put a link where its folder
  // belongs can never make the copy or the delete below reach a file elsewhere on this Mac.
  const staged = join(privateDir(join(home, 'staging')), `${label}-${runId}-${randomBytes(4).toString('hex')}`);
  renameSync(runEntry, staged);
  try {
    const source = join(staged, journeyId);
    const stagedLink = lstatSync(staged).isSymbolicLink();
    const sourceLink = !stagedLink && lstatExists(source) && lstatSync(source).isSymbolicLink();
    if (stagedLink || sourceLink) {
      throw new HornetError('The runner wrote a link where its results belong. Nothing was copied, and the link was removed.', 4);
    }
    if (!lstatExists(source)) return;
    const destination = privateDir(join(home, 'runs', runId, label, journeyId));
    copyPrivateTree(source, destination);
    const redactor = new Redactor();
    registerProjectSecrets(project.id, redactor, home);
    await sanitizeNetworkLogs(destination, authEndpointPatterns(project), redactor);
  } finally {
    if (lstatExists(staged) && lstatSync(staged).isSymbolicLink()) unlinkSync(staged);
    else rmSync(staged, { recursive: true, force: true });
  }
}

export function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bodies dropped from the network logs: the project's auth_endpoints, and always the
 * sign-in page itself, where a login form usually posts and a session token usually comes back.
 */
export function authEndpointPatterns(project: Project): string[] {
  const signin = new URL(project.auth.signin_url, project.targets.base_url);
  const patterns = new Set(project.auth.auth_endpoints);
  for (const url of [signin.toString(), rewriteForContainer(signin.toString(), macAddresses())]) {
    const parsed = new URL(url);
    patterns.add(`${parsed.origin}${parsed.pathname}`);
  }
  return [...patterns];
}

export function loadJourneys(home: string, project: Project, files: string[], includeRegressions: boolean, pathsAllowed: boolean): { text: string; file: string; journey?: Journey }[] {
  const selected =
    files.length > 0
      ? files.map((file) => resolveJourneyArg(home, project, file, pathsAllowed))
      : readdirSync(resolveJourneys(home, project)).filter((name) => name.endsWith('.yaml')).map((name) => join(resolveJourneys(home, project), name));
  const loaded = selected.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  if (!includeRegressions) return loaded;
  // An open regression joins the run once. It is skipped when the run already has a journey with that id.
  // While the project still has that journey, its current version runs, so fixing a journey's own
  // mistake also fixes its regression. The saved copy runs only when the project's journey is gone.
  const ids = new Set(loaded.map((entry) => journeyIdOf(entry.text)));
  const ownerDir = resolveJourneys(home, project);
  const current = new Map<string, { file: string; text: string }>();
  for (const name of readdirSync(ownerDir).filter((entry) => entry.endsWith('.yaml'))) {
    const file = join(ownerDir, name);
    const text = readFileSync(file, 'utf8');
    const id = journeyIdOf(text);
    if (id) current.set(id, { file, text });
  }
  const regressions = regressionFiles(home, project.id)
    .map((file) => {
      const text = readFileSync(file, 'utf8');
      return current.get(journeyIdOf(text) ?? '') ?? { file, text };
    })
    .filter((entry) => !ids.has(journeyIdOf(entry.text)));
  return [...loaded, ...regressions];
}

export function journeyIdOf(text: string): string | undefined {
  try {
    const parsed = parse(text) as { id?: unknown };
    return typeof parsed?.id === 'string' ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

export function agentJourneysDir(home: string, project: string): string {
  return join(home, 'projects', project, 'agent-journeys');
}

/**
 * Saves a journey an agent wrote, after the same checks as any journey: the schema, the
 * allowlist and passive origins, no literal secret, and fixture paths inside the fixtures
 * folder. It cannot replace an owner journey with the same id. Returns the saved path.
 */
export function saveAgentJourney(projectId: string, yamlText: string, home = aegisHome()): { path: string; id: string } {
  const project = loadProject(projectId, home);
  const checked = validateJourneyYaml(yamlText, project, projectSecretValues(project.id, home));
  if (!checked.valid || !checked.journey) throw new HornetError(checked.errors.join('; '), 3);
  const id = checked.journey.id;
  const ownerDir = resolveJourneys(home, project);
  if (existsSync(join(ownerDir, `${id}.journey.yaml`)) || ownerJourneyIds(ownerDir).has(id)) {
    throw new HornetError(`A project journey already uses the id ${id}. Pick another id.`, 3);
  }
  const dir = agentJourneysDir(home, project.id);
  privateDir(dir);
  const path = join(dir, `${id}.journey.yaml`);
  writePrivateFile(path, yamlText.endsWith('\n') ? yamlText : `${yamlText}\n`);
  return { path, id };
}

export function ownerJourneyIds(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => journeyIdOf(readFileSync(join(dir, name), 'utf8')))
      .filter((id): id is string => Boolean(id)),
  );
}

export const JOURNEY_ID = /^[a-z0-9-]+$/;
export const RUN_ID = /^run_[A-Za-z0-9_-]+$/;

/**
 * A journey id is looked up in the project's journeys, then in the agent journeys. A file path is
 * read as given, but only when paths are allowed, which is the owner's CLI and never an agent.
 */
export function resolveJourneyArg(home: string, project: Project, file: string, pathsAllowed: boolean): string {
  const looksLikePath = file.endsWith('.yaml') || file.endsWith('.yml') || file.includes('/');
  if (looksLikePath && pathsAllowed) return file;
  if (!JOURNEY_ID.test(file)) throw new HornetError(`${file} is not a journey id. Name a journey by its id, such as signin-dashboard.`, 3);
  for (const dir of [resolveJourneys(home, project), agentJourneysDir(home, project.id)]) {
    const direct = join(dir, `${file}.journey.yaml`);
    if (existsSync(direct)) return direct;
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.yaml')) continue;
      const path = join(dir, name);
      if (journeyIdOf(readFileSync(path, 'utf8')) === file) return path;
    }
  }
  throw new HornetError(`Unknown journey ${file}.`, 3);
}

export function resolveJourneys(home: string, project: Project): string {
  if (project.journeys_dir.startsWith('/')) return project.journeys_dir;
  return join(home, 'projects', project.id, project.journeys_dir);
}

export function regressionFiles(home: string, project: string): string[] {
  const dir = join(home, 'regressions', project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.journey.yaml')).map((name) => join(dir, name));
}

/**
 * A journey that failed, errored, or was flaky for any label in a suite run is copied into the
 * regression folder and joins later suite runs. Three suite runs in a row where it passed for
 * every label mark it fixed and retire the copy. The ledger stays as the record.
 */
export function rememberRegression(home: string, project: string, entry: { file: string; journey?: Journey }, outcome: 'fail' | 'pass' | 'none'): void {
  if (!entry.journey || outcome === 'none') return;
  const dir = privateDir(join(home, 'regressions', project));
  const file = join(dir, `${entry.journey.id}.journey.yaml`);
  const ledgerPath = join(dir, `${entry.journey.id}.json`);
  if (outcome === 'fail') {
    if (entry.file !== file) writePrivateFile(file, readFileSync(entry.file));
    writePrivateFile(ledgerPath, `${JSON.stringify({ state: 'open', consecutive: 0 })}\n`);
    return;
  }
  if (!existsSync(ledgerPath)) return;
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { state: string; consecutive: number };
  if (ledger.state !== 'open') return;
  const consecutive = ledger.consecutive + 1;
  const fixed = consecutive >= 3;
  writePrivateFile(ledgerPath, `${JSON.stringify({ state: fixed ? 'fixed' : 'open', consecutive })}\n`);
  if (fixed) rmSync(file, { force: true });
}

export function listRegressions(home: string, project: string): string[] {
  const dir = join(home, 'regressions', project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.journey.yaml'));
}

export function macAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.push(entry.address);
  }
  return addresses;
}
