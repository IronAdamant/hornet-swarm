import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assessPassiveSecurity,
  PASSIVE_SECURITY_LIMITS,
  securityStepFailure,
  selectSecurityHeaders,
  sessionCookieName,
  type CookieFlags,
  type SecurityFinding,
} from '../../packages/core/src/passive-security.ts';
import type { Redactor } from '../../packages/core/src/redactor.ts';
import { bannedWordsIn } from '../../packages/report/src/ia-findings.ts';
import { analysisMarkdown, buildAnalysis, headerCookieFindings, summaryMarkdown } from '../../packages/report/src/render.ts';
import type { RunResult } from '../../packages/core/src/schemas.ts';
import { executeJob, type JobRequest } from '../../packages/runner/src/job.ts';
import { cookieFlags, runPassiveSecurityCheck } from '../../packages/runner/src/passive-security-step.ts';
import { createSecurityObservations } from '../../packages/runner/src/security-observations.ts';
import type { Page, Response } from 'playwright';

const COOKIE_SECRET = 'hornet-cookie-secret-value';
const LOCKED_COOKIE = 'hornet-locked-cookie-value';
const NONCE = 'supersecretnoncevalue';

const chrome = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].find((path) => existsSync(path));

function cookie(name: string, flags: Partial<CookieFlags> = {}): CookieFlags {
  return { name, httpOnly: false, secure: false, sameSite: 'Lax', persistent: false, ...flags };
}

function document(protocol: 'http' | 'https', headers: Record<string, string>, tlsProtocol?: string) {
  return { url: `${protocol}://127.0.0.1/home`, protocol, status: 200, headers, ...(tlsProtocol ? { tlsProtocol } : {}) };
}

describe('header and cookie assessment', () => {
  it('keeps only allowlisted headers and strips a CSP nonce', () => {
    const headers = selectSecurityHeaders({
      'content-security-policy': `script-src 'nonce-${NONCE}'`,
      'set-cookie': `session=${COOKIE_SECRET}; HttpOnly`,
      authorization: 'Bearer secret',
      'x-content-type-options': 'nosniff',
    });
    expect(headers).toEqual({
      'content-security-policy': "script-src 'nonce-[redacted]'",
      'x-content-type-options': 'nosniff',
    });
    expect(JSON.stringify(headers)).not.toContain(NONCE);
    expect(JSON.stringify(headers)).not.toContain(COOKIE_SECRET);
  });

  it('grades a hardened HTTPS document as clear, and names the gaps on a bare one', () => {
    const hardened = assessPassiveSecurity({
      name: 'home',
      pageUrl: 'https://127.0.0.1/home',
      document: document('https', {
        'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'strict-transport-security': 'max-age=31536000',
      }, 'TLS 1.3'),
      cookies: [cookie('session', { httpOnly: true, secure: true })],
    });
    expect(hardened.findings).toEqual([]);
    expect(hardened.tls_note).toBe('recorded');
    expect(hardened.transport).toBe('https');
    expect(securityStepFailure(hardened.findings, 'low')).toBeUndefined();

    const bare = assessPassiveSecurity({
      name: 'home',
      pageUrl: 'https://127.0.0.1/home',
      document: document('https', { 'content-security-policy-report-only': "default-src 'self'" }, 'TLS 1.0'),
      cookies: [cookie('session'), cookie('prefs', { sameSite: 'None' })],
    });
    expect(bare.findings.map((finding) => `${finding.id}:${finding.severity}`)).toEqual([
      'weak-tls:Medium',
      'missing-hsts:Low',
      'missing-csp:Low',
      'missing-nosniff:Low',
      'missing-referrer-policy:Low',
      'missing-frame-protection:Low',
      'cookie-missing-https-flag:Low',
      'cookie-samesite-none:Low',
      'cookie-missing-https-flag:Medium',
      'cookie-not-httponly:Medium',
    ]);
    expect(securityStepFailure(bare.findings, 'medium')).toContain('weak-tls');
    expect(securityStepFailure(bare.findings, 'low')).toContain('at or above low');
  });

  it('records plain HTTP and does not treat it as a missing HSTS or HTTPS-only flag, and ignores a zero max-age', () => {
    const http = assessPassiveSecurity({
      name: 'home',
      pageUrl: 'http://127.0.0.1/home',
      document: document('http', {
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
      }),
      cookies: [cookie('session', { httpOnly: true })],
    });
    expect(http.findings).toEqual([{ id: 'plain-http', severity: 'Medium', summary: 'The page was served over plain HTTP.' }]);
    expect(http.tls_note).toBe('not_applicable');
    expect(http.findings.map((finding) => finding.id)).not.toContain('missing-hsts');
    expect(http.findings.map((finding) => finding.id)).not.toContain('cookie-missing-https-flag');
    const disabled = assessPassiveSecurity({
      name: 'home',
      pageUrl: 'https://127.0.0.1/home',
      document: document('https', {
        'content-security-policy': "frame-ancestors *",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'unsafe-url',
        'strict-transport-security': 'max-age=0',
        'x-frame-options': 'ALLOWALL',
      }, 'QUIC'),
      cookies: [],
    });
    expect(disabled.findings.map((finding) => finding.id)).toEqual(['missing-hsts', 'missing-referrer-policy', 'missing-frame-protection']);
    expect(disabled.tls_protocol).toBe('QUIC');
  });

  it('recognises session cookie names and refuses a step that saw no document', () => {
    expect(sessionCookieName('session')).toBe(true);
    expect(sessionCookieName('connect.sid')).toBe(true);
    expect(sessionCookieName('JSESSIONID')).toBe(true);
    expect(sessionCookieName('prefs')).toBe(false);
    expect(sessionCookieName('author')).toBe(false);
    expect(sessionCookieName('csrf-token')).toBe(false);
    const empty = assessPassiveSecurity({ name: 'home', pageUrl: 'http://127.0.0.1/home', cookies: [cookie('session')] });
    expect(empty.findings.map((finding) => finding.id)).toEqual(['no-document']);
    expect(empty.cookies).toEqual([]);
    const hop = assessPassiveSecurity({ name: 'home', pageUrl: 'http://127.0.0.1/old', cookies: [cookie('session')], redirectOnly: true });
    expect(hop.findings.map((finding) => finding.id)).toEqual(['redirect-only']);
    expect(hop.cookies).toEqual([]);
    expect(hop.document_headers).toEqual({});
  });

  it('copies cookie flags and drops the value', () => {
    const flags = cookieFlags([{ name: 'session', httpOnly: true, secure: false, sameSite: 'Lax', expires: -1 }]);
    expect(flags).toEqual([{ name: 'session', httpOnly: true, secure: false, sameSite: 'Lax', persistent: false }]);
    expect(JSON.stringify(flags)).not.toContain(COOKIE_SECRET);
    const source = readFileSync(join(import.meta.dirname, '../../packages/runner/src/passive-security-step.ts'), 'utf8');
    expect(source).not.toContain('cookie.value');
  });
});

describe('what a run summary says about the check', () => {
  const finding: SecurityFinding = { id: 'missing-csp', severity: 'Low', summary: 'The document response did not include a Content-Security-Policy header.' };

  function checked(findings: SecurityFinding[]) {
    return [{
      label: 'qa-user-1',
      phase1: { status: 'pass' as const, duration_ms: 1 },
      journeys: [{
        id: 'home',
        name: 'Home',
        status: 'pass' as const,
        duration_ms: 1,
        steps: [{
          index: 1,
          type: 'header_cookie_check',
          status: 'pass' as const,
          duration_ms: 1,
          started_at: '',
          finished_at: '',
          header_cookie_check: {
            name: 'home',
            url: 'http://127.0.0.1/home',
            transport: 'http' as const,
            tls_note: 'not_applicable' as const,
            document_headers: {},
            cookies: [],
            findings,
            limits: PASSIVE_SECURITY_LIMITS,
          },
        }],
      }],
    }];
  }

  it('lists findings and does not call a passing journey a clean bill of health', () => {
    const users = checked([finding]);
    const text = summaryMarkdown(users, 'passed');
    expect(text).toContain('Header and cookie check · qa-user-1 · home · home: 1 finding (missing-csp)');
    expect(text).not.toContain('Nothing needs a change.');
    expect(headerCookieFindings(checked([]))[0]).toContain('no header or cookie-flag findings');
    expect(summaryMarkdown(checked([]), 'passed')).toContain('Nothing needs a change.');
    const result: RunResult = {
      schema_version: '1',
      run_id: 'run_header_cookie',
      project: 'fixture',
      started_at: '2026-10-10T10:00:00+11:00',
      finished_at: '2026-10-10T10:00:02+11:00',
      status: 'passed',
      gate: 'all',
      gate_passed: true,
      totals: { users: 1, journeys: 1, steps: 1, passed: 1, failed: 0, skipped: 0 },
      users: [{ label: 'qa-user-1', phase1: { status: 'pass', duration_ms: 1 }, journeys: [{ id: 'home', status: 'pass', duration_ms: 1, steps: [] }] }],
      environment: 'test',
      authorisation_id: 'fixture-owner',
      redaction: 'pass',
    };
    const markdown = analysisMarkdown(buildAnalysis({
      result,
      users,
      chaos: null,
      suspected: 'A header was missing.',
      confidence: 0.8,
      repro: ['Open the home page.'],
      regressions: [],
      next: ['Add the missing header.'],
    }));
    expect(markdown).toContain('Header and cookie check: http at http://127.0.0.1/home: missing-csp Low.');
    expect(proseBanned(`${text}\n${markdown}\n${PASSIVE_SECURITY_LIMITS}`)).toEqual([]);
  });

  it('keeps banned words out of the copy a client or operator reads', () => {
    const root = join(import.meta.dirname, '../..');
    const files = [
      'README.md',
      'CHANGELOG.md',
      'SECURITY.md',
      'docs/agents.md',
      'docs/client-engagement.md',
      'docs/reference.md',
      'docs/severity.md',
      'examples/authorisations/the-internet-practice.yaml',
      'packages/mcp-server/src/main.ts',
    ];
    const prose = files
      .map((file) => readFileSync(join(root, file), 'utf8').split('\n').filter((line) => /header_cookie|header-cookie|header and cookie|HTTPS-only|plain HTTP/.test(line)).join('\n'))
      .join('\n');
    const graded = assessPassiveSecurity({
      name: 'home',
      pageUrl: 'https://127.0.0.1/home',
      document: document('https', {}, 'TLS 1.0'),
      cookies: [cookie('session'), cookie('prefs', { sameSite: 'None' })],
    });
    const http = assessPassiveSecurity({
      name: 'home',
      pageUrl: 'http://127.0.0.1/home',
      document: document('http', {}),
      cookies: [cookie('session')],
    });
    const said = [prose, PASSIVE_SECURITY_LIMITS, ...graded.findings.map((item) => item.summary), ...http.findings.map((item) => item.summary), securityStepFailure(graded.findings, 'low') ?? ''].join('\n');
    expect(prose.length).toBeGreaterThan(0);
    expect(proseBanned(said)).toEqual([]);
  });
});

/** Header names stay. Other banned words in our own sentences do not. */
function proseBanned(text: string): string[] {
  const stripped = text.replace(/content-security-policy/gi, ' ').replace(/strict-transport-security/gi, ' ');
  return bannedWordsIn(stripped);
}

function fakeResponse(url: string, headers: Record<string, string>, navigation = true, status = 200): Response {
  return {
    url: () => url,
    status: () => status,
    headers: () => headers,
    securityDetails: async () => ({ protocol: 'TLS 1.2', issuer: 'local', subjectName: '127.0.0.1', validFrom: 0, validTo: 1 }),
    request: () => ({
      isNavigationRequest: () => navigation,
      frame: () => ({ parentFrame: () => null }),
    }),
  } as unknown as Response;
}

describe('which responses are observed', () => {
  it('keeps the last authorised document, drops other origins, and never stores a cookie header', async () => {
    const seen = createSecurityObservations(['http://127.0.0.1:9'], ['http://cdn.localhost']);
    seen.note(fakeResponse('http://127.0.0.1:9/app.js', { 'content-security-policy': "default-src 'none'" }, false));
    seen.note(fakeResponse('http://cdn.localhost/', { 'x-frame-options': 'DENY' }));
    seen.note(fakeResponse('http://other.localhost/', { 'x-frame-options': 'DENY' }));
    seen.note(fakeResponse(`http://127.0.0.1:9/home?token=${COOKIE_SECRET}`, { 'set-cookie': `session=${COOKIE_SECRET}`, 'x-frame-options': 'SAMEORIGIN' }));
    await seen.flush();
    const latest = seen.latestDocument();
    expect(latest?.url).toBe('http://127.0.0.1:9/home');
    expect(latest?.headers).toEqual({ 'x-frame-options': 'SAMEORIGIN' });
    expect(JSON.stringify(latest)).not.toContain(COOKIE_SECRET);
    const secure = createSecurityObservations(['https://127.0.0.1']);
    secure.note(fakeResponse('https://127.0.0.1/home', {}));
    await secure.flush();
    expect(secure.latestDocument()?.tlsProtocol).toBe('TLS 1.2');
  });

  it('grades the final page and does not grade a redirect hop', async () => {
    const followed = createSecurityObservations(['http://127.0.0.1']);
    followed.note(fakeResponse('http://127.0.0.1/old', { 'x-frame-options': 'DENY' }, true, 302));
    followed.note(fakeResponse('http://127.0.0.1/home', { 'x-content-type-options': 'nosniff' }, true, 200));
    expect(followed.endedOnRedirect()).toBe(false);
    expect(followed.latestDocument()).toMatchObject({ url: 'http://127.0.0.1/home', status: 200, headers: { 'x-content-type-options': 'nosniff' } });

    const stopped = createSecurityObservations(['http://127.0.0.1']);
    stopped.note(fakeResponse('http://127.0.0.1/home', { 'x-content-type-options': 'nosniff' }, true, 200));
    stopped.note(fakeResponse('http://127.0.0.1/old?token=secret', {}, true, 301));
    expect(stopped.latestDocument()).toBeUndefined();
    expect(stopped.endedOnRedirect()).toBe(true);
    expect(stopped.redirectUrl()).toBe('http://127.0.0.1/old');

    for (const status of [300, 302, 303, 307, 308]) {
      const hop = createSecurityObservations(['http://127.0.0.1']);
      hop.note(fakeResponse('http://127.0.0.1/go', { 'x-frame-options': 'DENY' }, true, status));
      hop.note(fakeResponse('http://elsewhere.test/landed', { 'content-security-policy': "default-src 'self'" }, true, 200));
      expect(hop.latestDocument(), String(status)).toBeUndefined();
      expect(hop.endedOnRedirect(), String(status)).toBe(true);
    }

    const missing = createSecurityObservations(['http://127.0.0.1']);
    missing.note(fakeResponse('http://127.0.0.1/gone', { 'x-content-type-options': 'nosniff' }, true, 404));
    expect(missing.latestDocument()).toMatchObject({ url: 'http://127.0.0.1/gone', status: 404 });
    expect(missing.endedOnRedirect()).toBe(false);
  });

  it('reads cookies for the checked page and records a redirect with no header gaps', async () => {
    const seen = createSecurityObservations(['http://checked.example']);
    seen.note(fakeResponse('http://checked.example/app/home?token=secret', { 'x-content-type-options': 'nosniff' }));
    const asked: string[] = [];
    const page = {
      url: () => 'http://base.example/',
      context: () => ({
        cookies: async (url: string) => {
          asked.push(url);
          return [{ name: 'session', value: COOKIE_SECRET, httpOnly: true, secure: true, sameSite: 'Lax' as const, expires: -1 }];
        },
      }),
    } as unknown as Page;
    const saved: string[] = [];
    const outcome = await runPassiveSecurityCheck(page, { name: 'home' }, true, seen, { redact: (text: string) => text } as unknown as Redactor, (fileName, text) => {
      saved.push(fileName, text);
    });
    expect(asked).toEqual(['http://checked.example/app/home']);
    expect(outcome.result.url).toBe('http://checked.example/app/home');
    expect(JSON.stringify(outcome.result)).not.toContain(COOKIE_SECRET);
    expect(JSON.stringify(outcome.result)).not.toContain('token=secret');
    expect(saved[0]).toBe('header-cookie-check-home.json');

    const hop = createSecurityObservations(['http://127.0.0.1']);
    hop.note(fakeResponse('http://127.0.0.1/old', { 'x-frame-options': 'DENY' }, true, 302));
    const hopAsked: string[] = [];
    const hopPage = {
      url: () => 'http://127.0.0.1/old',
      context: () => ({
        cookies: async (url: string) => {
          hopAsked.push(url);
          return [];
        },
      }),
    } as unknown as Page;
    const redirected = await runPassiveSecurityCheck(hopPage, { name: 'hop' }, true, hop, { redact: (text: string) => text } as unknown as Redactor, () => undefined);
    expect(hopAsked).toEqual([]);
    expect(redirected.result.findings.map((item) => item.id)).toEqual(['redirect-only']);
    expect(redirected.result.document_headers).toEqual({});
    expect(redirected.result.findings.map((item) => item.id)).not.toContain('missing-csp');
  });
});

let server: Server;
let port = 0;

beforeAll(async () => {
  process.env.AEGIS_HEADLESS = '1';
  if (chrome) process.env.AEGIS_BROWSER = chrome;
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/hop') {
      res.writeHead(302, { Location: '/locked' });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/locked') {
      res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'self'");
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
      res.setHeader('x-frame-options', 'SAMEORIGIN');
      res.setHeader('permissions-policy', 'camera=()');
      res.setHeader('set-cookie', `lockedonly=${LOCKED_COOKIE}; Path=/locked; HttpOnly; SameSite=Lax`);
    } else if (path === '/nonce') {
      res.setHeader('content-security-policy', `script-src 'nonce-${NONCE}'`);
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-frame-options', 'DENY');
    } else {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('set-cookie', [`session=${COOKIE_SECRET}; Path=/; HttpOnly; SameSite=Lax`, 'prefs=blue; Path=/; SameSite=Lax']);
    }
    res.writeHead(200);
    res.end('<!doctype html><html><head><title>Fixture</title></head><body><h1>Home</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.AEGIS_HEADLESS;
  if (process.env.AEGIS_BROWSER === chrome) delete process.env.AEGIS_BROWSER;
});

function job(steps: JobRequest['steps'], authorised: boolean): JobRequest {
  return {
    runId: 'run_header_cookie',
    label: 'qa-user-1',
    journeyId: 'headers',
    baseUrl: `http://127.0.0.1:${port}`,
    steps,
    allowOrigins: [`http://127.0.0.1:${port}`],
    authEndpoints: [],
    minStepDelayMs: 0,
    rps: 50,
    burst: 50,
    accessDeniedMarkers: [],
    chaosActions: [],
    outDir: mkdtempSync(join(tmpdir(), 'hornet-header-cookie-')),
    vars: {},
    users: {},
    ...(authorised ? { passiveSecurityAuthorised: true } : {}),
  };
}

describe('the header and cookie step in the runner', () => {
  it('records header gaps and cookie flags for the page that was checked, and never the cookie value', async () => {
    const request = job(
      [
        { navigate: { url: '/bare' } },
        { header_cookie_check: { name: 'bare' } },
        { navigate: { url: '/locked' } },
        { header_cookie_check: { name: 'locked' } },
        { navigate: { url: '/nonce' } },
        { header_cookie_check: { name: 'nonce' } },
        { navigate: { url: '/hop' } },
        { header_cookie_check: { name: 'hop' } },
      ],
      true,
    );
    const report = await executeJob(request, new Map(), () => false);
    expect(report.status, JSON.stringify(report.steps.map((step) => step.error))).toBe('passed');
    const bare = report.steps[1]?.header_cookie_check;
    expect(bare?.findings.map((finding) => finding.id)).toEqual(['plain-http', 'missing-csp', 'missing-referrer-policy', 'missing-frame-protection']);
    expect(bare?.cookies.find((entry) => entry.name === 'session')).toMatchObject({ httpOnly: true, secure: false, sameSite: 'Lax' });
    expect(bare?.cookies.find((entry) => entry.name === 'prefs')).toMatchObject({ httpOnly: false });
    expect(bare?.cookies.map((entry) => entry.name)).not.toContain('lockedonly');
    expect(bare?.transport).toBe('http');
    expect(bare?.tls_note).toBe('not_applicable');
    const saved = readFileSync(join(request.outDir, 'header-cookie-check-bare.json'), 'utf8');
    expect(saved).not.toContain(COOKIE_SECRET);
    expect(JSON.stringify(report)).not.toContain(COOKIE_SECRET);
    const locked = report.steps[3]?.header_cookie_check;
    expect(locked?.findings.map((finding) => finding.id)).toEqual(['plain-http']);
    expect(locked?.url).toBe(`http://127.0.0.1:${port}/locked`);
    expect(locked?.document_headers['permissions-policy']).toBe('camera=()');
    expect(locked?.cookies.map((entry) => entry.name)).toContain('lockedonly');
    expect(JSON.stringify(locked)).not.toContain(LOCKED_COOKIE);
    const nonce = readFileSync(join(request.outDir, 'header-cookie-check-nonce.json'), 'utf8');
    expect(nonce).not.toContain(NONCE);
    expect(nonce).toContain('nonce-[redacted]');
    const hop = report.steps[7]?.header_cookie_check;
    expect(hop?.url).toBe(`http://127.0.0.1:${port}/locked`);
    expect(hop?.findings.map((finding) => finding.id)).toEqual(['plain-http']);
    expect(hop?.document_headers['content-security-policy']).toContain('frame-ancestors');
    expect(hop?.cookies.map((entry) => entry.name)).toContain('lockedonly');
  }, 60_000);

  it('fails the step when fail_on is reached, and refuses the step when the run was not granted', async () => {
    const failing = job([{ navigate: { url: '/bare' } }, { header_cookie_check: { name: 'bare', fail_on: 'low' } }], true);
    const failed = await executeJob(failing, new Map(), () => false);
    expect(failed.status).toBe('failed');
    expect(failed.steps[1]?.error).toContain('header-cookie: 4 findings at or above low');
    expect(failed.steps[1]?.header_cookie_check?.findings.length).toBe(4);

    const refused = job([{ navigate: { url: '/locked' } }, { header_cookie_check: { name: 'locked' } }], false);
    const blocked = await executeJob(refused, new Map(), () => false);
    expect(blocked.status).toBe('failed');
    expect(blocked.steps[1]?.error).toContain('header_cookie_check_not_permitted');
    expect(existsSync(join(refused.outDir, 'header-cookie-check-locked.json'))).toBe(false);

    const early = job([{ header_cookie_check: { name: 'early' } }], true);
    const missing = await executeJob(early, new Map(), () => false);
    expect(missing.steps[0]?.error).toContain('header-cookie: no page response on an allowed host yet');
  }, 60_000);
});
