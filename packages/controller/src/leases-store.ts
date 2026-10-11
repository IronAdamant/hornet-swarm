import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideAcquire, heartbeatLease, releaseLease, type AcquireDecision, type Lease } from '@hornet-swarm/core';
import { writeAudit } from './audit.js';
import { aegisHome, ensureDir } from './home.js';

const held = new Set<string>();
let sigtermHooked = false;

function heldKey(home: string, project: string, agentId: string): string {
  return `${home}\0${project}\0${agentId}`;
}

function hookSigterm(): void {
  if (sigtermHooked || process.env.VITEST) return;
  sigtermHooked = true;
  process.once('SIGTERM', () => {
    try {
      releaseHeldLeases();
    } finally {
      process.exit(143);
    }
  });
}

export function releaseHeldLeases(): void {
  for (const key of [...held]) {
    const [home, project, agentId] = key.split('\0');
    if (!home || !project || !agentId) {
      held.delete(key);
      continue;
    }
    try {
      releaseStoredLease(project, agentId, home, 'cli');
    } catch {
      held.delete(key);
    }
  }
}

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
  if (decision.ok) {
    held.add(heldKey(home, input.project, input.agentId));
    hookSigterm();
  }
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
  held.delete(heldKey(home, project, agentId));
  writeAudit({ interface: via, agent: agentId, action: 'lease_release', project, result: 'released' }, undefined, home);
}

export function heartbeatStoredLease(
  project: string,
  agentId: string,
  home = aegisHome(),
  ttlMs?: number,
  via: 'cli' | 'mcp' = 'cli',
): void {
  withLock(home, () => {
    writeLeases(home, heartbeatLease(readLeases(home), project, agentId, Date.now(), ttlMs));
  });
  writeAudit({ interface: via, agent: agentId, action: 'lease_renew', project, result: 'renewed' }, undefined, home);
}

function readLeases(home: string): Lease[] {
  const file = join(home, 'leases.json');
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('leases.json could not be read');
  }
  if (!Array.isArray(parsed)) throw new Error('leases.json could not be read');
  return parsed as Lease[];
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
      writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
      break;
    } catch {
      if (lockIsDead(lock)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
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

function lockIsDead(lock: string): boolean {
  const pidFile = join(lock, 'pid');
  if (!existsSync(pidFile)) {
    try {
      return Date.now() - statSync(lock).mtimeMs > 1_000;
    } catch {
      return false;
    }
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as NodeJS.ErrnoException).code : '';
    return code !== 'EPERM';
  }
}
