import { MIN_SECRET_LENGTH } from './secret-length.js';

/** Headers that carry a session or an API credential. Their values are masked wherever they are saved. */
export const SESSION_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
]);
const HEADER_NAMES = SESSION_HEADER_NAMES;

export type RegisteredSecret = { label: string; value: string };

export class Redactor {
  private forms: { form: string; token: string }[] = [];
  private secrets: { label: string; value: string }[] = [];

  register(label: string, value: string): void {
    if (!value) return;
    this.secrets.push({ label, value });
    const token = `[REDACTED:${label}]`;
    const forms = new Set<string>();
    const keepShort = value.length >= 8 || label.endsWith('.username');
    addDerived(forms, value, keepShort);
    const foldCase = label.endsWith('.username') || label.endsWith('.password') || label.endsWith('.totp_secret');
    if (foldCase) addDerived(forms, value.toLowerCase(), keepShort);
    const originals = new Set<string>([value, ...urlEncodings(value)]);
    if (foldCase) for (const form of [value.toLowerCase(), ...urlEncodings(value.toLowerCase())]) originals.add(form);
    for (const form of forms) {
      if (!form) continue;
      if (!keepShort && form.length < 4 && !originals.has(form)) continue;
      this.forms.push({ form, token });
    }
    this.forms.sort((left, right) => right.form.length - left.form.length);
  }

  registerAll(secrets: RegisteredSecret[]): void {
    for (const secret of secrets) this.register(secret.label, secret.value);
  }

  redact(input: string): string {
    let output = input;
    const seen = new Set<string>();
    for (const { form, token } of this.forms) {
      if (seen.has(form) || !output.includes(form)) continue;
      seen.add(form);
      output = output.split(form).join(token);
    }
    return maskSessionMaterial(maskCredentialQueries(output, this.secrets));
  }

  contains(input: string): boolean {
    if (this.forms.some(({ form }) => form.length > 0 && input.includes(form))) return true;
    return credentialQueryIsRaw(input) || sessionMaterialIsRaw(input);
  }

  redactUnknown(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactUnknown(entry));
    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (HEADER_NAMES.has(key.toLowerCase())) {
          output[key] = '[REDACTED:header]';
          continue;
        }
        if (key === 'value' || key === 'password' || key === 'secret' || key === 'totp_secret') {
          output[key] = '[REDACTED:field]';
          continue;
        }
        output[key] = this.redactUnknown(entry);
      }
      return output;
    }
    return value;
  }
}

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textNodeEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The ways a browser or HTTP client percent-encodes a value. An HTML form posts
 * application/x-www-form-urlencoded, which encodes `!'()~` and turns a space into `+`.
 * encodeURIComponent leaves those characters alone, so both spellings are needed.
 */
export function urlEncodings(value: string): string[] {
  const component = encodeURIComponent(value);
  const form = new URLSearchParams([['', value]]).toString().slice(1);
  const strict = component.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const forms = new Set([component, form, form.replace(/\+/g, '%20'), strict, strict.replace(/%20/g, '+')]);
  for (const form of [...forms]) forms.add(form.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
  return [...forms];
}

/**
 * A value inside a larger base64 string, such as a JSON body or `user:password` in Basic auth,
 * starts at one of three byte offsets. For each offset this keeps only the characters that come
 * from the value's own bytes. The base64url spelling, used by JWTs, is added too.
 */
export function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const forms = new Set<string>([bytes.toString('base64')]);
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    // Characters before `start` mix in the bytes ahead of the value. Characters after `end` mix in the bytes behind it.
    const start = offset === 0 ? 0 : offset + 1;
    const end = Math.floor((offset + bytes.length) / 3) * 4;
    const inner = encoded.slice(start, end);
    if (inner.length >= 8) forms.add(inner);
  }
  for (const form of [...forms]) forms.add(form.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  return [...forms];
}

function addDerived(forms: Set<string>, value: string, keepShort: boolean): void {
  forms.add(value);
  for (const encoded of urlEncodings(value)) forms.add(encoded);
  for (const encoded of base64Forms(value)) forms.add(encoded);
  forms.add(htmlEscape(value));
  forms.add(textNodeEscape(value));
  for (const base of [value, htmlEscape(value), textNodeEscape(value), ...urlEncodings(value)]) addJsonEscapes(forms, base, keepShort);
}

function addJsonEscapes(forms: Set<string>, value: string, keepShort: boolean): void {
  let encoded = value;
  for (let level = 0; level < 3; level += 1) {
    const next = JSON.stringify(encoded).slice(1, -1);
    if (next === encoded || (!keepShort && next.length < 4)) break;
    forms.add(next);
    encoded = next;
  }
}

export function maskHeader(name: string, value: string, redactor: Redactor): string {
  if (HEADER_NAMES.has(name.toLowerCase())) return '[REDACTED:header]';
  return redactor.redact(value);
}

/**
 * Names of a query parameter that carry a credential. Longer names are listed first so
 * `totp_secret` is not read as `secret`.
 */
const CREDENTIAL_QUERY_KEY = 'totp_secret|access_token|refresh_token|api_key|api-key|password|passwd|secret|totp|pwd';

function credentialQueryPattern(): RegExp {
  return new RegExp(`(^|[?#]|%26|&amp;|&)((?:${CREDENTIAL_QUERY_KEY}))=([^&#"'\\s<>\\\\]*)`, 'gi');
}

function decodeQueryComponent(value: string): string {
  const plus = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

function redactedToken(value: string): { token: string; suffix: string } | undefined {
  const match = /^(\[REDACTED:[^\]]+\])(.*)$/u.exec(value);
  if (!match?.[1]) return undefined;
  return { token: match[1], suffix: match[2] ?? '' };
}

/**
 * A `#` in a password ends the query string, so a saved URL can hold a prefix of the
 * secret. That prefix is not one of the stored spellings. The whole parameter value is
 * masked. A value that is already `[REDACTED:...]` is left as it is, label and all.
 * Stored secrets are replaced first, so a `#` that is still part of the full secret
 * is removed with it and is not left behind the mask.
 */
function maskCredentialQueries(input: string, secrets: { label: string; value: string }[]): string {
  return input.replace(credentialQueryPattern(), (match, separator: string, key: string, value: string) => {
    const existing = redactedToken(value);
    if (existing && existing.suffix.length === 0) return match;
    if (existing) return `${separator}${key}=${existing.token}`;
    const decoded = decodeQueryComponent(value);
    if (decoded.length < MIN_SECRET_LENGTH) return match;
    const label = credentialLabel(secrets, key, decoded);
    return `${separator}${key}=${label ? `[REDACTED:${label}]` : '[REDACTED:query]'}`;
  });
}

/**
 * Values that are a session even when they are not one of the stored logins: a credential
 * JSON field (including a password hash), a JWT, a Cloudflare challenge token in a URL, and
 * the challenge cookies when they appear outside a header that was already masked.
 */
const SESSION_JSON_KEY = 'access_token|refresh_token|id_token|totp_secret|api_key|password|passwd|secret|totp|pwd';
/** A payment card, as a JSON string or a bare number. Years and prices are too short to match. */
const CARD_JSON_KEY = 'cardNum|cardNumber|card_number';
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const CHALLENGE_PATH = /\/cdn-cgi\/challenge-platform\/[^\s"'<>\\]*/;
const CHALLENGE_COOKIE = /\b(cf_clearance|__cf_bm|_cfuvid|cf_chl_[A-Za-z0-9_]+)=([^\s;"',]+)/;

function maskSessionMaterial(input: string): string {
  return maskChallengeCookies(maskChallengeTokens(maskJwts(maskCardNumbers(maskCredentialJson(input)))));
}

function sessionMaterialIsRaw(input: string): boolean {
  return credentialJsonIsRaw(input) || cardNumberIsRaw(input) || jwtIsRaw(input) || challengeTokenIsRaw(input) || challengeCookieIsRaw(input);
}

function maskCardNumbers(input: string): string {
  return maskCardFieldLines(maskCardSpelling(maskCardSpelling(input, false), true));
}

/** The page-text dump writes `Card Number:` and then the digits. That line is not a JSON field. */
function maskCardFieldLines(input: string): string {
  return input.replace(/(Card Number:\s*)(\d{12,19})\b/gi, '$1[REDACTED:field]');
}

function maskCardSpelling(input: string, escaped: boolean): string {
  const quoted = escaped
    ? new RegExp(`(\\\\"(?:${CARD_JSON_KEY})\\\\"\\s*:\\s*\\\\")(\\d{12,19})(\\\\")`, 'gi')
    : new RegExp(`("(?:${CARD_JSON_KEY})"\\s*:\\s*")(\\d{12,19})(")`, 'gi');
  const bare = escaped
    ? new RegExp(`(\\\\"(?:${CARD_JSON_KEY})\\\\"\\s*:\\s*)(\\d{12,19})\\b`, 'gi')
    : new RegExp(`("(?:${CARD_JSON_KEY})"\\s*:\\s*)(\\d{12,19})\\b`, 'gi');
  return input.replace(quoted, '$1[REDACTED:field]$3').replace(bare, '$1[REDACTED:field]');
}

function cardNumberIsRaw(input: string): boolean {
  const raw = new RegExp(`"(?:${CARD_JSON_KEY})"\\s*:\\s*"?(\\d{12,19})`, 'gi');
  const escaped = new RegExp(`\\\\"(?:${CARD_JSON_KEY})\\\\"\\s*:\\s*(?:\\\\")?(\\d{12,19})`, 'gi');
  const field = /Card Number:\s*\d{12,19}\b/i;
  return raw.test(input) || escaped.test(input) || field.test(input);
}

function maskCredentialJson(input: string): string {
  return maskJsonSpelling(maskJsonSpelling(input, false), true);
}

function maskJsonSpelling(input: string, escaped: boolean): string {
  return input.replace(credentialJsonPattern(escaped), (match, open: string, value: string, close: string) => {
    if (isRedactedToken(value) || value.length < MIN_SECRET_LENGTH) return match;
    const token = JWT_PATTERN.test(value) ? '[REDACTED:jwt]' : '[REDACTED:field]';
    return `${open}${token}${close}`;
  });
}

function credentialJsonPattern(escaped: boolean): RegExp {
  if (escaped) return new RegExp(`(\\\\"(?:${SESSION_JSON_KEY})\\\\"\\s*:\\s*\\\\")([^"\\\\]*)(\\\\")`, 'gi');
  return new RegExp(`("(?:${SESSION_JSON_KEY})"\\s*:\\s*")((?:\\\\.|[^"\\\\])*)(")`, 'gi');
}

function credentialJsonIsRaw(input: string): boolean {
  return jsonSpellingIsRaw(input, false) || jsonSpellingIsRaw(input, true);
}

function jsonSpellingIsRaw(input: string, escaped: boolean): boolean {
  for (const match of input.matchAll(credentialJsonPattern(escaped))) {
    const value = match[2] ?? '';
    if (!isRedactedToken(value) && value.length >= MIN_SECRET_LENGTH) return true;
  }
  return false;
}

function isRedactedToken(value: string): boolean {
  return /^\[REDACTED:[^\]]+\]$/.test(value);
}

function maskJwts(input: string): string {
  return input.replace(new RegExp(JWT_PATTERN.source, 'g'), '[REDACTED:jwt]');
}

function jwtIsRaw(input: string): boolean {
  return new RegExp(JWT_PATTERN.source).test(input);
}

function maskChallengeTokens(input: string): string {
  return input.replace(new RegExp(CHALLENGE_PATH.source, 'g'), (path) =>
    path
      .split('/')
      .map((segment) => (challengeSegment(segment) ? '[REDACTED:challenge]' : segment))
      .join('/'),
  );
}

function challengeTokenIsRaw(input: string): boolean {
  for (const match of input.matchAll(new RegExp(CHALLENGE_PATH.source, 'g'))) {
    if (match[0].split('/').some((segment) => challengeSegment(segment))) return true;
  }
  return false;
}

function challengeSegment(segment: string): boolean {
  if (!segment || segment.startsWith('[REDACTED:')) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  return decoded.includes(':') && decoded.length >= MIN_SECRET_LENGTH;
}

function maskChallengeCookies(input: string): string {
  return input.replace(new RegExp(CHALLENGE_COOKIE.source, 'g'), (match, name: string, value: string) => {
    if (isRedactedToken(value) || value.length < MIN_SECRET_LENGTH) return match;
    return `${name}=[REDACTED:challenge]`;
  });
}

function challengeCookieIsRaw(input: string): boolean {
  for (const match of input.matchAll(new RegExp(CHALLENGE_COOKIE.source, 'g'))) {
    const value = match[2] ?? '';
    if (!isRedactedToken(value) && value.length >= MIN_SECRET_LENGTH) return true;
  }
  return false;
}

function credentialQueryIsRaw(input: string): boolean {
  for (const match of input.matchAll(credentialQueryPattern())) {
    const value = match[3] ?? '';
    const existing = redactedToken(value);
    if (existing) {
      if (existing.suffix.length > 0) return true;
      continue;
    }
    if (decodeQueryComponent(value).length >= MIN_SECRET_LENGTH) return true;
  }
  return false;
}

function credentialLabel(secrets: { label: string; value: string }[], key: string, candidate: string): string | undefined {
  const family = keyFamily(key);
  let best: { label: string; family: boolean; exact: boolean; overlap: number } | undefined;
  for (const secret of secrets) {
    const fold = secret.label.endsWith('.password') || secret.label.endsWith('.totp_secret') || secret.label.endsWith('.username');
    const stored = fold ? secret.value.toLowerCase() : secret.value;
    const given = fold ? candidate.toLowerCase() : candidate;
    if (stored.length < MIN_SECRET_LENGTH || given.length < MIN_SECRET_LENGTH) continue;
    if (!stored.startsWith(given) && !given.startsWith(stored)) continue;
    const next = {
      label: secret.label,
      family: family !== undefined && secret.label.endsWith(family),
      exact: stored === given,
      overlap: Math.min(stored.length, given.length),
    };
    if (!best || betterCredentialMatch(next, best)) best = next;
  }
  return best?.label;
}

function betterCredentialMatch(
  next: { family: boolean; exact: boolean; overlap: number },
  best: { family: boolean; exact: boolean; overlap: number },
): boolean {
  if (next.family !== best.family) return next.family;
  if (next.exact !== best.exact) return next.exact;
  return next.overlap > best.overlap;
}

function keyFamily(key: string): string | undefined {
  const name = key.toLowerCase();
  if (name === 'password' || name === 'passwd' || name === 'pwd') return '.password';
  if (name === 'totp' || name === 'totp_secret') return '.totp_secret';
  return undefined;
}
