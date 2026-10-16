import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile } from '@hornet-swarm/core';
import { aegisHome } from './home.js';

/** Stopping must never fail on a home folder's mode, so only the link and owner checks apply here. */
export function engageKill(home = aegisHome()): void {
  writePrivateFile(join(home, 'KILL'), `${new Date().toISOString()}\n`);
}

export function releaseKill(home = aegisHome()): void {
  rmSync(join(home, 'KILL'), { force: true });
}
