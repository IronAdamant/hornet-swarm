import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile } from '@hornet-swarm/core';
import { aegisHome } from './home.js';

/**
 * Stopping must never fail on a home folder's mode, such as a 0755 home from an older version, so
 * the home is not checked here. The KILL file itself is still a new 0600 file that replaces any link.
 */
export function engageKill(home = aegisHome()): void {
  writePrivateFile(join(home, 'KILL'), `${new Date().toISOString()}\n`, { parent: 'chosen' });
}

export function releaseKill(home = aegisHome()): void {
  rmSync(join(home, 'KILL'), { force: true });
}
