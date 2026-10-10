import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor } from '@hornet-swarm/core';
import { aegisHome, ensureDir } from './home.js';

export type AuditEvent = {
  interface: 'cli' | 'mcp';
  agent?: string;
  action: string;
  project?: string;
  targets?: string[];
  labels?: string[];
  run_id?: string;
  result: string;
};

export function writeAudit(event: AuditEvent, redactor = new Redactor(), home = aegisHome()): void {
  ensureDir(home);
  const stamped = {
    ...event,
    at: new Date().toISOString(),
  };
  const safe = redactor.redactUnknown(stamped);
  appendFileSync(join(home, 'audit.log'), `${JSON.stringify(safe)}\n`, { mode: 0o600 });
}
