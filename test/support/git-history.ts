import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '../..');

/** Whether this checkout has `revision`. A shallow clone does not, and CI fetches full history for these proofs. */
export function hasRevision(revision: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function fileAt(revision: string, path: string): string {
  return execFileSync('git', ['show', `${revision}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Unpacks `folder` as it was at `revision` beside the live package, so its imports resolve the
 * same dependencies, and returns the path. `cleanup` removes it.
 */
export function folderAt(revision: string, folder: string, besideDir: string): { path: string; cleanup: () => void } {
  const target = mkdtempSync(join(besideDir, '.past-'));
  const archive = execFileSync('git', ['archive', revision, folder], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', target], { input: archive });
  return { path: join(target, folder), cleanup: () => rmSync(target, { recursive: true, force: true }) };
}
