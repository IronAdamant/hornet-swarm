import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function aegisHome(): string {
  return process.env.AEGIS_HOME ?? join(homedir(), '.hornet-swarm');
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function ensureHome(): string {
  return ensureDir(aegisHome());
}
