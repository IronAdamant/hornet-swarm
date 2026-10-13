import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { decideAcquire, heartbeatLease, releaseLease, type AcquireDecision, type Lease } from '@hornet-swarm/core';
import { writeAudit } from './audit.js';
import { aegisHome, ensureDir } from './home.js';

const held = new Set<string>();
let signalsHooked = false;

function heldKey(home: string, project: string, agentId: string): string {
  return `${home}\0${project}\0${agentId}`;
}

/** Ctrl-C, a closed terminal, and SIGTERM all release this process's logins. Only SIGKILL leaves one until its TTL. */
function hookSignals(): void {
  if (signalsHooked || process.env.VITEST) return;
  signalsHooked = true;
  const exits: [NodeJS.Signals, number][] = [
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ];
  for (const [signal, code] of exits) {
    process.once(signal, () => {
      try {
        releaseHeldLeases();
      } finally {
        process.exit(code);
      }
    });
  }
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
  /** The most logins held in the project at once. See parallelRunners in core. */
  maxActive?: number;
  /** False leaves a refusal out of the audit log, for a caller that retries while it waits. Defaults to true. */
  auditRefusal?: boolean;
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
      ...(input.maxActive !== undefined ? { maxActive: input.maxActive } : {}),
    });
    writeLeases(home, next.leases);
    return next;
  });
  if (decision.ok) {
    held.add(heldKey(home, input.project, input.agentId));
    hookSignals();
  }
  if (!decision.ok && input.auditRefusal === false) return decision;
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

/** The agent that holds a label right now, if any. */
export function leaseHolder(project: string, label: string, home = aegisHome()): string | undefined {
  const now = Date.now();
  return readLeases(home).find((lease) => lease.project === project && lease.label === label && Date.parse(lease.expiresAt) > now)?.agentId;
}

/** Labels another agent holds in this project right now. */
export function leasesHeldByOthers(project: string, agentId: string, home = aegisHome()): string[] {
  const now = Date.now();
  return readLeases(home)
    .filter((lease) => lease.project === project && lease.agentId !== agentId && Date.parse(lease.expiresAt) > now)
    .map((lease) => lease.label);
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
  writeFileAtomic(join(home, 'leases.json'), `${JSON.stringify(leases)}\n`);
}

/** Writes beside the target and renames over it, so a crash never leaves half a file. */
export function writeFileAtomic(file: string, body: string, mode = 0o600): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, body, { mode });
  renameSync(temp, file);
}

function withLock<T>(home: string, fn: () => T): T {
  return withFileLock(home, 'leases', fn);
}

/**
 * A cross-process lock on `<home>/<name>.lock`. The lock folder is built aside with its pid file
 * and renamed into place, so a holder is never seen without its pid. A lock left by a dead
 * process is taken over by one waiter at a time: the waiter that wins `<name>.lock.takeover`
 * checks again that the lock is still the dead one before removing it, so two waiters can
 * never both remove a lock and both believe they hold it.
 */
export function withFileLock<T>(home: string, name: string, fn: () => T, timeoutMs = 5_000): T {
  ensureDir(home);
  const lock = join(home, `${name}.lock`);
  const takeover = `${lock}.takeover`;
  const started = Date.now();
  for (;;) {
    if (claimLock(lock)) break;
    if (lockIsDead(lock)) {
      takeOverDeadLock(lock, takeover);
      continue;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for the ${name} lock.`);
    pause(20);
  }
  try {
    return fn();
  } finally {
    discardLock(lock);
  }
}

/** Moves the lock aside in one rename before deleting it, so a new holder's lock is never emptied by mistake. */
function discardLock(lock: string): void {
  const aside = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.old`;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

function claimLock(lock: string): boolean {
  const staged = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.new`;
  mkdirSync(staged);
  writeFileSync(join(staged, 'pid'), `${process.pid}\n`);
  try {
    // A folder renames over a missing path, never over an existing one, so only one claimant wins.
    renameSync(staged, lock);
    return true;
  } catch {
    rmSync(staged, { recursive: true, force: true });
    return false;
  }
}

function takeOverDeadLock(lock: string, takeover: string): void {
  try {
    mkdirSync(takeover);
  } catch {
    // Another waiter is taking over. A takeover folder left by a crash is cleared after two seconds.
    try {
      if (Date.now() - statSync(takeover).mtimeMs > 2_000) rmSync(takeover, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
    pause(20);
    return;
  }
  try {
    if (lockIsDead(lock)) discardLock(lock);
  } finally {
    rmSync(takeover, { recursive: true, force: true });
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsDead(lock: string): boolean {
  if (!existsSync(lock)) return false;
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
