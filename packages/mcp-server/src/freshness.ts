import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The packages the MCP server loads. The runner runs in its own image, which `env reset` refreshes. */
const PACKAGES = ['core', 'controller', 'report', 'mcp-server'];

function newest(dir: string, extension: string): number {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) latest = Math.max(latest, newest(path, extension));
    else if (name.endsWith(extension)) latest = Math.max(latest, info.mtimeMs);
  }
  return latest;
}

/** Packages whose source changed after their last build. Empty when built, or when not run from the repo. */
export function staleBuilds(root: string): string[] {
  return PACKAGES.filter((name) => {
    const source = join(root, 'packages', name, 'src');
    const built = join(root, 'packages', name, 'dist');
    if (!existsSync(source) || !existsSync(built)) return false;
    return newest(source, '.ts') > newest(built, '.js');
  });
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : name.endsWith('.js') ? [path] : [];
    });
}

/**
 * A fingerprint of each package's built code. A rebuild that writes the same code keeps the same
 * fingerprint, so only a real change asks for a restart.
 */
export function buildFingerprints(root: string): Record<string, string> {
  const prints: Record<string, string> = {};
  for (const name of PACKAGES) {
    const hash = createHash('sha256');
    for (const file of files(join(root, 'packages', name, 'dist'))) {
      hash.update(file.slice(root.length));
      hash.update(readFileSync(file));
    }
    prints[name] = hash.digest('hex');
  }
  return prints;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const same = (left: Record<string, string>, right: Record<string, string>) => PACKAGES.every((name) => left[name] === right[name]);

/** Fingerprints once the build has stopped changing, so a build half written is never taken as the code. */
export function settledFingerprints(root: string, tries = 10): Record<string, string> {
  let previous = buildFingerprints(root);
  for (let attempt = 0; attempt < tries; attempt += 1) {
    pause(200);
    const next = buildFingerprints(root);
    if (same(previous, next)) return next;
    previous = next;
  }
  return previous;
}

/** Packages whose built code differs from the fingerprints taken earlier, such as when this server started. */
export function changedSince(root: string, earlier: Record<string, string>): string[] {
  if (same(buildFingerprints(root), earlier)) return [];
  const now = settledFingerprints(root);
  return PACKAGES.filter((name) => now[name] !== earlier[name]);
}
