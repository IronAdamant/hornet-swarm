import { inspect } from 'node:util';

export const MIN_SECRET_LENGTH = 8;

export const SHORT_SECRET_ERROR = 'That secret is too short. It must be at least 8 characters.';

export const CREDENTIAL_FIELDS = ['username', 'password', 'totp_secret'] as const;
export type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

/**
 * Whether a value is as long as an admitted secret. A shorter value can never be stored as a
 * password or TOTP secret, so detection may leave it unmasked. The redactor uses this, not its own number.
 */
export function meetsSecretLength(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH;
}

/** The field a redaction label such as `qa-user-1.password` names, if it names one. */
export function credentialFieldOf(label: string): CredentialField | undefined {
  return CREDENTIAL_FIELDS.find((field) => label.endsWith(`.${field}`));
}

const values = new WeakMap<Secret, string>();

/**
 * A stored login field. `Secret.parse` is the only constructor, and it carries the length rule:
 * a password or TOTP secret needs 8 characters, a username only needs to be non-empty. A username
 * is not a secret, but it is still masked in every saved file, short or not.
 *
 * The value never serialises: JSON, string conversion, and console output all print a redaction
 * token, so a Secret that strays into a report or a log cannot leak. `reveal` is the only way out.
 */
export class Secret {
  private constructor(readonly field: CredentialField) {}

  static parse(field: CredentialField, value: string): { ok: true; secret: Secret } | { ok: false; error: string } {
    if (!CREDENTIAL_FIELDS.includes(field)) return { ok: false, error: 'unsupported field' };
    if (typeof value !== 'string' || value.length === 0) return { ok: false, error: 'empty secret' };
    if (field !== 'username' && !meetsSecretLength(value)) return { ok: false, error: SHORT_SECRET_ERROR };
    const secret = new Secret(field);
    values.set(secret, value);
    return { ok: true, secret };
  }

  /** parse, throwing its error. */
  static require(field: CredentialField, value: string): Secret {
    const parsed = Secret.parse(field, value);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.secret;
  }

  reveal(): string {
    return values.get(this) ?? '';
  }

  toJSON(): string {
    return `[REDACTED:${this.field}]`;
  }

  toString(): string {
    return this.toJSON();
  }

  [inspect.custom](): string {
    return this.toJSON();
  }
}

export type ParsedLogin = Partial<Record<CredentialField, Secret>>;

/** Parses every given field of one login. Undefined fields are left out; an empty one is an error. */
export function parseLogin(given: Partial<Record<CredentialField, string | undefined>>): { ok: true; secrets: ParsedLogin } | { ok: false; error: string } {
  const secrets: ParsedLogin = {};
  for (const field of ['password', 'totp_secret', 'username'] as const) {
    const value = given[field];
    if (value === undefined) continue;
    const parsed = Secret.parse(field, value);
    if (!parsed.ok) return parsed;
    secrets[field] = parsed.secret;
  }
  return { ok: true, secrets };
}

/** The first error among optional password and TOTP inputs. Blank values are skipped. Never pass a username. */
export function shortSecretError(...given: Array<string | undefined>): string | undefined {
  for (const value of given) {
    if (value === undefined || value.length === 0) continue;
    const parsed = Secret.parse('password', value);
    if (!parsed.ok) return parsed.error;
  }
  return undefined;
}
