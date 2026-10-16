import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  activitiesPermitted,
  authorisationSchema,
  base64Forms,
  decideAcquire,
  isAccessControlJourney,
  isProductionLooking,
  matchGlob,
  parallelRunners,
  passiveOrigins,
  perRunnerRate,
  practiceLimits,
  projectSchema,
  Redactor,
  validateJourneyDocument,
  type Authorisation,
  type Journey,
  type Project,
} from '../../packages/core/src/index.ts';
import { assertAuthorisationUsable, documentMatches, documentPath } from '../../packages/controller/src/authorisation.ts';
import { keychainAddCommand, listFields, storedFields } from '../../packages/controller/src/broker.ts';
import { MAX_CODES_PER_GATE, startCredentialPage } from '../../packages/controller/src/credentials.ts';
import { acceptBaseline, authEndpointPatterns, baselineDir, moveArtifacts, runOutcome, textChanged } from '../../packages/controller/src/suite.ts';
import { saveSwarmBoard, swarmSnapshot } from '../../packages/controller/src/swarm.ts';
import { pollOperatorGate } from '../../packages/runner/src/job.ts';
import { isolationBreach, summaryMarkdown, type RichUser } from '../../packages/report/src/render.ts';

const root = join(import.meta.dirname, '..', '..');
const readYaml = (path: string): unknown => parse(readFileSync(path, 'utf8'));
const example = (id: string): Project => projectSchema.parse(readYaml(join(root, 'examples/projects', id, 'project.yaml')));
const exampleAuth = (id: string): Authorisation => authorisationSchema.parse(readYaml(join(root, 'examples/authorisations', `${id}.yaml`)));

function project(overrides: Record<string, unknown> = {}): Project {
  return projectSchema.parse({
    id: 'p',
    name: 'p',
    authorisation_id: 'a',
    environment: 'test',
    targets: {
      base_url: 'https://app.test.example',
      allowed_origins: ['https://app.test.example'],
      allowed_third_party: [
        { origin: 'https://cdn.other.com', passive: true },
        { origin: 'https://pay.other.com', passive: false },
      ],
    },
    auth: { signin_url: '/login', selectors: { username: '#u', password: '#p', submit: '#s' }, success: [{ type: 'url_contains', value: '/' }] },
    runners: {},
    limits: {},
    users: [{ label: 'qa-user-1', role: 'r', tenant: 't', vars: { cdn: 'https://cdn.other.com/x' } }],
    ...overrides,
  });
}

function journey(steps: Journey['steps'], extra: Partial<Journey> = {}): Journey {
  return { version: 1, id: 'j', name: 'j', description: '', users: ['qa-user-1'], requires_phase1: true, tags: [], vars: {}, retries: 0, steps, ...extra };
}

function auth(activities: Authorisation['activities'], extra: Partial<Authorisation> = {}): Authorisation {
  return {
    id: 'a',
    basis: 'owner',
    client: 'c',
    granted_to: 'g',
    scope: { domains: ['test.example'], environments: ['test'] },
    activities,
    exclusions: [],
    valid_from: '2026-01-01',
    valid_until: '2099-01-01',
    notes: '',
    ...extra,
  };
}

describe('authorisation activities are enforced', () => {
  const plain = journey([{ navigate: { url: '/' } }]);
  const denied = journey([{ assert: { type: 'access_denied' } }], { id: 'denied' });
  const forbidden = journey([{ assert: { type: 'http_status', value: '403' } }], { id: 'forbidden' });
  const tagged = journey([{ navigate: { url: '/' } }], { id: 'tagged', tags: ['Access-Control'] });
  const notFound = journey([{ assert: { type: 'http_status', value: '404' } }], { id: 'not-found' });

  it('needs signin_smoke or functional_e2e for the sign-in check', () => {
    expect(activitiesPermitted(auth(['access_control_checks']), { signIn: true, journeys: [] })).toEqual({ ok: false, reason: 'activity_not_authorised:signin_smoke' });
    expect(activitiesPermitted(auth(['signin_smoke']), { signIn: true, journeys: [] }).ok).toBe(true);
    expect(activitiesPermitted(auth(['functional_e2e']), { signIn: true, journeys: [] }).ok).toBe(true);
    expect(activitiesPermitted(auth(['chaos']), { signIn: false, journeys: [] }).ok).toBe(true);
  });

  it('needs functional_e2e for a journey and access_control_checks for an access check', () => {
    expect(activitiesPermitted(auth(['signin_smoke']), { signIn: true, journeys: [plain] })).toEqual({ ok: false, reason: 'activity_not_authorised:functional_e2e:j' });
    expect(activitiesPermitted(auth(['signin_smoke', 'functional_e2e']), { signIn: true, journeys: [plain, notFound] }).ok).toBe(true);
    for (const check of [denied, forbidden, tagged]) {
      expect(activitiesPermitted(auth(['signin_smoke', 'functional_e2e']), { signIn: true, journeys: [check] }).reason).toBe(`activity_not_authorised:access_control_checks:${check.id}`);
      expect(activitiesPermitted(auth(['signin_smoke', 'access_control_checks']), { signIn: true, journeys: [check] }).ok).toBe(true);
    }
    expect(isAccessControlJourney(notFound)).toBe(false);
    expect(isAccessControlJourney(journey([{ assert: { type: 'http_status', value: '401' } }]))).toBe(true);
  });

  it('refuses an access-control journey against a public practice site, whose authorisation cannot list it', () => {
    const practice = exampleAuth('the-internet-practice');
    expect(activitiesPermitted(practice, { signIn: true, journeys: [denied] }).ok).toBe(false);
    const statusCodes = journeySchemaParse(join(root, 'examples/projects/the-internet/journeys/status-codes.journey.yaml'));
    expect(activitiesPermitted(practice, { signIn: true, journeys: [statusCodes] }).ok).toBe(true);
  });

  it('lets every shipped example journey run under its own authorisation', () => {
    const pairs: Array<[string, string, string]> = [
      ['the-internet', 'the-internet-practice', 'examples/projects/the-internet/journeys'],
      ['example-app', 'example-app-owner', 'examples/journeys/example-app'],
    ];
    for (const [, authId, dir] of pairs) {
      const journeys = readdirSync(join(root, dir)).map((name) => journeySchemaParse(join(root, dir, name)));
      expect(activitiesPermitted(exampleAuth(authId), { signIn: true, journeys }).ok, authId).toBe(true);
    }
  });
});

function journeySchemaParse(path: string): Journey {
  const checked = validateJourneyDocument(readYaml(path), example(path.includes('the-internet') ? 'the-internet' : 'example-app'));
  if (!checked.journey) throw new Error(`${path}: ${checked.errors.join('; ')}`);
  return checked.journey;
}

describe('the signed authorisation document', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-doc-'));
  const body = 'Signed by the owner on 1 October 2026.\n';
  const hash = createHash('sha256').update(body).digest('hex');
  mkdirSync(join(home, 'authorisations'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'authorisations', 'signed.txt'), body);

  it('passes when the file is there and its hash matches', () => {
    expect(documentMatches(auth(['signin_smoke'], { document: { path: 'signed.txt', sha256: hash } }), home)).toEqual({ ok: true });
    expect(documentMatches(auth(['signin_smoke'], { document: { path: join(home, 'authorisations', 'signed.txt'), sha256: hash.toUpperCase() } }), home).ok).toBe(true);
    expect(documentMatches(auth(['signin_smoke'], { basis: 'public_practice' }), home).ok).toBe(true);
  });

  it('stops on a missing file or a different hash, and names the real hash', () => {
    const missing = documentMatches(auth(['signin_smoke'], { document: { path: 'gone.pdf', sha256: hash } }), home);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('authorisation_document_missing');
    const placeholder = documentMatches(auth(['signin_smoke'], { document: { path: 'signed.txt', sha256: '0'.repeat(64) } }), home);
    expect(placeholder.ok).toBe(false);
    expect(placeholder.reason).toContain(`has sha256 ${hash}`);
    expect(() => assertAuthorisationUsable(auth(['signin_smoke'], { document: { path: 'signed.txt', sha256: '0'.repeat(64) } }), home)).toThrow(/authorisation_document_mismatch/);
    expect(() => assertAuthorisationUsable(auth(['signin_smoke'], { valid_until: '2020-01-01' }), home)).toThrow(/authorisation_expired/);
  });

  it('reads ~/ from this account and a relative path from the authorisations folder', () => {
    expect(documentPath('~/docs/a.pdf', home)).toBe(join(homedir(), 'docs/a.pdf'));
    expect(documentPath('a.pdf', home)).toBe(join(home, 'authorisations', 'a.pdf'));
    expect(documentPath('/abs/a.pdf', home)).toBe('/abs/a.pdf');
  });
});

describe('passive third parties', () => {
  const config = project();

  it('refuses a navigate step to a passive origin however it is written', () => {
    const cases = [
      'https://cdn.other.com/x',
      '//cdn.other.com/x',
      '{{users.qa-user-1.vars.cdn}}',
    ];
    for (const url of cases) {
      expect(validateJourneyDocument(journey([{ navigate: { url } }]), config).errors, url).toEqual(['step 0: passive_origin']);
    }
    expect(validateJourneyDocument(journey([{ navigate: { url: '{{vars.cdn}}' } }], { vars: { cdn: 'https://cdn.other.com/' } }), config).valid).toBe(false);
    expect(validateJourneyDocument(journey([{ navigate: { url: '//evil.example.net/' } }]), config).errors).toEqual(['step 0: blocked_by_allowlist']);
  });

  it('still allows the site, its own paths, and an interactive third party', () => {
    for (const url of ['/', '/t/{{vars.slug}}/x', 'https://app.test.example/a', 'https://pay.other.com/checkout']) {
      expect(validateJourneyDocument(journey([{ navigate: { url } }], { vars: { slug: 'a1' } }), config).valid, url).toBe(true);
    }
    const noListedBase = project({ targets: { base_url: 'https://app.test.example', allowed_origins: ['https://api.test.example'], allowed_third_party: [] } });
    expect(validateJourneyDocument(journey([{ navigate: { url: '/home' } }]), noListedBase).valid).toBe(true);
  });

  it('lists the passive origins for the runner', () => {
    expect(passiveOrigins(config)).toEqual(['https://cdn.other.com']);
  });
});

describe('the request total holds across runners', () => {
  it('gives each runner that can work at once an equal share of the total', () => {
    const shared = project({
      users: Array.from({ length: 6 }, (_, index) => ({ label: `qa-user-${index + 1}`, role: 'r', tenant: 't', vars: {} })),
      runners: { count: 6 },
      limits: { max_parallel_runners: 6, max_requests_per_second_total: 10, max_requests_per_second_per_runner: 5, request_burst_per_runner: 20 },
    });
    expect(parallelRunners(shared)).toBe(6);
    expect(perRunnerRate(shared).rps).toBeCloseTo(10 / 6);
    expect(perRunnerRate(shared).rps * parallelRunners(shared)).toBeLessThanOrEqual(shared.limits.max_requests_per_second_total + 1e-9);
    const internet = example('the-internet');
    expect(perRunnerRate(internet)).toEqual({ rps: 2, burst: 10 });
    const one = project({ limits: { max_parallel_runners: 10 } });
    expect(parallelRunners(one)).toBe(1);
    expect(perRunnerRate(one).rps).toBe(5);
  });

  it('refuses a practice project that could run more than six runners at once', () => {
    const users = Array.from({ length: 7 }, (_, index) => ({ label: `qa-user-${index + 1}`, role: 'r', tenant: 't', vars: {} }));
    const base = example('the-internet');
    const config = { ...base, users, runners: { ...base.runners, count: 6 }, limits: { ...base.limits, max_parallel_runners: 7 } };
    const record = { ...exampleAuth('the-internet-practice'), valid_from: '2026-01-01', valid_until: '2099-01-01' };
    expect(practiceLimits(config, record)).toEqual({ ok: false, reason: 'public_practice_limit:max_parallel_runners<=6' });
  });

  it('refuses a new login once the project has max_parallel_runners in use, but renews one already held', () => {
    const now = Date.parse('2026-10-14T10:00:00Z');
    const first = decideAcquire([], { project: 'p', label: 'qa-user-1', agentId: 'a', now, maxActive: 1 });
    if (!first.ok) throw new Error('first lease refused');
    const second = decideAcquire(first.leases, { project: 'p', label: 'qa-user-2', agentId: 'b', now, maxActive: 1 });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('parallel_limit');
      expect(second.busyUntil).toBe(first.lease.expiresAt);
    }
    expect(decideAcquire(first.leases, { project: 'p', label: 'qa-user-1', agentId: 'a', now: now + 1, maxActive: 1 }).ok).toBe(true);
    expect(decideAcquire(first.leases, { project: 'other', label: 'qa-user-2', agentId: 'b', now, maxActive: 1 }).ok).toBe(true);
  });
});

describe('redaction', () => {
  it('finds a password inside base64 at any offset, and in base64url', () => {
    const password = 'Tr0ub4dor&3xyz';
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', password);
    for (const prefix of ['', 'a', 'ab', '{"user":"qa1","pass":"']) {
      const encoded = Buffer.from(`${prefix}${password}","tail":1}`).toString('base64');
      expect(redactor.contains(encoded), JSON.stringify(prefix)).toBe(true);
      expect(redactor.redact(encoded)).toContain('[REDACTED:qa-user-1.password]');
      const url = encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(redactor.contains(url), `url ${JSON.stringify(prefix)}`).toBe(true);
    }
    expect(redactor.contains(Buffer.from(`Basic qa1:${password}`).toString('base64'))).toBe(true);
    expect(redactor.contains(Buffer.from('nothing secret in here at all').toString('base64'))).toBe(false);
  });

  it('keeps short base64 fragments out, so short values do not match by chance', () => {
    expect(base64Forms('bob').every((form) => form.length <= 4 || form === Buffer.from('bob').toString('base64'))).toBe(true);
    expect(base64Forms('Tr0ub4dor&3xyz').length).toBeGreaterThan(3);
  });

  it('masks API and CSRF token headers too', () => {
    const redactor = new Redactor();
    const masked = redactor.redactUnknown({ 'X-Api-Key': 'k', 'x-csrf-token': 't', accept: 'text/html' }) as Record<string, string>;
    expect(masked['X-Api-Key']).toBe('[REDACTED:header]');
    expect(masked['x-csrf-token']).toBe('[REDACTED:header]');
    expect(masked.accept).toBe('text/html');
  });

  it('treats ? in an auth endpoint pattern as a literal character', () => {
    expect(matchGlob('https://h/login?next=*', 'https://h/login?next=a')).toBe(true);
    expect(matchGlob('https://h/logi?', 'https://h/login')).toBe(false);
    expect(matchGlob('https://h/login?', 'https://h/login?')).toBe(true);
  });

  it('always drops the sign-in page bodies, as the site and as the container sees it', () => {
    const rootSignIn = project({
      targets: { base_url: 'http://127.0.0.1:4173', allowed_origins: ['http://127.0.0.1:4173'], allowed_third_party: [] },
      auth: { ...project().auth, signin_url: '/', auth_endpoints: [] },
    });
    expect(authEndpointPatterns(rootSignIn)).toContain('http://127.0.0.1:4173/');
    const local = project({ targets: { base_url: 'http://127.0.0.1:4173', allowed_origins: ['http://127.0.0.1:4173'], allowed_third_party: [] }, auth: { ...project().auth, auth_endpoints: ['**/session'] } });
    expect(authEndpointPatterns(local)).toEqual(['**/session', 'http://127.0.0.1:4173/login', 'http://host.docker.internal:4173/login']);
  });
});

describe('production-looking hosts', () => {
  it('reads an environment only from a subdomain', () => {
    expect(isProductionLooking('dev.to')).toBe(true);
    expect(isProductionLooking('shop-test-payments.com')).toBe(true);
    expect(isProductionLooking('qa.com')).toBe(true);
    expect(isProductionLooking('app.staging.com')).toBe(true);
    expect(isProductionLooking('staging.example.com')).toBe(false);
    expect(isProductionLooking('my-dev.example.com')).toBe(false);
    expect(isProductionLooking('qa.example.co.uk')).toBe(false);
    expect(isProductionLooking('app.test')).toBe(false);
    expect(isProductionLooking('db.internal')).toBe(false);
    expect(isProductionLooking('printer.local.')).toBe(false);
  });
});

describe('cross-account findings', () => {
  const user = (steps: RichUser['journeys'][number]['steps']): RichUser => ({
    label: 'qa-user-1',
    phase1: { status: 'pass', duration_ms: 1 },
    journeys: [{ id: 'j', name: 'Status codes', status: 'fail', duration_ms: 1, steps }],
  });
  const step = (index: number, status: 'pass' | 'fail', assertion: string) => ({ index, type: 'assert', status, duration_ms: 1, started_at: '', finished_at: '', assertion });

  it('does not call a failed 404 status check a breach on its own', () => {
    const users = [user([step(0, 'pass', 'http_status 200'), step(1, 'fail', 'http_status 404')])];
    expect(isolationBreach(users)).toBeUndefined();
    expect(summaryMarkdown(users, 'failed')).not.toContain('another account');
  });

  it('still calls it one when the journey also checked that access was denied', () => {
    expect(isolationBreach([user([step(0, 'pass', 'access_denied'), step(1, 'fail', 'http_status 404')])])?.step).toBe(1);
    expect(isolationBreach([user([step(0, 'fail', 'http_status 401')])])?.step).toBe(0);
  });
});

describe('regressions are judged once per suite run', () => {
  it('fails when any label failed, passes only when every label passed', () => {
    expect(runOutcome(['pass', 'pass', 'pass'])).toBe('pass');
    expect(runOutcome(['pass', 'flaky'])).toBe('fail');
    expect(runOutcome(['pass', 'error'])).toBe('fail');
    expect(runOutcome(['pass', 'blocked'])).toBe('none');
    expect(runOutcome([])).toBe('none');
  });
});

describe('baselines', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-baseline-'));

  it('keeps one baseline per label and still reads an older shared one', () => {
    const shared = join(home, 'baselines', 'p', 'layout');
    mkdirSync(shared, { recursive: true, mode: 0o700 });
    writeFileSync(join(shared, 'timings.json'), '{}\n');
    expect(baselineDir(home, 'p', 'qa-user-1', 'layout')).toBe(shared);
    const own = join(home, 'baselines', 'p', 'qa-user-1', 'layout');
    mkdirSync(own, { recursive: true, mode: 0o700 });
    expect(baselineDir(home, 'p', 'qa-user-1', 'layout')).toBe(own);
    expect(baselineDir(home, 'p', 'qa-user-2', 'fresh')).toBe(join(home, 'baselines', 'p', 'qa-user-2', 'fresh'));
  });

  it('compares the words on the page, ignoring spacing', () => {
    expect(textChanged('Total: $10\n\nCheckout', 'Total:  $10 Checkout')).toBe(false);
    expect(textChanged('Total: $10', 'Total: $12')).toBe(true);
  });

  it('accepts a baseline only from a run of the same project, copying each label to its own folder', () => {
    const runId = 'run_20261014-100000_abcdef';
    const runDir = join(home, 'runs', runId);
    const shotDir = join(runDir, 'qa-user-5', 'layout');
    mkdirSync(shotDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(shotDir, 'page.png'), 'png');
    writeFileSync(join(shotDir, 'page.txt'), 'Products');
    const steps = [{ index: 2, type: 'screenshot', status: 'pass', duration_ms: 5, started_at: '', finished_at: '', screenshot_paths: [join(shotDir, 'page.png'), '/etc/hosts'] }];
    writeFileSync(join(runDir, 'analysis.json'), JSON.stringify({ project: 'p', users: [{ label: 'qa-user-5', journeys: [{ id: 'layout', steps }] }] }));
    expect(() => acceptBaseline('other', runId, home)).toThrow(/another project/);
    expect(() => acceptBaseline('p', '../escape', home)).toThrow(/Unknown run id/);
    acceptBaseline('p', runId, home);
    const saved = join(home, 'baselines', 'p', 'qa-user-5', 'layout');
    expect(readFileSync(join(saved, '2.png'), 'utf8')).toBe('png');
    expect(readFileSync(join(saved, '2.txt'), 'utf8')).toBe('Products');
    const outside = { ...steps[0], screenshot_paths: ['/etc/hosts'] };
    writeFileSync(join(runDir, 'analysis.json'), JSON.stringify({ project: 'p', users: [{ label: 'qa-user-6', journeys: [{ id: 'layout', steps: [outside] }] }] }));
    acceptBaseline('p', runId, home);
    expect(existsSync(join(home, 'baselines', 'p', 'qa-user-6', 'layout', '2.png'))).toBe(false);
  });
});

describe('moving a runner folder never follows a link', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-move-'));
  const config = project({ id: 'move' });

  it('copies a real folder and empties the runner copy', async () => {
    const out = join(home, 'runners', 'move', 'qa-user-1', 'run_a', 'journey');
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeFileSync(join(out, 'console.log'), 'ok');
    await moveArtifacts(home, config, 'qa-user-1', 'run_a', 'journey');
    expect(readFileSync(join(home, 'runs', 'run_a', 'qa-user-1', 'journey', 'console.log'), 'utf8')).toBe('ok');
    expect(existsSync(join(home, 'runners', 'move', 'qa-user-1', 'run_a'))).toBe(false);
  });

  it('refuses a run folder that is a link, removes only the link, and leaves its target alone', async () => {
    const victim = mkdtempSync(join(tmpdir(), 'hornet-victim-'));
    mkdirSync(join(victim, 'journey'));
    writeFileSync(join(victim, 'journey', 'keep.txt'), 'precious');
    const runnerDir = join(home, 'runners', 'move', 'qa-user-1');
    mkdirSync(runnerDir, { recursive: true, mode: 0o700 });
    symlinkSync(victim, join(runnerDir, 'run_b'));
    await expect(moveArtifacts(home, config, 'qa-user-1', 'run_b', 'journey')).rejects.toThrow(/link/);
    expect(readFileSync(join(victim, 'journey', 'keep.txt'), 'utf8')).toBe('precious');
    expect(existsSync(join(runnerDir, 'run_b'))).toBe(false);
    expect(existsSync(join(home, 'runs', 'run_b'))).toBe(false);
    expect(readdirSync(join(home, 'staging'))).toEqual([]);
  });

  it('refuses a journey folder that is a link', async () => {
    const victim = mkdtempSync(join(tmpdir(), 'hornet-victim-'));
    writeFileSync(join(victim, 'keep.txt'), 'precious');
    const runDir = join(home, 'runners', 'move', 'qa-user-1', 'run_c');
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    symlinkSync(victim, join(runDir, 'journey'));
    await expect(moveArtifacts(home, config, 'qa-user-1', 'run_c', 'journey')).rejects.toThrow(/link/);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('precious');
  });
});

describe('the Keychain write', () => {
  it('sends the key on stdin with no -A, and refuses anything it cannot quote', () => {
    const command = keychainAddCommand('hornet-swarm-age-key', 'aron', 'QUdFLVNFQ1JFVC1LRVkt');
    expect(command).toBe('add-generic-password -s hornet-swarm-age-key -a aron -w QUdFLVNFQ1JFVC1LRVkt\n');
    expect(command).not.toContain(' -A');
    expect(() => keychainAddCommand('svc', 'aron', 'not base64; rm -rf')).toThrow(/base64/);
    expect(() => keychainAddCommand('svc name', 'aron', 'QUFB')).toThrow(/quote/);
  });

  it('never passes the key as an argument in the source', () => {
    const source = readFileSync(join(root, 'packages/controller/src/broker.ts'), 'utf8');
    expect(source).not.toMatch(/'add-generic-password', '-A'/);
    expect(source).toContain("execFileSync('security', ['-i']");
  });
});

describe('file locks', () => {
  beforeAll(() => {
    execFileSync('pnpm', ['--filter', '@hornet-swarm/core', '--filter', '@hornet-swarm/report', '--filter', '@hornet-swarm/controller', 'build'], { cwd: root, stdio: 'ignore' });
  }, 120_000);

  it('takes over a lock left by a dead process', async () => {
    const { withFileLock } = await import('../../packages/controller/src/leases-store.ts');
    const home = mkdtempSync(join(tmpdir(), 'hornet-lock-'));
    mkdirSync(join(home, 'dead.lock'));
    writeFileSync(join(home, 'dead.lock', 'pid'), '999999\n');
    expect(withFileLock(home, 'dead', () => 'ran')).toBe('ran');
    expect(readdirSync(home).filter((name) => name.startsWith('dead.lock'))).toEqual([]);
  });

  it('keeps every increment when several processes race, including a takeover of a dead lock', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hornet-lock-race-'));
    writeFileSync(join(home, 'count'), '0');
    mkdirSync(join(home, 'race.lock'));
    writeFileSync(join(home, 'race.lock', 'pid'), '999999\n');
    const script = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { withFileLock } from ${JSON.stringify(join(root, 'packages/controller/dist/leases-store.js'))};
      const home = process.argv[1];
      for (let i = 0; i < 40; i += 1) {
        withFileLock(home, 'race', () => {
          const count = Number(readFileSync(home + '/count', 'utf8'));
          writeFileSync(home + '/count', String(count + 1));
        }, 30000);
      }`;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script, home], { stdio: 'inherit' });
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        }),
      ),
    );
    expect(readFileSync(join(home, 'count'), 'utf8')).toBe('160');
  }, 60_000);
});

describe('the credential page and the swarm board', () => {
  // The store needs the Keychain age key, as in broker.test.ts. The work folder sits in the Hornet Swarm home.
  const swarmHome = join(homedir(), '.hornet-swarm');
  mkdirSync(swarmHome, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(swarmHome, 'work-fixes-'));
  let page: { port: number; close: () => Promise<void> } | undefined;
  let restorePath: (() => void) | undefined;

  beforeAll(async () => {
    writeProject(home);
    restorePath = allowTouchId();
    page = await startCredentialPage(home, 0);
  });

  afterAll(async () => {
    await page?.close();
    restorePath?.();
    rmSync(home, { recursive: true, force: true });
  });

  it(`hands the runner a fresh code each time the site asks again, up to ${MAX_CODES_PER_GATE} codes`, async () => {
    const port = page?.port ?? 0;
    const opened = (await (await fetch(`http://127.0.0.1:${port}/v1/operator-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'fixes', label: 'qa-user-1' }) })).json()) as { id: string; token: string };
    const pollUrl = `http://127.0.0.1:${port}/v1/operator-code/${opened.id}?token=${opened.token}`;
    for (let attempt = 1; attempt <= MAX_CODES_PER_GATE; attempt += 1) {
      const settled = pollOperatorGate(pollUrl, Date.now() + 8_000, () => false);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const posted = await fetch(`http://127.0.0.1:${port}/codes?token=${opened.token}`, { method: 'POST', body: new URLSearchParams({ decision: 'save', code: `${attempt}${attempt}${attempt}` }) });
      expect(posted.status, `attempt ${attempt}`).toBe(200);
      expect(await settled).toEqual({ action: 'continue', code: `${attempt}${attempt}${attempt}` });
    }
    const started = Date.now();
    expect(await pollOperatorGate(pollUrl, Date.now() + 8_000, () => false)).toEqual({ action: 'block', reason: '2fa' });
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 60_000);

  it('keeps the request link working when Touch ID is refused, and only accepts the project website', async () => {
    const port = page?.port ?? 0;
    const token = writeRequest(home);
    const post = (site: string) =>
      fetch(`http://127.0.0.1:${port}/requests?token=${token}`, { method: 'POST', body: new URLSearchParams({ site, username: 'qa1@example.test', password: 'request-pass-1', decision: 'save' }) });
    expect((await post('https://other.test.example/')).status).toBe(400);
    restorePath?.();
    restorePath = denyTouchId();
    expect((await post('http://127.0.0.1:4173/login')).status).toBe(401);
    restorePath();
    restorePath = allowTouchId();
    const saved = await post('http://127.0.0.1:4173/login');
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(listFields('fixes', 'qa-user-1', home).sort()).toEqual(['password', 'username']);
    expect((await post('http://127.0.0.1:4173/login')).status).toBe(403);
  }, 60_000);

  it('saves the board without retyping stored passwords, keeps each card on its own label, and keeps the owner config', () => {
    const file = join(home, 'projects', 'fixes', 'project.yaml');
    const first = saveSwarmBoard(
      {
        project: 'fixes',
        website: 'http://127.0.0.1:4173/login',
        cards: [
          { username: 'qa1@example.test', password: 'board-pass-1', personality: 'Careful' },
          { username: '', password: '', personality: '' },
          { username: 'qa3@example.test', password: 'board-pass-3', personality: 'Hurried' },
        ],
      },
      home,
    );
    expect(first.agents.map((agent) => agent.label)).toEqual(['qa-user-1', 'qa-user-3']);
    const second = saveSwarmBoard(
      { project: 'fixes', website: 'http://127.0.0.1:4173/login', cards: [{ username: '', password: '', personality: 'Patient', rules: 'Never delete data' }, { username: '', password: '', personality: '' }, { username: '', password: '', personality: 'Hurried' }] },
      home,
    );
    expect(second.agents.map((agent) => [agent.label, agent.personality])).toEqual([['qa-user-1', 'Patient'], ['qa-user-3', 'Hurried']]);
    expect(Object.keys(storedFields('fixes', home)).sort()).toEqual(['qa-user-1', 'qa-user-3']);
    expect(() => saveSwarmBoard({ project: 'fixes', website: 'http://127.0.0.1:4173/login', cards: [{ username: '', password: '', personality: '' }, { username: '', password: '', personality: 'New' }] }, home)).toThrow(/username and a password/);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# The owner keeps this note.');
    const saved = projectSchema.parse(parse(text));
    expect(saved.targets.allowed_origins).toEqual(['http://127.0.0.1:4173', 'http://127.0.0.1:4174', 'http://host.docker.internal:4173']);
    expect(saved.auth.success).toEqual([{ type: 'url_contains', value: '/dashboard' }, { type: 'selector_visible', value: '#menu' }]);
    expect(saved.users.map((user) => user.label)).toEqual(['qa-user-1', 'qa-user-3']);
    expect(saved.users[0]?.role).toBe('consultant');
    expect(text).not.toContain('board-pass');
  }, 60_000);

  it('shows the authorisation exclusions to every sub-agent', async () => {
    const snapshot = await swarmSnapshot('fixes', home);
    expect(snapshot.exclusions).toEqual(['Never type a real card number.']);
  }, 30_000);
});

function writeProject(home: string): void {
  const body = 'Owner authorisation for the offline fixture.\n';
  mkdirSync(join(home, 'authorisations'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'projects', 'fixes'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'authorisations', 'fixes.txt'), body);
  writeFileSync(
    join(home, 'authorisations', 'fixes-owner.yaml'),
    `id: fixes-owner
basis: owner
client: self
authoriser: { name: Aron Amos, role: Owner, email: aron.amos@ironadamant.com }
granted_to: Aron Amos
scope: { domains: [localhost, host.docker.internal], environments: [test] }
activities: [signin_smoke, functional_e2e]
exclusions: [Never type a real card number.]
valid_from: "2026-01-01"
valid_until: "2099-12-31"
document: { path: fixes.txt, sha256: "${createHash('sha256').update(body).digest('hex')}" }
`,
  );
  writeFileSync(
    join(home, 'projects', 'fixes', 'project.yaml'),
    `# The owner keeps this note.
id: fixes
name: Fixes
authorisation_id: fixes-owner
environment: test
targets:
  base_url: http://127.0.0.1:4173/login
  allowed_origins:
    - http://127.0.0.1:4173
    - http://127.0.0.1:4174
auth:
  signin_url: /login
  selectors: { username: "#email", password: "#password", submit: "#submit" }
  success:
    - { type: url_contains, value: /dashboard }
    - { type: selector_visible, value: "#menu" }
runners: {}
limits: {}
users:
  - { label: qa-user-1, role: consultant, tenant: A1 }
`,
  );
}

function writeRequest(home: string): string {
  const token = `request-${Date.now()}`;
  const record = { id: `id-${token}`, project: 'fixes', label: 'qa-user-1', reason: 'test', status: 'pending', createdAt: Date.now(), tokenHash: createHash('sha256').update(token).digest('hex'), tokenUsed: false };
  writeFileSync(join(home, 'credential-requests.json'), JSON.stringify([record]));
  return token;
}

function stubSwift(exitCode: number): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'hornet-swift-'));
  writeFileSync(join(dir, 'swift'), `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(join(dir, 'swift'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previous ?? ''}`;
  return () => {
    process.env.PATH = previous;
  };
}

function allowTouchId(): () => void {
  return stubSwift(0);
}

function denyTouchId(): () => void {
  return stubSwift(1);
}
