import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { readRegularFile, Redactor, runResultSchema, writeRedactedFile } from '@hornet-swarm/core';
import { findingsMarkdown, verifyFindings, type SavedRun } from '@hornet-swarm/report';
import { registerProjectSecrets } from './broker.js';
import { HornetError } from './errors.js';
import { aegisHome } from './home.js';

export type FindingsReport = { ok: true; markdown: string; path?: string } | { ok: false; problems: string[] };

/**
 * Checks a report's findings against the project's saved runs and renders only if every piece of
 * evidence is there. A refused report lists what was missing and writes nothing.
 */
export function checkFindings(input: unknown, options: { home?: string; out?: string } = {}): FindingsReport {
  const home = options.home ?? aegisHome();
  const project = typeof input === 'object' && input !== null ? (input as { project?: unknown }).project : undefined;
  if (typeof project !== 'string' || !/^[a-z0-9-]+$/.test(project)) throw new HornetError('Unknown project.', 3);
  const { verified, problems } = verifyFindings(input, savedRuns(project, home));
  if (problems.length > 0) return { ok: false, problems };
  const redactor = new Redactor();
  registerProjectSecrets(project, redactor, home);
  const sealed = redactor.seal(findingsMarkdown(verified));
  if (options.out) writeRedactedFile(options.out, sealed, { parent: 'chosen' });
  return { ok: true, markdown: sealed, ...(options.out ? { path: options.out } : {}) };
}

/** A findings file is YAML or JSON: `project`, then `findings`, each with its `evidence`. */
export function readFindingsFile(path: string): unknown {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new HornetError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
}

/** A regular file inside the run folder. A link is not evidence and is not followed. */
function runFileIsRegular(runDir: string, relativePath: string): boolean {
  const file = pathInside(runDir, relativePath);
  if (!file) return false;
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function readRunFile(runDir: string, relativePath: string): string | undefined {
  const file = pathInside(runDir, relativePath);
  if (!file) return undefined;
  try {
    if (!lstatSync(file).isFile()) return undefined;
    return readRegularFile(file).toString('utf8');
  } catch {
    return undefined;
  }
}

function pathInside(runDir: string, relativePath: string): string | undefined {
  const root = resolve(runDir);
  const file = resolve(runDir, relativePath);
  if (file !== root && !file.startsWith(`${root}${sep}`)) return undefined;
  return file;
}

function savedRuns(project: string, home: string): Map<string, SavedRun> {
  const root = join(home, 'runs');
  const runs = new Map<string, SavedRun>();
  if (!existsSync(root)) return runs;
  for (const runId of readdirSync(root).filter((name) => /^run_[A-Za-z0-9_-]+$/.test(name))) {
    const runDir = join(root, runId);
    let parsed;
    try {
      parsed = runResultSchema.safeParse(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')));
    } catch {
      continue;
    }
    if (!parsed.success || parsed.data.project !== project) continue;
    const result = parsed.data;
    runs.set(runId, {
      result,
      pageTexts: (label, journeyId, index) => {
        const step = result.users.find((user) => user.label === label)?.journeys.find((journey) => journey.id === journeyId)?.steps.find((entry) => entry.index === index);
        const names = [`failed-step-${index}.txt`, ...(step?.screenshot ? [basename(step.screenshot).replace(/\.png$/, '.txt')] : [])];
        return names.flatMap((name) => {
          const text = readRunFile(runDir, join(label, journeyId, name));
          return text === undefined ? [] : [text];
        });
      },
      hasFile: (relativePath) => runFileIsRegular(runDir, relativePath),
    });
  }
  return runs;
}
