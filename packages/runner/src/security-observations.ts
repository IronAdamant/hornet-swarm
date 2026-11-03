import type { Response } from 'playwright';
import { selectSecurityHeaders, type DocumentObservation } from '@hornet-swarm/core';

const DOCUMENT_LIMIT = 30;

/**
 * Document responses the browser already received on an allowed host. Built only when the
 * run's authorisation listed `header_cookie_checks`. Cookie and Set-Cookie are never copied.
 * A redirect is remembered so it is not graded as the page. The final page is the last
 * main-frame response that was not a redirect.
 */
export type SecurityObservations = {
  note: (response: Response) => void;
  flush: () => Promise<void>;
  /** The final page, when the last observed main-frame response on an allowed host was that page. */
  latestDocument: () => DocumentObservation | undefined;
  /** True when that last response was a redirect, so an earlier page is not graded in its place. */
  endedOnRedirect: () => boolean;
  /** Origin and path of that redirect. The query string is left off. */
  redirectUrl: () => string | undefined;
};

export function createSecurityObservations(allowedOrigins: readonly string[], passiveOrigins: readonly string[] = []): SecurityObservations {
  const allowed = new Set(allowedOrigins);
  const passive = new Set(passiveOrigins);
  const documents: DocumentObservation[] = [];
  let pending = 0;
  let tail: 'none' | 'page' | 'redirect' = 'none';
  let hopUrl: string | undefined;

  const note = (response: Response): void => {
    if (!mainDocument(response)) return;
    const parsed = documentAddress(response.url());
    if (!parsed || !allowed.has(parsed.origin) || passive.has(parsed.origin)) return;
    const status = readStatus(response);
    if (status === undefined) return;
    if (isRedirect(status)) {
      tail = 'redirect';
      hopUrl = parsed.url;
      return;
    }
    let headers: Record<string, string>;
    try {
      headers = selectSecurityHeaders(response.headers());
    } catch {
      headers = {};
    }
    if (documents.length >= DOCUMENT_LIMIT) documents.shift();
    const observed: DocumentObservation = { url: parsed.url, protocol: parsed.protocol, status, headers };
    documents.push(observed);
    tail = 'page';
    hopUrl = undefined;
    if (parsed.protocol !== 'https') return;
    pending += 1;
    void response
      .securityDetails()
      .then((details) => {
        if (details?.protocol) observed.tlsProtocol = details.protocol;
      })
      .catch(() => undefined)
      .finally(() => {
        pending -= 1;
      });
  };

  return {
    note,
    async flush() {
      const end = Date.now() + 2_000;
      while (pending > 0 && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    },
    latestDocument() {
      if (tail !== 'page') return undefined;
      return documents[documents.length - 1];
    },
    endedOnRedirect() {
      return tail === 'redirect';
    },
    redirectUrl() {
      return tail === 'redirect' ? hopUrl : undefined;
    },
  };
}

function readStatus(response: Response): number | undefined {
  try {
    return response.status();
  } catch {
    return undefined;
  }
}

/** A hop to another URL, not the page that was served. 304 is a cached page, not a hop. */
function isRedirect(status: number): boolean {
  return status === 300 || status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function mainDocument(response: Response): boolean {
  try {
    const request = response.request();
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    return false;
  }
}

function documentAddress(raw: string): { origin: string; url: string; protocol: 'http' | 'https' } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return {
    origin: parsed.origin,
    url: `${parsed.origin}${parsed.pathname}`,
    protocol: parsed.protocol === 'https:' ? 'https' : 'http',
  };
}
