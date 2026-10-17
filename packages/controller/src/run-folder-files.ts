import { lstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { readRegularFile } from '@hornet-swarm/core';

/** The path inside the run folder, or undefined when it would leave it. */
export function pathInside(runDir: string, relativePath: string): string | undefined {
  const root = resolve(runDir);
  const file = resolve(runDir, relativePath);
  if (file !== root && !file.startsWith(`${root}${sep}`)) return undefined;
  return file;
}

/** A regular file inside the run folder. A link is not evidence and is not followed. */
export function runFileIsRegular(runDir: string, relativePath: string): boolean {
  const file = pathInside(runDir, relativePath);
  if (!file) return false;
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export function readRunFile(runDir: string, relativePath: string): string | undefined {
  const file = pathInside(runDir, relativePath);
  if (!file) return undefined;
  try {
    if (!lstatSync(file).isFile()) return undefined;
    return readRegularFile(file).toString('utf8');
  } catch {
    return undefined;
  }
}
