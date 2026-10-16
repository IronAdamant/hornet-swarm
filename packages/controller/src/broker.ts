import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { CREDENTIAL_FIELDS, privateDir, privateTempDir, Redactor, Secret, writePrivateFile, type CredentialField } from '@hornet-swarm/core';
import { aegisHome } from './home.js';
import { withFileLock } from './leases-store.js';
import { runnerFetch } from './runner-auth.js';
import { totpCode, waitForFreshCode } from './totp.js';

const SERVICE = 'hornet-swarm-age-key';
const LEGACY_SERVICE = 'aegis-age-key';
const FIELDS = CREDENTIAL_FIELDS;
export type SecretField = CredentialField;

type SecretUser = { username?: string; password?: string; totp_secret?: string };
type SecretFile = { users: Record<string, SecretUser> };

export type InjectedHandle = { ok: true; handles: string[]; code?: string };

export function listLabels(project: string, home = aegisHome()): string[] {
  return Object.keys(readUsers(home, project)).filter((label) => /^qa-user-\d+$/.test(label));
}

export function registerProjectSecrets(project: string, redactor: Redactor, home = aegisHome()): void {
  for (const [label, user] of Object.entries(readUsers(home, project))) {
    if (user.username) redactor.register(`${label}.username`, user.username);
    if (user.password) redactor.register(`${label}.password`, user.password);
    if (user.totp_secret) redactor.register(`${label}.totp_secret`, user.totp_secret);
  }
}

export function projectSecretValues(project: string, home = aegisHome()): string[] {
  const values: string[] = [];
  for (const user of Object.values(readUsers(home, project))) {
    for (const field of FIELDS) {
      const value = user[field];
      if (value) values.push(value);
    }
  }
  return values;
}

/** Which fields each label has stored, read with one decryption. Values are never returned. */
export function storedFields(project: string, home = aegisHome()): Record<string, SecretField[]> {
  return Object.fromEntries(
    Object.entries(readUsers(home, project)).map(([label, user]) => [label, FIELDS.filter((field) => typeof user[field] === 'string' && user[field])]),
  );
}

export function listFields(project: string, label: string, home = aegisHome()): SecretField[] {
  const user = readUsers(home, project)[label] ?? {};
  return FIELDS.filter((field) => typeof user[field] === 'string' && user[field]);
}

/** For setup scripts. The value goes through Secret.parse like every other entry point, so the length rule applies. */
export function setSecret(
  project: string,
  label: string,
  field: SecretField,
  value: string,
  home = aegisHome(),
): { ok: true; label: string; field: SecretField } {
  setSecrets(project, { [label]: { [field]: Secret.require(field, value) } }, home);
  return { ok: true, label, field };
}

/** How long a writer waits for another writer of the same store. sops and the Keychain can take a few seconds. */
const STORE_LOCK_MS = 60_000;

/**
 * Sets several fields for several labels in one read and one write. The read and the write
 * happen under a lock, so two writers never lose each other's changes, and the new file
 * replaces the old one in a single rename, so a crash never leaves half a store.
 */
export function setSecrets(project: string, updates: Record<string, Partial<Record<SecretField, Secret>>>, home = aegisHome()): void {
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error('project id must be lowercase letters, numbers, and dashes');
  for (const [label, fields] of Object.entries(updates)) {
    if (!/^qa-user-\d+$/.test(label)) throw new Error('label must look like qa-user-1');
    for (const [field, value] of Object.entries(fields)) {
      if (!FIELDS.includes(field as SecretField)) throw new Error('unsupported field');
      // A plain string from untyped code (a script) would skip the length rule, so only a parsed Secret is stored.
      if (!(value instanceof Secret) || value.field !== field) throw new Error('A login field must be a Secret made by Secret.parse.');
    }
  }
  withFileLock(home, `secrets-${project}`, () => {
    const users = readUsers(home, project);
    for (const [label, fields] of Object.entries(updates)) {
      const revealed = Object.fromEntries(Object.entries(fields).map(([field, secret]) => [field, secret.reveal()]));
      users[label] = { ...(users[label] ?? {}), ...revealed };
    }
    writeUsers(home, project, users);
  }, STORE_LOCK_MS);
}

export async function injectTotp(project: string, label: string, endpoint: string, home = aegisHome()): Promise<InjectedHandle> {
  const secret = readUsers(home, project)[label]?.totp_secret;
  if (!secret) return { ok: true, handles: [] };
  // A strict site accepts only the current 30-second code. The journey types it a few steps later,
  // so a code made near the end of its window could expire first. Wait for a fresh one.
  const wait = waitForFreshCode();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const code = totpCode(secret);
  const response = await runnerFetch(
    project,
    endpoint,
    '/v1/secrets',
    { method: 'POST', body: JSON.stringify({ credentials: [{ handle: `${label}.totp_code`, value: code }] }) },
    home,
    label,
  );
  if (!response.ok) throw new Error('Runner rejected the login handoff.');
  return { ok: true, handles: [`${label}.totp_code`], code };
}

export async function injectSecrets(
  project: string,
  label: string,
  endpoint: string,
  home = aegisHome(),
): Promise<InjectedHandle> {
  const user = readUsers(home, project)[label];
  if (!user) throw new Error(`No stored login for ${label}.`);
  const credentials = FIELDS.flatMap((field) => {
    const value = user[field];
    return value ? [{ handle: `${label}.${field}`, value }] : [];
  });
  if (credentials.length === 0) throw new Error(`No stored login for ${label}.`);
  const response = await runnerFetch(project, endpoint, '/v1/secrets', { method: 'POST', body: JSON.stringify({ credentials }) }, home, label);
  if (!response.ok) throw new Error(`Runner rejected the login handoff (${response.status}).`);
  const body = (await response.json()) as { ok?: boolean; handles?: string[] };
  return { ok: true, handles: body.handles ?? credentials.map((entry) => entry.handle) };
}

function readUsers(home: string, project: string): Record<string, SecretUser> {
  const file = secretsPath(home, project);
  if (!existsSync(file)) return {};
  try {
    const parsed = parse(decrypt(file, home)) as SecretFile;
    return parsed.users ?? {};
  } catch {
    throw new Error('Could not read the encrypted store.');
  }
}

function writeUsers(home: string, project: string, users: Record<string, SecretUser>): void {
  const directory = privateDir(join(home, 'projects', project));
  const destination = join(directory, 'secrets.sops.yaml');
  const identity = ageIdentity(home);
  const plain = stringify({ users });
  const tempDir = privateTempDir('hornet-swarm-sops-');
  const tempFile = join(tempDir, 'plain.yaml');
  try {
    writePrivateFile(tempFile, plain);
    const encrypted = execFileSync(
      'sops',
      ['encrypt', '--age', identity.publicKey, '--input-type', 'yaml', '--output-type', 'yaml', tempFile],
      { encoding: 'utf8', env: childEnv(identity.secret) },
    );
    const leaked = Object.values(users).some((user) =>
      Object.values(user).some((value) => typeof value === 'string' && value.length >= 4 && encrypted.includes(value)),
    );
    if (encrypted.includes(plain) || leaked) throw new Error('encrypted store still contained a secret');
    writePrivateFile(destination, encrypted);
  } catch (error) {
    if (error instanceof Error && error.message === 'encrypted store still contained a secret') throw error;
    throw new Error('Could not encrypt the store.', { cause: error });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function decrypt(file: string, home: string): string {
  const identity = ageIdentity(home);
  return execFileSync('sops', ['decrypt', '--input-type', 'yaml', '--output-type', 'yaml', file], {
    encoding: 'utf8',
    env: childEnv(identity.secret),
  });
}

function secretsPath(home: string, project: string): string {
  return join(home, 'projects', project, 'secrets.sops.yaml');
}

function childEnv(secret: string): NodeJS.ProcessEnv {
  return { ...process.env, SOPS_AGE_KEY: secret };
}

function ageIdentity(home: string): { secret: string; publicKey: string } {
  const secret = loadAgeSecret();
  const publicKey = publicKeyFrom(secret);
  writePrivateFile(join(privateDir(home), 'age.pub'), `${publicKey}\n`);
  return { secret, publicKey };
}

let cachedAgeSecret: string | undefined;

/**
 * The key is read from the Keychain once per process and kept in memory until exit, so a
 * screen lock after the first read does not stop the next label. A new key is generated only
 * when both Keychain items are reported missing. A locked keychain, a timeout, or a damaged
 * item stops with an error and leaves the Keychain unchanged, so an existing store is never
 * orphaned by a replacement key.
 */
function loadAgeSecret(): string {
  if (process.platform !== 'darwin') {
    const fromEnv = process.env.SOPS_AGE_KEY;
    if (!fromEnv) throw new Error('SOPS_AGE_KEY is required when the Keychain is unavailable.');
    return fromEnv;
  }
  if (cachedAgeSecret) return cachedAgeSecret;
  const account = process.env.USER || userInfo().username;
  for (const service of [SERVICE, LEGACY_SERVICE]) {
    const found = readKeychainItem(service, account);
    if (found.kind === 'found') {
      cachedAgeSecret = found.secret;
      return found.secret;
    }
    if (found.kind === 'error') throw new Error(found.message);
  }
  const generated = execFileSync('age-keygen', { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const packed = Buffer.from(generated, 'utf8').toString('base64');
  execFileSync('security', ['-i'], {
    input: keychainAddCommand(SERVICE, account, packed),
    timeout: 15_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const fresh = generated.endsWith('\n') ? generated.slice(0, -1) : generated;
  // Interactive mode can exit 0 when its command failed. A key that was not saved would orphan every store it encrypts.
  const saved = readKeychainItem(SERVICE, account);
  if (saved.kind !== 'found' || saved.secret !== fresh) throw new Error(`Could not save the new age key in the Keychain item ${SERVICE}. Nothing was encrypted.`);
  cachedAgeSecret = fresh;
  return cachedAgeSecret;
}

/**
 * The `security -i` command that stores the key. It is written to the tool's stdin, so the key
 * never appears in a process's arguments, where `ps` would show it to every account on the Mac.
 * There is no `-A`: only the `security` tool itself may read the item without asking.
 */
export function keychainAddCommand(service: string, account: string, packed: string): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(packed)) throw new Error('The age key must be base64 before it is stored.');
  if (!/^[\w.-]+$/.test(service) || !/^[\w.@-]+$/.test(account)) throw new Error('The Keychain item name has characters the command cannot quote.');
  return `add-generic-password -s ${service} -a ${account} -w ${packed}\n`;
}

type KeychainRead = { kind: 'found'; secret: string } | { kind: 'missing' } | { kind: 'error'; message: string };

/** `security` exits 44 (errSecItemNotFound) when the item does not exist. Every other failure is an error. */
export function classifyKeychainFailure(status: number | null | undefined, stderr: string): 'missing' | 'error' {
  if (status === 44 || /could not be found in the keychain/i.test(stderr)) return 'missing';
  return 'error';
}

function readKeychainItem(service: string, account: string): KeychainRead {
  let stored: string;
  try {
    stored = execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failed = error as { status?: number | null; stderr?: unknown };
    if (classifyKeychainFailure(failed.status, String(failed.stderr ?? '')) === 'missing') return { kind: 'missing' };
    return { kind: 'error', message: `Could not read the Keychain item ${service}. Unlock the login keychain and try again. Nothing was changed.` };
  }
  try {
    return { kind: 'found', secret: unpackAgeSecret(stored) };
  } catch {
    return { kind: 'error', message: `The Keychain item ${service} is not an age key. It was left unchanged.` };
  }
}

function unpackAgeSecret(stored: string): string {
  const trimmed = stored.endsWith('\n') ? stored.slice(0, -1) : stored;
  const decoded = trimmed.includes('AGE-SECRET-KEY-') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
  if (!decoded.includes('AGE-SECRET-KEY-')) throw new Error('Keychain item was not an age key.');
  return decoded.endsWith('\n') ? decoded.slice(0, -1) : decoded;
}

function publicKeyFrom(secret: string): string {
  const comment = secret.split('\n').find((line) => line.startsWith('# public key:'));
  if (comment) return comment.slice(comment.indexOf(':') + 1).trim();
  throw new Error('age identity has no public key comment.');
}


