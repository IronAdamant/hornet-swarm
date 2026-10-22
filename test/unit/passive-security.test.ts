import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assessPassiveSecurity,
  securityStepFailure,
  selectSecurityHeaders,
  sessionCookieName,
  type CookieFlags,
  type SecurityFinding,
} from '../../packages/core/src/passive-security.ts';
import { securityFindings, summaryMarkdown } from '../../packages/report/src/render.ts';
import { executeJob, type JobRequest } from '../../packages/runner/src/job.ts';
import { cookieFlags } from '../../packages/runner/src/passive-security-step.ts';
import { createSecurityObservations } from '../../packages/runner/src/security-observations.ts';
import type { Response } from 'playwright';

const COOKIE_SECRET = 'hornet-cookie-secret-value';
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

describe('passive security header and cookie assessment', () => {
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
      'cookie-not-secure:Low',
      'cookie-samesite-none:Low',
      'cookie-not-secure:Medium',
      'cookie-not-httponly:Medium',
    ]);
    expect(securityStepFailure(bare.findings, 'medium')).toContain('weak-tls');
    expect(securityStepFailure(bare.findings, 'low')).toContain('at or above low');
  });

  it('does not treat HTTP as a missing HSTS or Secure flag, and ignores a zero max-age', () => {
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
    expect(http.findings).toEqual([]);
    expect(http.tls_note).toBe('not_applicable');
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
          type: 'passive_security',
          status: 'pass' as const,
          duration_ms: 1,
          started_at: '',
          finished_at: '',
          passive_security: {
            name: 'home',
            url: 'http://127.0.0.1/home',
            transport: 'http' as const,
            tls_note: 'not_applicable' as const,
            document_headers: {},
            cookies: [],
            findings,
            limits: 'This is not a penetration test.',
          },
        }],
      }],
    }];
  }

  it('lists findings and does not call a passing journey a clean bill of health', () => {
    const text = summaryMarkdown(checked([finding]), 'passed');
    expect(text).toContain('Passive security · qa-user-1 · home · home: 1 finding (missing-csp)');
    expect(text).toContain('This is not a penetration test.');
    expect(text).toContain('not a penetration test');
    expect(text).not.toContain('Nothing needs a change.');
    expect(securityFindings(checked([]))[0]).toContain('no header or cookie-flag findings');
    expect(summaryMarkdown(checked([]), 'passed')).toContain('Nothing needs a change.');
  });
});

function fakeResponse(url: string, headers: Record<string, string>, navigation = true): Response {
  return {
    url: () => url,
    status: () => 200,
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
});

let server: Server;
let port = 0;

beforeAll(async () => {
  process.env.AEGIS_HEADLESS = '1';
  if (chrome) process.env.AEGIS_BROWSER = chrome;
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/locked') {
      res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'self'");
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
      res.setHeader('x-frame-options', 'SAMEORIGIN');
      res.setHeader('permissions-policy', 'camera=()');
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
    runId: 'run_passive_security',
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
    outDir: mkdtempSync(join(tmpdir(), 'hornet-passive-security-')),
    vars: {},
    users: {},
    ...(authorised ? { passiveSecurityAuthorised: true } : {}),
  };
}

describe('the passive security step in the runner', () => {
  it('records header gaps and cookie flags, and never the cookie value', async () => {
    const request = job(
      [
        { navigate: { url: '/bare' } },
        { passive_security: { name: 'bare' } },
        { navigate: { url: '/locked' } },
        { passive_security: { name: 'locked' } },
        { navigate: { url: '/nonce' } },
        { passive_security: { name: 'nonce' } },
      ],
      true,
    );
    const report = await executeJob(request, new Map(), () => false);
    expect(report.status, JSON.stringify(report.steps.map((step) => step.error))).toBe('passed');
    const bare = report.steps[1]?.passive_security;
    expect(bare?.findings.map((finding) => finding.id)).toEqual(['missing-csp', 'missing-referrer-policy', 'missing-frame-protection']);
    expect(bare?.cookies.find((entry) => entry.name === 'session')).toMatchObject({ httpOnly: true, secure: false, sameSite: 'Lax' });
    expect(bare?.cookies.find((entry) => entry.name === 'prefs')).toMatchObject({ httpOnly: false });
    expect(bare?.transport).toBe('http');
    expect(bare?.tls_note).toBe('not_applicable');
    const saved = readFileSync(join(request.outDir, 'passive-security-bare.json'), 'utf8');
    expect(saved).not.toContain(COOKIE_SECRET);
    expect(JSON.stringify(report)).not.toContain(COOKIE_SECRET);
    expect(report.steps[3]?.passive_security?.findings).toEqual([]);
    expect(report.steps[3]?.passive_security?.document_headers['permissions-policy']).toBe('camera=()');
    const nonce = readFileSync(join(request.outDir, 'passive-security-nonce.json'), 'utf8');
    expect(nonce).not.toContain(NONCE);
    expect(nonce).toContain('nonce-[redacted]');
  }, 60_000);

  it('fails the step when fail_on is reached, and refuses the step when the run is not authorised', async () => {
    const failing = job([{ navigate: { url: '/bare' } }, { passive_security: { name: 'bare', fail_on: 'low' } }], true);
    const failed = await executeJob(failing, new Map(), () => false);
    expect(failed.status).toBe('failed');
    expect(failed.steps[1]?.error).toContain('security: 3 findings at or above low');
    expect(failed.steps[1]?.passive_security?.findings.length).toBe(3);

    const refused = job([{ navigate: { url: '/locked' } }, { passive_security: { name: 'locked' } }], false);
    const blocked = await executeJob(refused, new Map(), () => false);
    expect(blocked.status).toBe('failed');
    expect(blocked.steps[1]?.error).toContain('passive_security_not_authorised');
    expect(existsSync(join(refused.outDir, 'passive-security-locked.json'))).toBe(false);

    const early = job([{ passive_security: { name: 'early' } }], true);
    const missing = await executeJob(early, new Map(), () => false);
    expect(missing.steps[0]?.error).toContain('no document response on an authorised origin yet');
  }, 60_000);
});
