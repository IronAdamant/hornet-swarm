import type { Page } from 'playwright';
import {
  assessPassiveSecurity,
  securityResultSchema,
  securityStepFailure,
  type CookieFlags,
  type PassiveSecurityResult,
  type Redactor,
} from '@hornet-swarm/core';
import type { SecurityObservations } from './security-observations.js';

type JarCookie = {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  expires: number;
};

/**
 * Cookie flags only. The value is not part of this type, and the caller must not copy it in.
 */
export function cookieFlags(cookies: readonly JarCookie[]): CookieFlags[] {
  return cookies.map((cookie) => ({
    name: cookie.name,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite === 'Strict' || cookie.sameSite === 'None' ? cookie.sameSite : 'Lax',
    persistent: cookie.expires > 0,
  }));
}

export async function runPassiveSecurityCheck(
  page: Page,
  check: { name: string; fail_on?: 'low' | 'medium' },
  authorised: boolean,
  observations: SecurityObservations | undefined,
  redactor: Redactor,
  save: (fileName: string, text: string) => void,
): Promise<{ result: PassiveSecurityResult; failure?: string }> {
  if (!authorised || !observations) throw new Error('header_cookie_check_not_permitted');
  await observations.flush();
  const document = observations.latestDocument();
  const pageUrl = document?.url ?? observations.redirectUrl() ?? pageAddress(page.url());
  const assessed = document
    ? assessPassiveSecurity({
        name: check.name,
        pageUrl,
        document,
        cookies: cookieFlags(await cookieJar(page, document.url)),
      })
    : observations.endedOnRedirect()
      ? assessPassiveSecurity({ name: check.name, pageUrl, cookies: [], redirectOnly: true })
      : undefined;
  if (!assessed) throw new Error('header-cookie: no page response on an allowed host yet');
  const result = securityResultSchema.parse(JSON.parse(redactor.redact(JSON.stringify(assessed))));
  save(`header-cookie-check-${check.name}.json`, JSON.stringify(result, null, 2));
  return { result, failure: securityStepFailure(result.findings, check.fail_on) };
}

/** Flags for the page that was checked. The value is not copied. */
async function cookieJar(page: Page, url: string): Promise<JarCookie[]> {
  const jar = await page.context().cookies(url);
  return jar.map((cookie) => ({
    name: cookie.name,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    expires: cookie.expires,
  }));
}

function pageAddress(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw;
  }
}
