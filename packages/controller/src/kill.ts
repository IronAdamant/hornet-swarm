import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aegisHome, ensureDir } from './home.js';

export function engageKill(home = aegisHome()): void {
  ensureDir(home);
  writeFileSync(join(home, 'KILL'), `${new Date().toISOString()}\n`);
}

export function releaseKill(home = aegisHome()): void {
  rmSync(join(home, 'KILL'), { force: true });
}
