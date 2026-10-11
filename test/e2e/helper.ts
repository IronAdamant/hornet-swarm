import { execFileSync } from 'node:child_process';
import { releaseStoredLease } from '../../packages/controller/dist/index.js';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { Redactor } from '../../packages/core/dist/index.js';

export const root = join(import.meta.dirname, '..', '..');
export const cli = join(root, 'packages/cli/dist/main.js');
export const home = join(homedir(), '.hornet-swarm');
export const secret = 'FixtureOnly-s3cret"<&value>';
export const otherSecret = 'FixtureOnly-other"<&value>';
export const journeys = join(root, 'test/e2e/journeys');

export function hornet(args: string[], input?: string, timeout = 180_000): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout,
      ...(input !== undefined ? { input } : {}),
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: failed.status ?? 1,
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? ''),
    };
  }
}

export function clearSignins(): void {
  rmSync(join(home, 'projects/fixture/signin.json'), { force: true });
  rmSync(join(home, 'regressions/fixture'), { recursive: true, force: true });
  rmSync(join(home, 'KILL'), { force: true });
  try {
    const leases = JSON.parse(readFileSync(join(home, 'leases.json'), 'utf8')) as { project: string; agentId: string }[];
    for (const lease of leases) releaseStoredLease(lease.project, lease.agentId, home, 'cli');
  } catch {
    // No lease file yet.
  }
}

export async function containsSecret(dir: string, value = secret): Promise<string[]> {
  const redactor = new Redactor();
  redactor.register('qa-user-1.password', value);
  redactor.register('qa-user-1.username', 'qa1@example.test');
  const hits: string[] = [];
  const walk = (current: string): string[] => {
    if (!existsSync(current)) return [];
    return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  };
  for (const file of walk(dir)) {
    const bytes = readFileSync(file);
    if (redactor.contains(bytes.toString('utf8')) || redactor.contains(bytes.toString('latin1'))) hits.push(file);
    if (!file.endsWith('.zip')) continue;
    const zip = await JSZip.loadAsync(bytes);
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (!entry || entry.dir) continue;
      const text = await entry.async('string');
      if (redactor.contains(text)) hits.push(`${file}!${name}`);
    }
  }
  return hits;
}

export function latestRun(): string {
  const runs = join(home, 'runs');
  const names = readdirSync(runs)
    .filter((name) => name.startsWith('run_') && existsSync(join(runs, name, 'run.json')))
    .sort();
  const name = names[names.length - 1];
  if (!name) throw new Error('no run');
  return join(runs, name);
}

export function readRun(dir = latestRun()): { dir: string; result: Record<string, unknown>; summary: string; analysis: Record<string, unknown> } {
  return {
    dir,
    result: JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Record<string, unknown>,
    summary: readFileSync(join(dir, 'summary.md'), 'utf8'),
    analysis: JSON.parse(readFileSync(join(dir, 'analysis.json'), 'utf8')) as Record<string, unknown>,
  };
}

export async function resetFixture(extra: Record<string, unknown> = {}): Promise<void> {
  const response = await fetch('http://127.0.0.1:4173/__admin/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      users: [
        { email: 'qa1@example.test', password: secret, label: 'qa-user-1', tenant: 'a1', resources: ['res_a1_001'], ...((extra.user1 as object) ?? {}) },
        { email: 'qa2@example.test', password: 'FixtureOnly-other"<&value>', label: 'qa-user-2', tenant: 'b1', resources: ['res_b1_002'] },
      ],
      ...extra,
      user1: undefined,
    }),
  });
  if (!response.ok) throw new Error(`fixture reset ${response.status}`);
}

export function writeProjectFile(relative: string, text: string): void {
  const path = join(home, relative);
  writeFileSync(path, text);
}
