import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HornetError } from './errors.js';
import { aegisHome } from './home.js';
import { readRunFile } from './run-folder-files.js';

const RUN_ID = /^run_[A-Za-z0-9_-]+$/;

/**
 * Deletes the saved runs of one job after its report has been delivered.
 * A run belongs to the job when its client report names that job. Page bodies and evidence
 * live in the run folder, so removing the folder removes them. Another job's runs stay.
 * A link is not followed.
 */
export function deleteAfterDelivery(jobId: string, home = aegisHome()): { removed: string[] } {
  if (!/^[a-z0-9-]+$/.test(jobId)) throw new HornetError('Unknown job.', 3);
  const root = join(home, 'runs');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { removed: [] };
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!RUN_ID.test(name)) continue;
    const dir = join(root, name);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const raw = readRunFile(dir, 'client-report.json');
    if (!raw) continue;
    try {
      if ((JSON.parse(raw) as { job_id?: unknown }).job_id !== jobId) continue;
    } catch {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return { removed };
}
