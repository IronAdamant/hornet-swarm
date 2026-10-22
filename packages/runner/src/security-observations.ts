import type { Response } from 'playwright';
import { selectSecurityHeaders, type DocumentObservation } from '@hornet-swarm/core';

const DOCUMENT_LIMIT = 30;

/**
 * Document responses the browser already received on an authorised origin. Built only when the
 * run's authorisation listed `passive_security_checks`. Cookie and Set-Cookie are never copied.
 */
export type SecurityObservations = {
  note: (response: Response) => void;
  flush: () => Promise<void>;
  latestDocument: () => DocumentObservation | undefined;
};

export function createSecurityObservations(allowedOrigins: readonly string[], passiveOrigins: readonly string[] = []): SecurityObservations {
  const allowed = new Set(allowedOrigins);
  const passive = new Set(passiveOrigins);
  const documents: DocumentObservation[] = [];
  let pending = 0;

  const note = (response: Response): void => {
    if (!mainDocument(response)) return;
    const parsed = documentAddress(response.url());
    if (!parsed || !allowed.has(parsed.origin) || passive.has(parsed.origin)) return;
    let headers: Record<string, string>;
    try {
      headers = selectSecurityHeaders(response.headers());
    } catch {
      headers = {};
    }
    if (documents.length >= DOCUMENT_LIMIT) documents.shift();
    const observed: DocumentObservation = { url: parsed.url, protocol: parsed.protocol, status: response.status(), headers };
    documents.push(observed);
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
      return documents[documents.length - 1];
    },
  };
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
