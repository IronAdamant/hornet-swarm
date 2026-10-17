import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '../..');

/**
 * Whether this checkout has `revision`. A shallow clone does not, so a proof skips there, except
 * under HORNET_REQUIRE_HISTORY (set in CI), where a missing revision fails instead of skipping.
 */
export function hasRevision(revision: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    if (process.env.HORNET_REQUIRE_HISTORY === '1') throw new Error(`${revision} is not in this checkout. Fetch full history (fetch-depth: 0) so the proof can run.`);
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
  // Writing the archive to a file avoids EPIPE. Piping it to tar can close before the write finishes.
  const archivePath = join(target, 'archive.tar');
  writeFileSync(archivePath, archive);
  try {
    execFileSync('tar', ['-xf', archivePath, '-C', target]);
  } finally {
    rmSync(archivePath, { force: true });
  }
  return { path: join(target, folder), cleanup: () => rmSync(target, { recursive: true, force: true }) };
}
