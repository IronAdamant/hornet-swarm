import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { matchGlob, Redactor, projectSchema, type Project, type RunResult } from '../../packages/core/src/index.ts';
import { redactTree, sanitizeNetworkLogs, scanTree } from '../../packages/report/src/artifacts.ts';
import { diagnose, isolationBreach, summaryMarkdown, type RichUser } from '../../packages/report/src/render.ts';
import { summarizeReliability } from '../../packages/report/src/reliability.ts';
import { classifyChallenge, createBucket, deniedByMarker, operatorDeadline } from '../../packages/runner/src/job.ts';
import { hostAllowed, splitAllowEntry, startEgressProxy } from '../../packages/controller/src/egress-proxy.ts';
import { allowHostsFrom } from '../../packages/controller/src/env.ts';
import { admitPageRequest } from '../../packages/controller/src/credentials.ts';
import { classifyKeychainFailure } from '../../packages/controller/src/broker.ts';
import { powerReport } from '../../packages/controller/src/doctor.ts';
import { foldRunStatus, saveAgentJourney } from '../../packages/controller/src/suite.ts';
import { addAgentNote, readAgentNotes } from '../../packages/controller/src/swarm.ts';

const FIXTURE_PROJECT = `
id: gaps
name: Gaps
authorisation_id: gaps-owner
environment: test
targets:
  base_url: http://127.0.0.1:4173
  allowed_origins: [http://127.0.0.1:4173]
  allowed_third_party:
    - { origin: https://cdn.example.test, passive: true }
auth:
  signin_url: /login
  selectors: { username: "#email", password: "#password", submit: "role=button[name='Sign in']" }
  success: [{ type: url_contains, value: /dashboard }]
  auth_endpoints: ["**/login"]
runners: { count: 1 }
limits: {}
users:
  - { label: qa-user-1, role: tester, tenant: a }
`;

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hornet-gaps-'));
  mkdirSync(join(home, 'projects', 'gaps', 'journeys'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'projects', 'gaps', 'project.yaml'), FIXTURE_PROJECT);
  return home;
}

function project(): Project {
  return projectSchema.parse(parse(FIXTURE_PROJECT));
}

describe('redaction covers what a browser actually sends', () => {
  it('finds a password in an HTML form body, with spaces, ! and ~, in either hex case', () => {
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', "Hunter2! it's (ok)~");
    const form = new URLSearchParams({ email: 'qa1@example.test', password: "Hunter2! it's (ok)~" }).toString();
    expect(redactor.contains(form)).toBe(true);
    expect(redactor.redact(form)).toBe('email=qa1%40example.test&password=[REDACTED:qa-user-1.password]');
    expect(redactor.contains('password=hunter2%21+it%27s+%28ok%29%7e')).toBe(true);
    expect(redactor.contains("password=Hunter2!%20it's%20(ok)~")).toBe(true);
  });

  it('matches auth endpoints with a query string but not a longer path', () => {
    expect(matchGlob('**/login', 'https://site.test/login')).toBe(true);
    expect(matchGlob('**/login', 'https://site.test/login?next=/dashboard')).toBe(true);
    expect(matchGlob('**/login', 'https://site.test/login-help.js')).toBe(false);
    expect(matchGlob('**/oauth/token', 'https://site.test/static/app.js')).toBe(false);
  });
});

describe('trace and HAR handling', () => {
  it('keeps binary trace entries byte for byte and still redacts the text entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-zip-'));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x80, 0x9c, 0xfe, 0xc3, 0xff, 0xd9]);
    const font = Buffer.from([0x00, 0x01, 0x00, 0x00, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1]);
    const leakyBinary = Buffer.concat([Buffer.from([0xc3, 0x28, 0x00]), Buffer.from('secretpw1', 'latin1')]);
    const zip = new JSZip();
    zip.file('resources/page@abc-1.jpeg', jpeg);
    zip.file('resources/0f1e2d.woff2', font);
    zip.file('resources/leak.bin', leakyBinary);
    zip.file('trace.network', '{"postData":"password=secretpw1"}');
    writeFileSync(join(dir, 'trace.zip'), await zip.generateAsync({ type: 'nodebuffer' }));
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', 'secretpw1');
    await redactTree(dir, redactor);
    const after = await JSZip.loadAsync(readFileSync(join(dir, 'trace.zip')));
    expect((await after.file('resources/page@abc-1.jpeg')!.async('nodebuffer')).equals(jpeg)).toBe(true);
    expect((await after.file('resources/0f1e2d.woff2')!.async('nodebuffer')).equals(font)).toBe(true);
    expect(after.file('resources/leak.bin')).toBeNull();
    expect(after.file('resources/leak.bin.dropped')).not.toBeNull();
    expect(await after.file('trace.network')!.async('string')).toContain('[REDACTED:qa-user-1.password]');
    expect(await scanTree(dir, redactor)).toEqual([]);
  });

  it('leaves an untouched trace file exactly as it was', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-zip-'));
    const zip = new JSZip();
    zip.file('trace.trace', '{"type":"before"}');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    writeFileSync(join(dir, 'trace.zip'), bytes);
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', 'secretpw1');
    await redactTree(dir, redactor);
    expect(createHash('sha256').update(readFileSync(join(dir, 'trace.zip'))).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('drops a half-written trace instead of failing the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-zip-'));
    writeFileSync(join(dir, 'trace.zip'), Buffer.from('PK\x03\x04not-a-finished-zip'));
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', 'secretpw1');
    await expect(redactTree(dir, redactor)).resolves.toEqual([]);
    expect(existsSync(join(dir, 'trace.zip'))).toBe(false);
    expect(readFileSync(join(dir, 'trace.zip.dropped'), 'utf8')).toContain('could not be read');
    expect(await scanTree(dir, redactor)).toEqual([]);
  });

  it('drops auth endpoint bodies and masks session headers in a HAR and a trace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-har-'));
    const entry = (url: string) => ({
      request: {
        url,
        headers: [{ name: 'Cookie', value: 'sid=abc' }, { name: 'Accept', value: 'text/html' }],
        cookies: [{ name: 'sid', value: 'abc' }],
        postData: { mimeType: 'application/x-www-form-urlencoded', text: 'password=Hunter2%21', _sha1: 'req1' },
      },
      response: {
        headers: [{ name: 'Set-Cookie', value: 'sid=def' }],
        cookies: [{ name: 'sid', value: 'def' }],
        content: { mimeType: 'text/html', text: 'welcome', _sha1: 'res1' },
      },
    });
    writeFileSync(join(dir, 'network.har'), JSON.stringify({ log: { entries: [entry('https://site.test/login'), entry('https://site.test/search')] } }));
    const zip = new JSZip();
    zip.file('trace.network', `${JSON.stringify({ type: 'resource-snapshot', snapshot: entry('https://site.test/login?next=/') })}\n`);
    zip.file('resources/req1', 'password=Hunter2%21');
    zip.file('resources/res1.html', 'welcome');
    zip.file('resources/other.css', 'body{}');
    writeFileSync(join(dir, 'trace.zip'), await zip.generateAsync({ type: 'nodebuffer' }));

    expect(await sanitizeNetworkLogs(dir, ['**/login'], new Redactor())).toBe(2);
    const har = JSON.parse(readFileSync(join(dir, 'network.har'), 'utf8')) as { log: { entries: ReturnType<typeof entry>[] } };
    const [login, search] = har.log.entries;
    expect(login?.request.postData.text).toBe('[REDACTED:auth_endpoint]');
    expect(login?.response.content.text).toBe('[REDACTED:auth_endpoint]');
    expect(search?.request.postData.text).toBe('password=Hunter2%21');
    expect(JSON.stringify(har)).not.toContain('sid=');
    const after = await JSZip.loadAsync(readFileSync(join(dir, 'trace.zip')));
    expect(after.file('resources/req1')).toBeNull();
    expect(after.file('resources/res1.html')).toBeNull();
    expect(after.file('resources/other.css')).not.toBeNull();
    expect(await after.file('trace.network')!.async('string')).not.toContain('Hunter2');
  });

  it('masks a session token inside a trace that is itself inside an evidence zip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-nested-'));
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '1' })).toString('base64url');
    const jwt = `${header}.${payload}.signaturevalue`;
    const inner = new JSZip();
    inner.file('resources/login.json', JSON.stringify({ access_token: jwt, token_type: 'bearer' }));
    inner.file('resources/me.json', JSON.stringify({ password: hash, email: 'kept@example.test' }));
    const outer = new JSZip();
    outer.file('qa-user-1/phase1/trace.zip', await inner.generateAsync({ type: 'nodebuffer' }));
    writeFileSync(join(dir, 'evidence.zip'), await outer.generateAsync({ type: 'nodebuffer' }));
    const redactor = new Redactor();
    expect(await scanTree(dir, redactor)).not.toEqual([]);
    await redactTree(dir, redactor);
    expect(await scanTree(dir, redactor)).toEqual([]);
    const evidence = await JSZip.loadAsync(readFileSync(join(dir, 'evidence.zip')));
    const nested = await JSZip.loadAsync(await evidence.file('qa-user-1/phase1/trace.zip')!.async('nodebuffer'));
    const login = await nested.file('resources/login.json')!.async('string');
    const me = await nested.file('resources/me.json')!.async('string');
    expect(login).toContain('[REDACTED:jwt]');
    expect(login).not.toContain(jwt);
    expect(me).toContain('[REDACTED:field]');
    expect(me).not.toContain(hash);
    expect(me).toContain('kept@example.test');
  });
});

describe('the harness does not make a working site look broken', () => {
  it('paces a burst instead of refusing it', async () => {
    const bucket = createBucket(20);
    const started = Date.now();
    const admitted = await Promise.all(Array.from({ length: 30 }, () => bucket.wait(() => false)));
    expect(admitted.every(Boolean)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it('a waiting request gives up only when the job stops', async () => {
    const bucket = createBucket(1);
    expect(await bucket.wait(() => false)).toBe(true);
    expect(await bucket.wait(() => true)).toBe(false);
  });

  it('ignores invisible reCAPTCHA, the badge, and captcha scripts that show nothing', () => {
    expect(
      classifyChallenge({
        text: 'Welcome back',
        frames: [
          { src: 'https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible', width: 256, height: 60, visible: true, badge: true },
          { src: 'https://www.google.com/recaptcha/api2/bframe?k=x', width: 400, height: 580, visible: false },
          { src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile', width: 0, height: 0, visible: false },
        ],
        widgets: [{ width: 0, height: 0, visible: false, size: 'invisible' }],
        inputs: [{ type: 'email', name: 'email' }],
      }),
    ).toBeUndefined();
  });

  it('stops on a captcha a person can see', () => {
    expect(
      classifyChallenge({ text: '', frames: [{ src: 'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html', width: 303, height: 78, visible: true }], inputs: [] }),
    ).toBe('captcha');
    expect(classifyChallenge({ text: '', widgets: [{ width: 300, height: 65, visible: true }], inputs: [] })).toBe('captcha');
  });

  it('does not take a postcode, a promo code, or a footprint field for a second code', () => {
    expect(classifyChallenge({ text: 'Checkout', inputs: [{ name: 'postcode', maxlength: '6', inputmode: 'numeric' }] })).toBeUndefined();
    expect(classifyChallenge({ text: 'Checkout', inputs: [{ name: 'promoCode', maxlength: '6' }] })).toBeUndefined();
    expect(classifyChallenge({ text: 'Profile', inputs: [{ name: 'footprint' }] })).toBeUndefined();
    expect(classifyChallenge({ text: 'Colour', inputs: [{ name: 'hex', maxlength: '6' }] })).toBeUndefined();
  });

  it('still finds a real second-code prompt', () => {
    expect(classifyChallenge({ text: 'Code', inputs: [{ autocomplete: 'one-time-code' }] })).toBe('2fa');
    expect(classifyChallenge({ text: 'Check your phone', inputs: [{ name: 'otp' }] })).toBe('2fa');
    expect(classifyChallenge({ text: 'Enter it below', inputs: [{ id: 'verificationCode' }] })).toBe('2fa');
    expect(classifyChallenge({ text: "We've sent a 6-digit code to your email", inputs: [{ name: 'token' }] })).toBe('2fa');
  });

  it('matches an access-denied marker as a phrase, not inside another word', () => {
    expect(deniedByMarker('Error: Forbidden', ['forbidden'])).toBe(true);
    expect(deniedByMarker('Page not found', ['not found'])).toBe(true);
    expect(deniedByMarker('The forbiddenfruit shop', ['forbidden'])).toBe(false);
  });

  it('caps the wait for a texted code and stops at once with no code page', () => {
    const now = 1_000_000;
    expect(operatorDeadline({ deadline: now + 30 * 60_000, operatorWaitMs: 60_000 }, now)).toBe(now + 60_000);
    expect(operatorDeadline({ deadline: now + 10_000, operatorWaitMs: 60_000 }, now)).toBe(now + 10_000);
    expect(operatorDeadline({}, now)).toBe(now + 600_000);
  });
});

describe('reports say what happened', () => {
  const step = (index: number, status: 'pass' | 'fail' | 'blocked', extra: Record<string, unknown> = {}) => ({
    index,
    type: 'assert',
    status,
    duration_ms: 10,
    started_at: '2026-10-12T00:00:00+11:00',
    finished_at: '2026-10-12T00:00:01+11:00',
    ...extra,
  });
  const user = (journeySteps: ReturnType<typeof step>[], status: 'pass' | 'fail' | 'blocked', extra: Partial<RichUser['journeys'][number]> = {}): RichUser => ({
    label: 'qa-user-1',
    phase1: { status: 'pass', duration_ms: 100 },
    journeys: [{ id: 'tenant-isolation', name: 'Tenant isolation', status, duration_ms: 50, steps: journeySteps as RichUser['journeys'][number]['steps'], ...extra }],
  });

  it('a failed own-resource check is not a breach, and a failed denial check is', () => {
    expect(isolationBreach([user([step(0, 'fail', { assertion: "selector_visible [data-testid='resource-view']" })], 'fail')])).toBeUndefined();
    expect(isolationBreach([user([step(0, 'fail', { assertion: 'http_status 403' })], 'fail')])?.step).toBe(0);
    expect(isolationBreach([user([step(0, 'pass', { assertion: 'access_denied' }), step(1, 'fail', { assertion: 'selector_absent #x' })], 'fail')])?.step).toBe(1);
    expect(isolationBreach([user([step(0, 'fail', { assertion: 'selector_absent .spinner' })], 'fail')])).toBeUndefined();
  });

  it('names the kill switch, the time limit, rate limiting, and a busy login', () => {
    expect(summaryMarkdown([user([step(0, 'blocked', { blocked_reason: 'kill' })], 'blocked')], 'blocked')).toContain('kill switch');
    expect(summaryMarkdown([user([], 'blocked', { blocked_reason: 'duration' })], 'blocked')).toContain('time limit');
    expect(summaryMarkdown([user([step(0, 'pass')], 'blocked', { blocked_reason: 'rate_limited' })], 'rate_limited')).toContain('HTTP 429 or 503');
    const busy: RichUser = { label: 'qa-user-2', phase1: { status: 'blocked', duration_ms: 0, blocked_reason: 'lease_busy' }, journeys: [] };
    expect(summaryMarkdown([busy], 'blocked')).toContain('Another agent was using');
  });

  it('points at the first failed step with real repro steps', () => {
    const failed = user(
      [step(0, 'pass', { type: 'navigate' }), step(1, 'pass', { type: 'click', selector: '#go' }), step(2, 'fail', { assertion: 'url_contains /dashboard', error: 'url did not match' })],
      'fail',
    );
    const result = diagnose([failed], 'failed');
    expect(result.suspected).toContain('step 2');
    expect(result.suspected).toContain('url did not match');
    expect(result.repro).toEqual(['Sign in as qa-user-1.', 'Step 0: navigate.', 'Step 1: click #go.', 'Step 2: assert url_contains /dashboard.']);
    expect(result.confidence).toBe(0.8);
    expect(diagnose([user([step(0, 'blocked', { blocked_reason: 'captcha' })], 'blocked')], 'blocked').confidence).toBe(0.95);
    expect(diagnose([user([step(0, 'pass')], 'pass')], 'passed').suspected).toBe('Nothing failed.');
  });

  it('a harness error is error, not a site failure', () => {
    const errored = { phase1: { status: 'error' }, journeys: [] };
    const failed = { phase1: { status: 'fail' }, journeys: [] };
    expect(foldRunStatus({ killed: false, gatePassed: false, users: [errored] })).toBe('error');
    expect(foldRunStatus({ killed: false, gatePassed: false, users: [errored, failed] })).toBe('failed');
  });

  it('summarises pass rate, timings, and failing streaks across runs', () => {
    const run = (status: 'pass' | 'fail' | 'flaky', duration: number, at: string): RunResult => ({
      schema_version: '1',
      run_id: `run_${at}`,
      project: 'gaps',
      started_at: at,
      status: status === 'pass' ? 'passed' : 'failed',
      gate: 'all',
      gate_passed: true,
      totals: { users: 1, journeys: 1, steps: 1, passed: 1, failed: 0, skipped: 0 },
      users: [{ label: 'qa-user-1', phase1: { status: 'pass', duration_ms: 500 }, journeys: [{ id: 'checkout', status, duration_ms: duration, steps: [] }] }],
      environment: 'test',
      authorisation_id: 'gaps-owner',
      redaction: 'pass',
    });
    const report = summarizeReliability('gaps', [
      run('pass', 100, '2026-10-12T01:00:00Z'),
      run('pass', 300, '2026-10-12T02:00:00Z'),
      run('flaky', 200, '2026-10-12T03:00:00Z'),
      run('fail', 900, '2026-10-12T04:00:00Z'),
      run('fail', 900, '2026-10-12T05:00:00Z'),
    ]);
    const checkout = report.journeys.find((entry) => entry.id === 'checkout');
    expect(checkout?.pass_rate).toBe(0.4);
    expect(checkout?.p50_ms).toBe(100);
    expect(checkout?.p95_ms).toBe(300);
    expect(checkout?.failing_streak).toBe(3);
    expect(report.signin.pass_rate).toBe(1);
    expect(report.notes.join(' ')).toContain('failed 3 times in a row');
  });
});

describe('isolation between the browser, the Mac, and other agents', () => {
  it('allows only listed host and port pairs', () => {
    expect(splitAllowEntry('[::1]:443')).toEqual({ host: '::1', port: 443 });
    expect(hostAllowed('site.test', ['site.test:443'], 443)).toBe(true);
    expect(hostAllowed('site.test', ['site.test:443'], 22)).toBe(false);
    expect(hostAllowed('host.docker.internal', ['host.docker.internal:7781'], 5432)).toBe(false);
    expect(hostAllowed('site.test', ['site.test'], 8443)).toBe(true);
  });

  it('builds the proxy list from the project, with the local origin under its container name', () => {
    const hosts = allowHostsFrom(project(), [], 7781);
    expect(hosts).toContain('127.0.0.1:4173');
    expect(hosts).toContain('host.docker.internal:4173');
    expect(hosts).toContain('cdn.example.test:443');
    expect(hosts).toContain('host.docker.internal:7781');
    expect(hosts.some((entry) => entry === 'host.docker.internal' || entry === 'localhost')).toBe(false);
  });

  it('queues over-limit proxy requests and refuses an unlisted port', async () => {
    const upstream = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startEgressProxy({ port: 0, allow: [`127.0.0.1:${upstreamPort}`], rps: 2, log: () => undefined });
    const get = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${port}/`, method: 'GET' }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
    try {
      const statuses = await Promise.all([get(upstreamPort), get(upstreamPort), get(upstreamPort), get(upstreamPort)]);
      expect(statuses).toEqual([200, 200, 200, 200]);
      expect(await get(upstreamPort + 1 === 65536 ? 1 : upstreamPort + 1)).toBe(403);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('the credential page answers only on loopback and refuses other sites', () => {
    expect(admitPageRequest({ host: '127.0.0.1:7781', path: '/setup' }).ok).toBe(true);
    expect(admitPageRequest({ host: 'evil.test:7781', path: '/setup' }).ok).toBe(false);
    expect(admitPageRequest({ host: '127.0.0.1:7781', origin: 'https://evil.test', path: '/setup' }).ok).toBe(false);
    expect(admitPageRequest({ host: 'host.docker.internal:7781', path: '/v1/operator-code/x' }).ok).toBe(true);
    expect(admitPageRequest({ host: 'host.docker.internal:7781', path: '/setup' }).ok).toBe(false);
    expect(admitPageRequest({ host: '127.0.0.1:7781', origin: 'http://127.0.0.1:7781', path: '/v1/operator-code' }).ok).toBe(false);
  });

  it('treats only a missing Keychain item as missing', () => {
    expect(classifyKeychainFailure(44, 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.')).toBe('missing');
    expect(classifyKeychainFailure(36, 'security: SecKeychainSearchCopyNext: User interaction is not allowed.')).toBe('error');
    expect(classifyKeychainFailure(null, 'spawnSync security ETIMEDOUT')).toBe('error');
  });

  it('reports whether system sleep can freeze a run', () => {
    expect(powerReport(' sleep                0 (sleep prevented by caffeinate)').system_sleep_minutes).toBe(0);
    expect(powerReport(' sleep                10').summary).toContain('allowed after 10');
    expect(powerReport(' sleep                10').summary).toContain('lid');
  });
});

describe('agent notes, rules, and written journeys', () => {
  it('keeps redacted notes per label and refuses a label another agent holds', () => {
    const home = tempHome();
    writeFileSync(join(home, 'projects', 'gaps', 'swarm.json'), JSON.stringify({ ready: true, website: 'http://127.0.0.1:4173', agents: [{ label: 'qa-user-1', personality: 'Careful', rules: 'Never delete data' }] }));
    expect(addAgentNote('gaps', 'qa-user-1', 'agent-a', 'The search page is slow after sign-in.', home).notes).toBe(1);
    expect(readAgentNotes('gaps', 'qa-user-1', home)[0]?.text).toBe('The search page is slow after sign-in.');
    writeFileSync(join(home, 'leases.json'), JSON.stringify([{ project: 'gaps', label: 'qa-user-1', agentId: 'agent-b', acquiredAt: '', heartbeatAt: '', expiresAt: new Date(Date.now() + 60_000).toISOString() }]));
    expect(() => addAgentNote('gaps', 'qa-user-1', 'agent-a', 'second', home)).toThrow(/in use by another agent/);
    expect(() => addAgentNote('gaps', 'qa-user-9', 'agent-a', 'x', home)).toThrow(/not on the swarm board/);
  });

  it('saves an agent journey after validation and will not replace a project journey', () => {
    const home = tempHome();
    const journey = (id: string, url = '/search') => `version: 1\nid: ${id}\nname: Search\nusers: [qa-user-1]\nsteps:\n  - navigate: { url: "${url}" }\n  - assert: { type: text_visible, value: "Results" }\n`;
    const saved = saveAgentJourney('gaps', journey('agent-search'), home);
    expect(saved.path).toContain('agent-journeys');
    expect(readFileSync(saved.path, 'utf8')).toContain('agent-search');
    expect(() => saveAgentJourney('gaps', journey('off-site', 'https://elsewhere.test/'), home)).toThrow(/blocked_by_allowlist/);
    writeFileSync(join(home, 'projects', 'gaps', 'journeys', 'owner.journey.yaml'), journey('owned'));
    expect(() => saveAgentJourney('gaps', journey('owned'), home)).toThrow(/already uses the id owned/);
  });
});
