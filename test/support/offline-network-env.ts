import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OFFLINE_NETWORK_GUARD = resolve(fileURLToPath(new URL('.', import.meta.url)), 'offline-network.mjs');

/** Makes every Node process a test starts load the guard too, so a script a test runs stays offline. */
export function guardChildProcesses(): void {
  const flag = `--import=${pathToFileURL(OFFLINE_NETWORK_GUARD).href}`;
  const current = process.env.NODE_OPTIONS ?? '';
  if (!current.includes(flag)) process.env.NODE_OPTIONS = `${current} ${flag}`.trim();
}
