import { timingSafeEqual } from 'node:crypto';

export type HeaderMap = Record<string, string | string[] | undefined>;

export type ControlRefusal = { ok: false; status: 401 | 403 | 415; error: 'browser_request' | 'bad_token' | 'content_type' };

export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export function admitControlRequest(input: {
  method: string;
  headers: HeaderMap;
  expectedToken: string;
}): { ok: true } | ControlRefusal {
  const names = Object.keys(input.headers).map((name) => name.toLowerCase());
  if (names.some((name) => name === 'origin' || name === 'referer' || name.startsWith('sec-fetch-'))) {
    return { ok: false, status: 403, error: 'browser_request' };
  }
  const presented = bearerToken(headerValue(input.headers, 'authorization'));
  if (!tokenMatches(input.expectedToken, presented)) return { ok: false, status: 401, error: 'bad_token' };
  const type = headerValue(input.headers, 'content-type');
  const method = input.method.toUpperCase();
  const json = Boolean(type && type.toLowerCase().startsWith('application/json'));
  if (method === 'GET' || method === 'HEAD') {
    if (type && !json) return { ok: false, status: 415, error: 'content_type' };
    return { ok: true };
  }
  if (!json) return { ok: false, status: 415, error: 'content_type' };
  return { ok: true };
}

export function wipeSecretStore(secrets: Map<string, string>): void {
  for (const handle of [...secrets.keys()]) {
    secrets.set(handle, '');
    secrets.delete(handle);
  }
}

function bearerToken(header: string | undefined): string {
  if (!header) return '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? '';
}

function tokenMatches(expected: string, presented: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
