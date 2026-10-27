import { z } from 'zod';

/**
 * Headers a passive check may record. Anything else, including Cookie and Set-Cookie, is dropped.
 * A nonce in a Content-Security-Policy is not a session secret, but it is unguessable, so it is
 * replaced before the value is kept.
 */
export const SECURITY_HEADER_NAMES = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'strict-transport-security',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
] as const;

const HEADER_LIMIT = 1500;

const ACCEPTED_REFERRER = new Set([
  'no-referrer',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
]);

/** A cookie whose name is the session, not a preference or a CSRF cookie. */
const SESSION_COOKIE_NAME = /(^|[^a-z0-9])(jsessionid|phpsessid|sessionid|session|sessid|sid|auth|jwt)([^a-z0-9]|$)/i;

export const PASSIVE_SECURITY_LIMITS =
  'Reads headers on the last document response this journey already received, and the flags of cookies the browser stored for that site. Cookie values are not recorded. Query strings are not recorded. No extra request is sent. This is not a penetration test.';

export const securitySeveritySchema = z.enum(['Low', 'Medium']);
export type SecuritySeverity = z.infer<typeof securitySeveritySchema>;

export const cookieFlagsSchema = z
  .object({
    name: z.string(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(['Strict', 'Lax', 'None']),
    persistent: z.boolean(),
  })
  .strict();

export type CookieFlags = z.infer<typeof cookieFlagsSchema>;

export const securityFindingSchema = z
  .object({
    id: z.string(),
    severity: securitySeveritySchema,
    summary: z.string(),
  })
  .strict();

export type SecurityFinding = z.infer<typeof securityFindingSchema>;

export const securityResultSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    transport: z.enum(['http', 'https', 'none']),
    tls_protocol: z.string().optional(),
    tls_note: z.enum(['recorded', 'not_applicable', 'unavailable']),
    document_headers: z.record(z.string()),
    cookies: z.array(cookieFlagsSchema),
    findings: z.array(securityFindingSchema),
    limits: z.string(),
  })
  .strict();

export type PassiveSecurityResult = z.infer<typeof securityResultSchema>;

/**
 * Reads the document the journey already loaded. It sends nothing. `fail_on` fails the step when
 * a finding is at least that severe. With no `fail_on`, findings are recorded and the step passes.
 */
export const passiveSecurityStep = z
  .object({
    passive_security: z
      .object({
        name: z.string().regex(/^[a-z0-9-]+$/, 'use lower-case letters, digits, and hyphens'),
        fail_on: z.enum(['low', 'medium']).optional(),
      })
      .strict(),
  })
  .strict();

export type DocumentObservation = {
  /** Origin and path only. The query string is left off so a token in it is not kept. */
  url: string;
  protocol: 'http' | 'https';
  status: number;
  headers: Record<string, string>;
  tlsProtocol?: string;
};

export type PassiveSecurityInput = {
  name: string;
  /** Origin and path of the page, used when no document response was observed. */
  pageUrl: string;
  document?: DocumentObservation;
  cookies: readonly CookieFlags[];
};

const SEVERITY_RANK: Record<SecuritySeverity, number> = { Low: 1, Medium: 2 };

/** Copies the allowlisted headers only, strips CSP nonces, and caps each value. */
export function selectSecurityHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of SECURITY_HEADER_NAMES) {
    const raw = headers[name];
    if (raw === undefined || raw.trim() === '') continue;
    picked[name] = trimHeader(raw);
  }
  return picked;
}

export function sessionCookieName(name: string): boolean {
  return SESSION_COOKIE_NAME.test(name);
}

export function assessPassiveSecurity(input: PassiveSecurityInput): PassiveSecurityResult {
  const document = input.document;
  if (!document) {
    return {
      name: input.name,
      url: input.pageUrl,
      transport: 'none',
      tls_note: 'unavailable',
      document_headers: {},
      cookies: [],
      findings: [
        {
          id: 'no-document',
          severity: 'Low',
          summary: 'No document response on an authorised origin was observed before this step. Navigate to a page on the authorised site first.',
        },
      ],
      limits: PASSIVE_SECURITY_LIMITS,
    };
  }
  const headers = document.headers;
  const https = document.protocol === 'https';
  const findings: SecurityFinding[] = [];
  if (https && document.tlsProtocol && weakTls(document.tlsProtocol)) {
    findings.push({
      id: 'weak-tls',
      severity: 'Medium',
      summary: `The document was loaded over ${document.tlsProtocol}.`,
    });
  }
  if (https && !hstsActive(headers['strict-transport-security'])) {
    findings.push({
      id: 'missing-hsts',
      severity: 'Low',
      summary: 'The HTTPS document response had no Strict-Transport-Security header with a max-age above zero.',
    });
  }
  if (!headers['content-security-policy']) {
    findings.push({
      id: 'missing-csp',
      severity: 'Low',
      summary: 'The document response did not include a Content-Security-Policy header. A report-only policy is recorded and does not count as one.',
    });
  }
  if (headers['x-content-type-options']?.trim().toLowerCase() !== 'nosniff') {
    findings.push({
      id: 'missing-nosniff',
      severity: 'Low',
      summary: 'The document response did not include X-Content-Type-Options: nosniff.',
    });
  }
  if (!referrerAccepted(headers['referrer-policy'])) {
    findings.push({
      id: 'missing-referrer-policy',
      severity: 'Low',
      summary: 'The document response had no accepted Referrer-Policy. unsafe-url, no-referrer-when-downgrade, and an unrecognised value are recorded as findings.',
    });
  }
  if (!frameProtected(headers)) {
    findings.push({
      id: 'missing-frame-protection',
      severity: 'Low',
      summary: "The document response had neither X-Frame-Options DENY or SAMEORIGIN nor a Content-Security-Policy frame-ancestors directive.",
    });
  }
  const cookies = [...input.cookies].sort((left, right) => left.name.localeCompare(right.name));
  for (const cookie of cookies) {
    if (https && !cookie.secure) {
      findings.push({
        id: 'cookie-not-secure',
        severity: sessionCookieName(cookie.name) ? 'Medium' : 'Low',
        summary: `Cookie ${cookie.name} was stored without the Secure flag on an HTTPS page.`,
      });
    }
    if (sessionCookieName(cookie.name) && !cookie.httpOnly) {
      findings.push({
        id: 'cookie-not-httponly',
        severity: 'Medium',
        summary: `Cookie ${cookie.name} matches a session-cookie name and is readable by page script, because it has no HttpOnly flag.`,
      });
    }
    if (cookie.sameSite === 'None') {
      findings.push({
        id: 'cookie-samesite-none',
        severity: 'Low',
        summary: `Cookie ${cookie.name} is SameSite=None, so the browser sends it on cross-site requests.`,
      });
    }
  }
  return {
    name: input.name,
    url: document.url,
    transport: document.protocol,
    ...(document.tlsProtocol ? { tls_protocol: document.tlsProtocol } : {}),
    tls_note: https ? (document.tlsProtocol ? 'recorded' : 'unavailable') : 'not_applicable',
    document_headers: headers,
    cookies,
    findings,
    limits: PASSIVE_SECURITY_LIMITS,
  };
}

/** Set when `fail_on` is present and a finding is at least that severe. Otherwise the step passes. */
export function securityStepFailure(findings: readonly SecurityFinding[], failOn: 'low' | 'medium' | undefined): string | undefined {
  if (!failOn) return undefined;
  const threshold = failOn === 'medium' ? SEVERITY_RANK.Medium : SEVERITY_RANK.Low;
  const serious = findings.filter((finding) => SEVERITY_RANK[finding.severity] >= threshold);
  if (serious.length === 0) return undefined;
  const listed = serious
    .slice(0, 5)
    .map((finding) => finding.id)
    .join(', ');
  return `security: ${serious.length} ${serious.length === 1 ? 'finding' : 'findings'} at or above ${failOn} (${listed})`;
}

function trimHeader(value: string): string {
  const stripped = value.replace(/'nonce-[^']*'/gi, "'nonce-[redacted]'").replace(/\bnonce-[A-Za-z0-9+/=_-]+/gi, 'nonce-[redacted]');
  if (stripped.length <= HEADER_LIMIT) return stripped;
  return `${stripped.slice(0, HEADER_LIMIT)}…`;
}

function weakTls(protocol: string): boolean {
  return /ssl|tls\s*1\.[01]\b/i.test(protocol);
}

function hstsActive(value: string | undefined): boolean {
  if (!value) return false;
  const maxAge = /max-age\s*=\s*(\d+)/i.exec(value);
  return maxAge !== null && Number(maxAge[1]) > 0;
}

function referrerAccepted(value: string | undefined): boolean {
  const first = value?.split(',')[0]?.trim().toLowerCase() ?? '';
  return ACCEPTED_REFERRER.has(first);
}

function frameProtected(headers: Readonly<Record<string, string>>): boolean {
  const frame = headers['x-frame-options']?.trim().toLowerCase() ?? '';
  if (frame === 'deny' || frame === 'sameorigin') return true;
  const ancestors = /frame-ancestors\s+([^;]+)/i.exec(headers['content-security-policy'] ?? '');
  const directive = ancestors?.[1]?.trim().toLowerCase() ?? '';
  return directive.length > 0 && directive !== '*';
}
