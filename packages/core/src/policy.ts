import type { Authorisation, Project } from './schemas.js';

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
  'host.containers.internal',
  'gateway.docker.internal',
]);

export type PolicyDenial = { ok: false; reason: string };
export type PolicyOk = { ok: true };
export type PolicyResult = PolicyOk | PolicyDenial;

const NON_PRODUCTION_LABELS = new Set(['staging', 'test', 'qa', 'dev', 'localhost']);

export function isProductionLooking(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return false;
  if (isRfc1918Address(host)) return false;
  const labels = host.split(/[.-]/).filter((label) => label.length > 0);
  if (labels.some((label) => NON_PRODUCTION_LABELS.has(label))) return false;
  return true;
}

export function containerHost(hostname: string, localAddresses: readonly string[] = []): string {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const locals = new Set(localAddresses.map((address) => address.toLowerCase().replace(/^\[|\]$/g, '')));
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || locals.has(host)) return 'host.docker.internal';
  return hostname;
}

export function rewriteForContainer(url: string, localAddresses: readonly string[] = []): string {
  const parsed = new URL(url);
  const next = containerHost(parsed.hostname, localAddresses);
  if (next === parsed.hostname) return parsed.toString();
  parsed.hostname = next;
  return parsed.toString();
}

function isRfc1918Address(host: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  const [first, second] = host.split('.').map((part) => Number(part));
  if (first === undefined || second === undefined) return false;
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  return first === 172 && second >= 16 && second <= 31;
}

function gateHosts(project: Project): string[] {
  const hosts = [new URL(project.targets.base_url).hostname];
  for (const origin of project.targets.allowed_origins) hosts.push(new URL(origin).hostname);
  for (const third of project.targets.allowed_third_party) {
    if (!third.passive) hosts.push(new URL(third.origin).hostname);
  }
  return hosts;
}

export function authorisationStatus(auth: Authorisation, now = new Date()): PolicyResult {
  if (auth.revoked) return { ok: false, reason: 'authorisation_revoked' };
  const from = Date.parse(auth.valid_from);
  const until = Date.parse(auth.valid_until);
  const time = now.getTime();
  if (Number.isNaN(from) || Number.isNaN(until)) return { ok: false, reason: 'authorisation_dates_invalid' };
  if (time < from) return { ok: false, reason: 'authorisation_not_yet_valid' };
  if (time > until) return { ok: false, reason: 'authorisation_expired' };
  return { ok: true };
}

export function domainCovered(auth: Authorisation, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return auth.scope.domains.some((domain) => {
    const allowed = domain.toLowerCase();
    if (allowed === host) return true;
    if (allowed === 'localhost' && (host === '127.0.0.1' || host === '::1')) return true;
    return host.endsWith(`.${allowed}`);
  });
}

export function originAllowed(project: Project, url: string): PolicyResult {
  let parsed: URL;
  try {
    parsed = new URL(url, project.targets.base_url);
  } catch {
    return { ok: false, reason: 'bad_url' };
  }
  const origin = parsed.origin;
  if (project.targets.allowed_origins.includes(origin)) return { ok: true };
  const third = project.targets.allowed_third_party.find((entry) => entry.origin === origin);
  if (third) return { ok: true };
  return { ok: false, reason: 'blocked_by_allowlist' };
}

export function interactiveOriginAllowed(project: Project, url: string): PolicyResult {
  const decision = originAllowed(project, url);
  if (!decision.ok) return decision;
  const origin = new URL(url, project.targets.base_url).origin;
  const third = project.targets.allowed_third_party.find((entry) => entry.origin === origin);
  if (third?.passive) return { ok: false, reason: 'passive_origin' };
  return { ok: true };
}

export function projectDomainsAuthorised(project: Project, auth: Authorisation, now = new Date()): PolicyResult {
  const active = authorisationStatus(auth, now);
  if (!active.ok) return active;
  if (project.authorisation_id !== auth.id) return { ok: false, reason: 'authorisation_mismatch' };
  if (!auth.scope.environments.includes(project.environment)) {
    return { ok: false, reason: 'environment_not_authorised' };
  }
  const hosts = new Set<string>();
  hosts.add(new URL(project.targets.base_url).hostname);
  for (const origin of project.targets.allowed_origins) hosts.add(new URL(origin).hostname);
  for (const third of project.targets.allowed_third_party) {
    if (!third.passive) hosts.add(new URL(third.origin).hostname);
  }
  for (const host of hosts) {
    if (!domainCovered(auth, host)) return { ok: false, reason: `domain_not_authorised:${host}` };
  }
  return { ok: true };
}

export function productionGate(project: Project, auth: Authorisation, confirmProduction: boolean): PolicyResult {
  const hosts = gateHosts(project);
  if (!hosts.some((host) => isProductionLooking(host))) return { ok: true };
  if (!auth.scope.environments.includes('production')) return { ok: false, reason: 'production_not_authorised' };
  if (!confirmProduction) return { ok: false, reason: 'production_confirmation_required' };
  return { ok: true };
}

export function signinBudget(timestamps: number[], now: number, max: number, windowMs = 60 * 60 * 1000): { allowed: boolean; used: number } {
  const used = timestamps.filter((stamp) => now - stamp < windowMs).length;
  return { allowed: used < max, used };
}

export function overRateLimit(errors: number, total: number): boolean {
  if (total < 10) return false;
  return errors / total > 0.1;
}

export function chaosPermitted(auth: Authorisation, project: Project): PolicyResult {
  if (!auth.activities.includes('chaos')) return { ok: false, reason: 'chaos_not_authorised' };
  if (project.environment === 'production' && !auth.scope.environments.includes('production')) {
    return { ok: false, reason: 'chaos_not_authorised' };
  }
  if (gateHosts(project).some((host) => isProductionLooking(host)) && !auth.scope.environments.includes('production')) {
    return { ok: false, reason: 'chaos_not_authorised' };
  }
  return { ok: true };
}

export function runnerOverload(requests: number, bucketRefusals: number, httpOverloads: number): boolean {
  return overRateLimit(bucketRefusals + httpOverloads, requests);
}

export function matchGlob(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*');
  return new RegExp(`^${expression}$`).test(value) || new RegExp(expression).test(value);
}
