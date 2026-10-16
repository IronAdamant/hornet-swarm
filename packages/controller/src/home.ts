import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateDir } from '@hornet-swarm/core';

export function aegisHome(): string {
  return process.env.AEGIS_HOME ?? join(homedir(), '.hornet-swarm');
}

export function ensureHome(): string {
  return privateDir(aegisHome());
}
