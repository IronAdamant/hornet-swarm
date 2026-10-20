import { join } from 'node:path';
import { appendRedactedFile, Redactor } from '@hornet-swarm/core';
import { aegisHome } from './home.js';

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
  const stamped = {
    ...event,
    at: new Date().toISOString(),
  };
  const safe = redactor.redactUnknown(stamped);
  appendRedactedFile(join(home, 'audit.log'), redactor.seal(`${JSON.stringify(safe)}\n`));
}
