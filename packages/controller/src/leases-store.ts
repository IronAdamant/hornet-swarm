import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideAcquire, heartbeatLease, releaseLease, type AcquireDecision, type Lease } from '@aegis/core';
import { writeAudit } from './audit.js';
import { aegisHome, ensureDir } from './home.js';

export function acquireLease(input: {
  project: string;
  label: string;
  agentId: string;
  runId?: string;
  ttlMs?: number;
  candidates?: string[];
  home?: string;
  via?: 'cli' | 'mcp';
}): AcquireDecision {
  const home = input.home ?? aegisHome();
  const decision = withLock(home, () => {
    const current = readLeases(home);
    const next = decideAcquire(current, {
      project: input.project,
      label: input.label,
      agentId: input.agentId,
      ...(input.runId ? { runId: input.runId } : {}),
      now: Date.now(),
      ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
      ...(input.candidates ? { candidates: input.candidates } : {}),
    });
    writeLeases(home, next.leases);
    return next;
  });
  writeAudit(
    {
      interface: input.via ?? 'cli',
      agent: input.agentId,
      action: decision.ok ? 'lease_acquire' : 'lease_refuse',
      project: input.project,
      labels: [input.label],
      ...(input.runId ? { run_id: input.runId } : {}),
      result: decision.ok ? 'granted' : decision.reason,
    },
    undefined,
    home,
  );
  return decision;
}

export function releaseStoredLease(project: string, agentId: string, home = aegisHome(), via: 'cli' | 'mcp' = 'cli'): void {
  withLock(home, () => {
    writeLeases(home, releaseLease(readLeases(home), project, agentId, Date.now()));
  });
  writeAudit({ interface: via, agent: agentId, action: 'lease_release', project, result: 'released' }, undefined, home);
}

export function heartbeatStoredLease(project: string, agentId: string, home = aegisHome()): void {
  withLock(home, () => {
    writeLeases(home, heartbeatLease(readLeases(home), project, agentId, Date.now()));
  });
}

function readLeases(home: string): Lease[] {
  try {
    return JSON.parse(readFileSync(join(home, 'leases.json'), 'utf8')) as Lease[];
  } catch {
    return [];
  }
}

function writeLeases(home: string, leases: Lease[]): void {
  ensureDir(home);
  writeFileSync(join(home, 'leases.json'), `${JSON.stringify(leases)}\n`);
}

function withLock<T>(home: string, fn: () => T): T {
  ensureDir(home);
  const lock = join(home, 'leases.lock');
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() - started > 5_000) throw new Error('Timed out waiting for the lease lock.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
