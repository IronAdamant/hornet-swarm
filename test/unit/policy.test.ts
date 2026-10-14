import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateJourneyDocument } from '../../packages/core/src/journey.ts';
import {
  authorisationStatus,
  chaosPermitted,
  containerHost,
  domainCovered,
  interactiveOriginAllowed,
  isProductionLooking,
  matchGlob,
  originAllowed,
  overRateLimit,
  productionGate,
  projectDomainsAuthorised,
  rewriteForContainer,
  runnerOverload,
  signinBudget,
} from '../../packages/core/src/policy.ts';
import { authorisationSchema, projectSchema, type Authorisation, type Project } from '../../packages/core/src/schemas.ts';
import { chaosSequence } from '../../packages/core/src/chaos.ts';
import { decideAcquire, releaseLease } from '../../packages/core/src/lease.ts';
import { renderTemplate } from '../../packages/core/src/template.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const project = projectSchema.parse(parse(readFileSync(join(root, 'examples/projects/example-app/project.yaml'), 'utf8')));
const auth = authorisationSchema.parse(parse(readFileSync(join(root, 'examples/authorisations/example-app-owner.yaml'), 'utf8')));

function withProject(patch: Partial<Project> & { targets?: Partial<Project['targets']> }): Project {
  return projectSchema.parse({
    ...project,
    ...patch,
    targets: { ...project.targets, ...patch.targets },
  });
}

function withAuth(patch: Partial<Authorisation>): Authorisation {
  return authorisationSchema.parse({ ...auth, ...patch, scope: { ...auth.scope, ...patch.scope } });
}

describe('policy engine', () => {
  it('classifies hosts and allowlists', () => {
    expect(isProductionLooking('staging.example.com')).toBe(false);
    expect(isProductionLooking('localhost')).toBe(false);
    expect(isProductionLooking('127.0.0.1')).toBe(false);
    expect(isProductionLooking('host.docker.internal')).toBe(false);
    expect(isProductionLooking('app.localhost')).toBe(false);
    expect(isProductionLooking('10.1.2.3')).toBe(false);
    expect(isProductionLooking('192.168.0.8')).toBe(false);
    expect(isProductionLooking('172.20.1.4')).toBe(false);
    expect(isProductionLooking('172.15.1.1')).toBe(true);
    expect(isProductionLooking('dev.example.com')).toBe(false);
    expect(isProductionLooking('my-dev.example.com')).toBe(false);
    expect(isProductionLooking('device.example.com')).toBe(true);
    expect(isProductionLooking('contest.example.com')).toBe(true);
    expect(isProductionLooking('10.prod.example')).toBe(true);
    expect(isProductionLooking('app.example.com')).toBe(true);
    expect(originAllowed(project, '/login').ok).toBe(true);
    expect(originAllowed(project, 'https://cdn.example.com/app.js').ok).toBe(true);
    expect(originAllowed(project, 'https://evil.example/steal').ok).toBe(false);
    expect(originAllowed(project, 'http://[') .ok).toBe(false);
    expect(interactiveOriginAllowed(project, 'https://cdn.example.com/app.js')).toEqual({
      ok: false,
      reason: 'passive_origin',
    });
    expect(interactiveOriginAllowed(project, 'https://auth.example.com/session').ok).toBe(true);
  });

  it('requires an active authorisation before a domain is allowed', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(authorisationStatus(auth, now).ok).toBe(true);
    expect(authorisationStatus(withAuth({ revoked: true }), now).reason).toBe('authorisation_revoked');
    expect(authorisationStatus(withAuth({ valid_from: 'not-a-date' }), now).reason).toBe('authorisation_dates_invalid');
    expect(authorisationStatus(withAuth({ valid_from: '2027-01-01' }), now).reason).toBe('authorisation_not_yet_valid');
    expect(authorisationStatus(withAuth({ valid_until: '2026-01-01' }), now).reason).toBe('authorisation_expired');
    expect(domainCovered(auth, 'staging.example.com')).toBe(true);
    expect(domainCovered(auth, 'qa.staging.example.com')).toBe(true);
    expect(domainCovered(auth, '127.0.0.1')).toBe(true);
    expect(domainCovered(auth, '::1')).toBe(true);
    expect(domainCovered(auth, '[::1]')).toBe(true);
    expect(domainCovered(auth, 'example.com')).toBe(false);
    expect(projectDomainsAuthorised(project, auth, now).reason).toContain('auth.example.com');
    const covered = withAuth({
      scope: { ...auth.scope, domains: [...auth.scope.domains, 'auth.example.com'] },
    });
    expect(projectDomainsAuthorised(project, covered, now).ok).toBe(true);
    expect(projectDomainsAuthorised(project, withAuth({ id: 'other' }), now).reason).toBe('authorisation_mismatch');
    expect(projectDomainsAuthorised(project, withAuth({ valid_until: '2026-01-01' }), now).reason).toBe('authorisation_expired');
    expect(
      projectDomainsAuthorised(withProject({ environment: 'production' }), auth, now).reason,
    ).toBe('environment_not_authorised');
    const uncovered = withProject({
      targets: { base_url: 'https://secret.example', allowed_origins: ['https://secret.example'], allowed_third_party: [] },
    });
    expect(projectDomainsAuthorised(uncovered, withAuth({ scope: { ...auth.scope, environments: ['staging'] } }), now).reason).toContain(
      'domain_not_authorised',
    );
  });

  it('refuses production-looking hosts unless the record and the flag both allow them', () => {
    const prod = withProject({
      environment: 'production',
      targets: { base_url: 'https://app.example.com', allowed_origins: ['https://app.example.com'], allowed_third_party: [] },
    });
    const prodAuth = withAuth({ scope: { domains: ['app.example.com'], environments: ['production'] } });
    expect(productionGate(project, auth, false).reason).toBe('production_not_authorised');
    const stagingOnly = withProject({
      targets: {
        base_url: 'https://staging.example.com',
        allowed_origins: ['https://staging.example.com'],
        allowed_third_party: [{ origin: 'https://cdn.example.com', passive: true }],
      },
    });
    expect(productionGate(stagingOnly, auth, false).ok).toBe(true);
    expect(productionGate(prod, auth, true).reason).toBe('production_not_authorised');
    expect(productionGate(prod, prodAuth, false).reason).toBe('production_confirmation_required');
    expect(productionGate(prod, prodAuth, true).ok).toBe(true);
  });

  it('enforces sign-in budget, rate limit, chaos permission, and globs', () => {
    const now = Date.now();
    expect(signinBudget([now - 1000, now - 2000], now, 5).allowed).toBe(true);
    expect(signinBudget(Array.from({ length: 5 }, () => now - 1000), now, 5).allowed).toBe(false);
    expect(signinBudget([now - 2 * 60 * 60 * 1000], now, 1).allowed).toBe(true);
    expect(overRateLimit(1, 5)).toBe(false);
    expect(overRateLimit(2, 10)).toBe(true);
    expect(overRateLimit(1, 10)).toBe(false);
    expect(runnerOverload(12, 0, 0)).toBe(false);
    expect(runnerOverload(10, 2, 0)).toBe(true);
    expect(runnerOverload(10, 0, 2)).toBe(true);
    expect(runnerOverload(9, 9, 0)).toBe(false);
    expect(chaosPermitted(auth, project).reason).toBe('chaos_not_authorised');
    const chaosAuth = withAuth({ activities: ['functional_e2e', 'signin_smoke', 'access_control_checks', 'chaos'] });
    expect(chaosPermitted(chaosAuth, project).reason).toBe('chaos_not_authorised');
    const stagingOnly = withProject({
      targets: {
        base_url: 'https://staging.example.com',
        allowed_origins: ['https://staging.example.com'],
        allowed_third_party: [],
      },
    });
    expect(chaosPermitted(chaosAuth, stagingOnly).ok).toBe(true);
    const prod = withProject({
      environment: 'staging',
      targets: { base_url: 'https://app.example.com', allowed_origins: ['https://app.example.com'], allowed_third_party: [] },
    });
    expect(chaosPermitted(chaosAuth, prod).reason).toBe('chaos_not_authorised');
    expect(matchGlob('**/login', 'https://fixture.local/login')).toBe(true);
    expect(matchGlob('**/oauth/token', 'https://fixture.local/static/app.js')).toBe(false);
  });

  it('rejects journeys that leave the allowlist or embed a secret', () => {
    const journey = parse(readFileSync(join(root, 'examples/journeys/example-app/01-signin-dashboard.journey.yaml'), 'utf8'));
    expect(validateJourneyDocument(journey, project).valid).toBe(true);
    const offsite = structuredClone(journey) as { steps: Array<Record<string, unknown>> };
    offsite.steps.push({ navigate: { url: 'https://evil.example/phish' } });
    expect(validateJourneyDocument(offsite, project).valid).toBe(false);
    const leaked = structuredClone(journey) as { steps: Array<{ fill?: { selector: string; value?: string; credential?: string } }> };
    leaked.steps[1] = { fill: { selector: '#email', value: 'super-secret-password' } };
    const rejected = validateJourneyDocument(leaked, project, ['super-secret-password']);
    expect(rejected.valid).toBe(false);
    expect(rejected.errors.some((error) => error.includes('stored secret'))).toBe(true);
    const short = structuredClone(journey) as { steps: Array<{ fill?: { selector: string; value?: string } }> };
    short.steps[1] = { fill: { selector: '#email', value: 'pin is xyz' } };
    const shortRejected = validateJourneyDocument(short, project, ['xyz']);
    expect(shortRejected.valid).toBe(false);
    expect(shortRejected.errors.some((error) => error.includes('stored secret'))).toBe(true);
    const both = structuredClone(journey) as { steps: Array<Record<string, unknown>> };
    both.steps[1] = { fill: { selector: '#email', value: 'a', credential: 'qa-user-1.username' } };
    expect(validateJourneyDocument(both, project).errors.some((error) => error.includes('exactly one'))).toBe(true);
    const upload = structuredClone(journey) as { steps: Array<Record<string, unknown>> };
    upload.steps.push({ upload: { selector: 'input', fixture: '../secret.txt' } });
    expect(validateJourneyDocument(upload, project).valid).toBe(false);
  });
});

describe('container addresses', () => {
  it('rewrites loopback and this Mac, and leaves a foreign host alone', () => {
    expect(containerHost('localhost')).toBe('host.docker.internal');
    expect(containerHost('127.0.0.1')).toBe('host.docker.internal');
    expect(containerHost('::1')).toBe('host.docker.internal');
    expect(containerHost('10.0.0.8', ['10.0.0.8'])).toBe('host.docker.internal');
    expect(containerHost('192.168.1.50', ['10.0.0.8'])).toBe('192.168.1.50');
    expect(containerHost('app.example.com', ['10.0.0.8'])).toBe('app.example.com');
    expect(rewriteForContainer('http://127.0.0.1:4173/login')).toBe('http://host.docker.internal:4173/login');
    expect(rewriteForContainer('http://[::1]:4173/login')).toBe('http://host.docker.internal:4173/login');
    expect(rewriteForContainer('http://192.168.1.50:4173/login', ['10.0.0.8'])).toBe('http://192.168.1.50:4173/login');
  });
});

describe('leases, chaos, and templates', () => {
  it('gives one label to one agent and reclaims an expired lease', () => {
    const now = Date.parse('2026-10-10T00:00:00Z');
    const first = decideAcquire([], { project: 'fixture', label: 'qa-user-1', agentId: 'agent-a', now, candidates: ['qa-user-1', 'qa-user-2'] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = decideAcquire(first.leases, {
      project: 'fixture',
      label: 'qa-user-1',
      agentId: 'agent-b',
      now: now + 1000,
      candidates: ['qa-user-1', 'qa-user-2'],
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('busy');
    expect(second.nextFreeLabel).toBe('qa-user-2');
    expect(second.busyUntil).toBeTruthy();
    const greedy = decideAcquire(first.leases, { project: 'fixture', label: 'qa-user-2', agentId: 'agent-a', now: now + 1000 });
    expect(greedy.ok).toBe(false);
    if (greedy.ok) return;
    expect(greedy.reason).toBe('agent_already_holds');
    const later = decideAcquire(first.leases, {
      project: 'fixture',
      label: 'qa-user-1',
      agentId: 'agent-b',
      now: Date.parse(first.lease.expiresAt) + 1000,
    });
    expect(later.ok).toBe(true);
    expect(releaseLease(first.leases, 'fixture', 'agent-a', now + 1000)).toEqual([]);
  });

  it('repeats a chaos sequence for the same seed', () => {
    const left = chaosSequence('seed-42', 'default', 12);
    const right = chaosSequence('seed-42', 'default', 12);
    expect(left).toEqual(right);
    expect(chaosSequence('seed-42', 'default', 12)).not.toEqual(chaosSequence('seed-99', 'default', 12));
    expect(() => chaosSequence('seed-42', 'nope', 3)).toThrow(/unknown chaos profile/);
  });

  it('fills journey placeholders from non-secret vars', () => {
    const rendered = renderTemplate('/t/{{ users.qa-user-2.vars.tenant_slug }}/resource/{{vars.project_name}}', {
      vars: { project_name: 'QA Smoke Project' },
      users: { 'qa-user-2': { vars: { tenant_slug: 'b1' } } },
    });
    expect(rendered).toBe('/t/b1/resource/QA Smoke Project');
    expect(renderTemplate('{{missing.path}}', {})).toBe('{{missing.path}}');
  });
});
