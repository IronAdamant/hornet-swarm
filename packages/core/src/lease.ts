export type Lease = {
  project: string;
  label: string;
  agentId: string;
  runId?: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
};

export type AcquireRequest = {
  project: string;
  label: string;
  agentId: string;
  runId?: string;
  now: number;
  ttlMs?: number;
  candidates?: string[];
  /** The most logins that may be held in this project at once. Each held login is one working runner. */
  maxActive?: number;
};

export type AcquireDecision =
  | { ok: true; lease: Lease; leases: Lease[] }
  | { ok: false; reason: 'busy' | 'agent_already_holds' | 'parallel_limit'; busyUntil?: string; heldLabel?: string; nextFreeLabel?: string; leases: Lease[] };

const DEFAULT_TTL = 30 * 60 * 1000;

export function activeLeases(leases: Lease[], now: number): Lease[] {
  return leases.filter((lease) => Date.parse(lease.expiresAt) > now);
}

export function decideAcquire(leases: Lease[], request: AcquireRequest): AcquireDecision {
  const current = activeLeases(leases, request.now);
  const held = current.find((lease) => lease.agentId === request.agentId && lease.project === request.project);
  if (held && held.label !== request.label) {
    return { ok: false, reason: 'agent_already_holds', heldLabel: held.label, leases: current };
  }
  if (held && held.label === request.label) {
    const renewed = renew(held, request.now, request.ttlMs ?? DEFAULT_TTL, request.runId);
    return { ok: true, lease: renewed, leases: current.map((lease) => (lease === held ? renewed : lease)) };
  }
  const owner = current.find((lease) => lease.project === request.project && lease.label === request.label);
  if (owner) {
    const nextFreeLabel = (request.candidates ?? []).find(
      (label) => !current.some((lease) => lease.project === request.project && lease.label === label),
    );
    return {
      ok: false,
      reason: 'busy',
      busyUntil: owner.expiresAt,
      nextFreeLabel,
      leases: current,
    };
  }
  if (request.maxActive !== undefined) {
    const active = current.filter((lease) => lease.project === request.project);
    if (active.length >= request.maxActive) {
      const soonest = active.map((lease) => lease.expiresAt).sort()[0];
      return { ok: false, reason: 'parallel_limit', ...(soonest ? { busyUntil: soonest } : {}), leases: current };
    }
  }
  const lease: Lease = {
    project: request.project,
    label: request.label,
    agentId: request.agentId,
    ...(request.runId ? { runId: request.runId } : {}),
    acquiredAt: new Date(request.now).toISOString(),
    heartbeatAt: new Date(request.now).toISOString(),
    expiresAt: new Date(request.now + (request.ttlMs ?? DEFAULT_TTL)).toISOString(),
  };
  return { ok: true, lease, leases: [...current, lease] };
}

export function releaseLease(leases: Lease[], project: string, agentId: string, now: number): Lease[] {
  return activeLeases(leases, now).filter((lease) => !(lease.project === project && lease.agentId === agentId));
}

export function heartbeatLease(leases: Lease[], project: string, agentId: string, now: number, ttlMs = DEFAULT_TTL): Lease[] {
  return activeLeases(leases, now).map((lease) =>
    lease.project === project && lease.agentId === agentId ? renew(lease, now, ttlMs, lease.runId) : lease,
  );
}

function renew(lease: Lease, now: number, ttlMs: number, runId?: string): Lease {
  return {
    ...lease,
    ...(runId ? { runId } : {}),
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}
