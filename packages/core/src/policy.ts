import type { Authorisation, Journey, Project } from './schemas.js';

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
/** Top-level names that never reach a public site (RFC 2606, RFC 6762, and Docker's own names). */
const PRIVATE_TLDS = new Set(['localhost', 'test', 'local', 'internal']);

/**
 * Only a subdomain names an environment. `staging.example.com` and `my-dev.example.com` are not
 * production. `dev.to` and `shop-test-payments.com` are, because the word is the site's own name.
 * The last two labels are treated as the site's name, so `qa.example.co.uk` still counts as qa.
 */
export function isProductionLooking(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return false;
  if (isRfc1918Address(host)) return false;
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length > 1 && PRIVATE_TLDS.has(labels[labels.length - 1] ?? '')) return false;
  const subdomains = labels.slice(0, -2).flatMap((label) => label.split('-'));
  if (subdomains.some((word) => NON_PRODUCTION_LABELS.has(word))) return false;
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
  if (origin === new URL(project.targets.base_url).origin) return { ok: true };
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

/**
 * Passive third parties may load into a page, such as fonts or a CDN. They are not covered by the
 * authorisation, so the browser may never navigate its page to them or type into them.
 */
export function passiveOrigins(project: Project): string[] {
  return project.targets.allowed_third_party.filter((third) => third.passive).map((third) => new URL(third.origin).origin);
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

/**
 * A public practice site is shared by everyone who practises on it. These caps keep one swarm
 * polite: at most 10 requests a second to the site across every runner, 5 per runner, a burst
 * of 20, and 6 runners.
 */
export const PUBLIC_PRACTICE_LIMITS = { requestsPerSecondTotal: 10, requestsPerSecondPerRunner: 5, burstPerRunner: 20, runners: 6 } as const;

export function practiceLimits(project: Project, auth: Authorisation): PolicyResult {
  if (auth.basis !== 'public_practice') return { ok: true };
  if (project.environment !== 'test') return { ok: false, reason: 'public_practice_environment_must_be_test' };
  const caps = PUBLIC_PRACTICE_LIMITS;
  if (project.limits.max_requests_per_second_total > caps.requestsPerSecondTotal) return { ok: false, reason: `public_practice_limit:max_requests_per_second_total<=${caps.requestsPerSecondTotal}` };
  if (project.limits.max_requests_per_second_per_runner > caps.requestsPerSecondPerRunner) return { ok: false, reason: `public_practice_limit:max_requests_per_second_per_runner<=${caps.requestsPerSecondPerRunner}` };
  if (project.limits.request_burst_per_runner > caps.burstPerRunner) return { ok: false, reason: `public_practice_limit:request_burst_per_runner<=${caps.burstPerRunner}` };
  if (project.runners.count > caps.runners) return { ok: false, reason: `public_practice_limit:runners.count<=${caps.runners}` };
  if (parallelRunners(project) > caps.runners) return { ok: false, reason: `public_practice_limit:max_parallel_runners<=${caps.runners}` };
  return { ok: true };
}

/**
 * How many runners can work on this project at once. Each running login holds a lease, so the
 * count is also capped by the number of labels.
 */
export function parallelRunners(project: Project): number {
  return Math.max(1, Math.min(project.limits.max_parallel_runners, project.users.length));
}

/**
 * The per-second rate one runner is given. The egress proxy sees HTTPS only as tunnels, so it
 * cannot count requests inside them. The total is kept by giving each of the runners that may
 * work at once an equal share of `max_requests_per_second_total`, never more than its own limit.
 */
export function perRunnerRate(project: Project): { rps: number; burst: number } {
  const share = project.limits.max_requests_per_second_total / parallelRunners(project);
  const rps = Math.min(project.limits.max_requests_per_second_per_runner, share);
  return { rps, burst: project.limits.request_burst_per_runner };
}

export type ActivityName = Authorisation['activities'][number];

/** An access_denied check, or an expected 401 or 403, probes another account's data. */
export function isAccessControlAssertion(type: string, value?: string): boolean {
  if (type === 'access_denied') return true;
  return type === 'http_status' && (value === '401' || value === '403');
}

/** A journey is an access-control check when it is tagged as one or asserts that access is refused. */
export function isAccessControlJourney(journey: Pick<Journey, 'steps' | 'tags'>): boolean {
  if (journey.tags.some((tag) => tag.toLowerCase() === 'access-control')) return true;
  return journey.steps.some((step) => 'assert' in step && isAccessControlAssertion(step.assert.type, step.assert.value));
}

/** A journey reads security headers when it has a passive_security step or the tag passive-security. */
export function isPassiveSecurityJourney(journey: Pick<Journey, 'steps' | 'tags'>): boolean {
  if (journey.tags.some((tag) => tag.toLowerCase() === 'passive-security')) return true;
  return journey.steps.some((step) => 'passive_security' in step);
}

/**
 * The work a run will do must be among the authorisation's activities. A sign-in check needs
 * signin_smoke or functional_e2e. A journey needs functional_e2e, or access_control_checks when it
 * is an access-control check. A passive security step also needs passive_security_checks. Chaos is
 * checked by chaosPermitted.
 */
export function activitiesPermitted(auth: Authorisation, work: { signIn: boolean; journeys: ReadonlyArray<Pick<Journey, 'id' | 'steps' | 'tags'>> }): PolicyResult {
  const allowed = new Set<ActivityName>(auth.activities);
  if (work.signIn && !allowed.has('signin_smoke') && !allowed.has('functional_e2e')) {
    return { ok: false, reason: 'activity_not_authorised:signin_smoke' };
  }
  for (const journey of work.journeys) {
    const needed: ActivityName = isAccessControlJourney(journey) ? 'access_control_checks' : 'functional_e2e';
    if (!allowed.has(needed)) return { ok: false, reason: `activity_not_authorised:${needed}:${journey.id}` };
    if (isPassiveSecurityJourney(journey) && !allowed.has('passive_security_checks')) {
      return { ok: false, reason: `activity_not_authorised:passive_security_checks:${journey.id}` };
    }
  }
  return { ok: true };
}

export function productionGate(project: Project, auth: Authorisation, confirmProduction: boolean): PolicyResult {
  // A public practice site's own published statement says what it is for, and its domains are
  // already checked against the authorisation. Its hostname not saying "test" does not make it production.
  if (auth.basis === 'public_practice') return { ok: true };
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
  if (auth.basis === 'public_practice') return { ok: false, reason: 'chaos_not_authorised' };
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

/** `**` crosses slashes and `*` does not. Every other character, `?` included, is literal. A URL also matches when only its query or fragment differs. */
export function matchGlob(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*');
  const anchored = new RegExp(`^${expression}$`);
  return anchored.test(value) || anchored.test(value.replace(/[?#].*$/, ''));
}
