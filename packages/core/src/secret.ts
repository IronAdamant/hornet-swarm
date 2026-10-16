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

type SecretRecord = { field: CredentialField; value: string };

/** The field and value `Secret.parse` checked. Kept off the object so assigning `.field` or replacing `reveal` cannot relabel a short username as a password. */
const records = new WeakMap<Secret, SecretRecord>();

/**
 * A stored login field. `Secret.parse` is the only constructor, and it carries the length rule:
 * a password or TOTP secret needs 8 characters, a username only needs to be non-empty. A username
 * is not a secret, but it is still masked in every saved file, short or not.
 *
 * The value never serialises: JSON, string conversion, and console output all print a redaction
 * token, so a Secret that strays into a report or a log cannot leak. `reveal` is the only way out.
 */
export class Secret {
  private constructor() {}

  /** The field `parse` stored. An own property of the same name does not change what `valueForField` reads. */
  get field(): CredentialField {
    return records.get(this)?.field ?? 'username';
  }

  static parse(field: CredentialField, value: string): { ok: true; secret: Secret } | { ok: false; error: string } {
    if (!CREDENTIAL_FIELDS.includes(field)) return { ok: false, error: 'unsupported field' };
    if (typeof value !== 'string' || value.length === 0) return { ok: false, error: 'empty secret' };
    if (field !== 'username' && !meetsSecretLength(value)) return { ok: false, error: SHORT_SECRET_ERROR };
    const secret = new Secret();
    records.set(secret, { field, value });
    return { ok: true, secret };
  }

  /** parse, throwing its error. */
  static require(field: CredentialField, value: string): Secret {
    const parsed = Secret.parse(field, value);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.secret;
  }

  reveal(): string {
    return records.get(this)?.value ?? '';
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

/**
 * The value `parse` stored for `field`. This is what the secret store writes. It reads the private
 * record, so a caller cannot relabel a short username as a password or replace `reveal` with a
 * shorter string.
 */
export function valueForField(secret: Secret | undefined, field: CredentialField): string {
  const record = secret instanceof Secret ? records.get(secret) : undefined;
  if (!record || record.field !== field) throw new Error('A login field must be a Secret made by Secret.parse.');
  if (!record.value) throw new Error('empty secret');
  if (field !== 'username' && !meetsSecretLength(record.value)) throw new Error(SHORT_SECRET_ERROR);
  return record.value;
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
