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

  register(label: string, value: string): void {
    if (!value) return;
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
    return output;
  }

  contains(input: string): boolean {
    return this.forms.some(({ form }) => form.length > 0 && input.includes(form));
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
