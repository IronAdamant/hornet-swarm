import { execFileSync, type StdioOptions } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

/**
 * Builds the named packages only when a source file is newer than its output. tsc rewrites
 * dist in place, so a rebuild during the suite can hand another test file a half-written module.
 * CI builds before the tests, so there the suite never rebuilds.
 */
export function buildPackagesIfStale(names: string[], stdio: StdioOptions = 'ignore'): void {
  const stale = names.filter((name) => !outputIsFresh(join(root, 'packages', name.replace('@hornet-swarm/', ''))));
  if (stale.length === 0) return;
  execFileSync('pnpm', [...stale.flatMap((name) => ['--filter', name]), 'build'], { cwd: root, stdio });
}

/** Every src/x.ts has a dist/x.js at least as new. A stale output left by a deleted source does not count. */
function outputIsFresh(packageDir: string): boolean {
  const src = join(packageDir, 'src');
  const sources = filesUnder(src).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
  if (sources.length === 0) return false;
  return sources.every((source) => {
    const output = join(packageDir, 'dist', relative(src, source).replace(/\.ts$/, '.js'));
    return existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs;
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}
