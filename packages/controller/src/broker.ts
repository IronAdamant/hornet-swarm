import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { Redactor } from '@hornet-swarm/core';
import { aegisHome, ensureDir } from './home.js';
import { runnerFetch } from './runner-auth.js';
import { totpCode } from './totp.js';

const SERVICE = 'hornet-swarm-age-key';
const LEGACY_SERVICE = 'aegis-age-key';
const FIELDS = ['username', 'password', 'totp_secret'] as const;
export type SecretField = (typeof FIELDS)[number];

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

export function listFields(project: string, label: string, home = aegisHome()): SecretField[] {
  const user = readUsers(home, project)[label] ?? {};
  return FIELDS.filter((field) => typeof user[field] === 'string' && user[field]);
}

export function setSecret(
  project: string,
  label: string,
  field: SecretField,
  value: string,
  home = aegisHome(),
): { ok: true; label: string; field: SecretField } {
  if (!/^qa-user-\d+$/.test(label)) throw new Error('label must look like qa-user-1');
  if (!FIELDS.includes(field)) throw new Error('unsupported field');
  if (!value) throw new Error('empty secret');
  const users = readUsers(home, project);
  const current = users[label] ?? {};
  users[label] = { ...current, [field]: value };
  writeUsers(home, project, users);
  return { ok: true, label, field };
}

export async function injectTotp(project: string, label: string, endpoint: string, home = aegisHome()): Promise<InjectedHandle> {
  const secret = readUsers(home, project)[label]?.totp_secret;
  if (!secret) return { ok: true, handles: [] };
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
  credentials.forEach((entry) => {
    entry.value = '';
  });
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
  const directory = ensureDir(join(home, 'projects', project));
  const destination = join(directory, 'secrets.sops.yaml');
  const identity = ageIdentity(home);
  const plain = stringify({ users });
  const tempDir = mkdtempSync(join(tmpdir(), 'hornet-swarm-sops-'));
  const tempFile = join(tempDir, 'plain.yaml');
  try {
    writeFileSync(tempFile, plain, { mode: 0o600 });
    chmodSync(tempFile, 0o600);
    const encrypted = execFileSync(
      'sops',
      ['encrypt', '--age', identity.publicKey, '--input-type', 'yaml', '--output-type', 'yaml', tempFile],
      { encoding: 'utf8', env: childEnv(identity.secret) },
    );
    const leaked = Object.values(users).some((user) =>
      Object.values(user).some((value) => typeof value === 'string' && value.length >= 4 && encrypted.includes(value)),
    );
    if (encrypted.includes(plain) || leaked) throw new Error('encrypted store still contained a secret');
    writeFileSync(destination, encrypted, { mode: 0o600 });
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
  ensureDir(home);
  writeFileSync(join(home, 'age.pub'), `${publicKey}\n`, { mode: 0o644 });
  return { secret, publicKey };
}

function loadAgeSecret(): string {
  if (process.platform !== 'darwin') {
    const fromEnv = process.env.SOPS_AGE_KEY;
    if (!fromEnv) throw new Error('SOPS_AGE_KEY is required when the Keychain is unavailable.');
    return fromEnv;
  }
  const account = process.env.USER || userInfo().username;
  for (const service of [SERVICE, LEGACY_SERVICE]) {
    try {
      return unpackAgeSecret(
        execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
          encoding: 'utf8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (service === LEGACY_SERVICE) break;
      if (/item.*not be found|could not be found|SecKeychainSearch/i.test(message)) continue;
      if (!(message.includes('not an age key') || message.includes('could not be found') || message.includes('The specified item'))) {
        if (message.includes('AGE-SECRET-KEY-')) throw new Error('Could not read the age key.', { cause: error });
      }
    }
  }
  const generated = execFileSync('age-keygen', { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const packed = Buffer.from(generated, 'utf8').toString('base64');
  execFileSync('security', ['add-generic-password', '-U', '-A', '-s', SERVICE, '-a', account, '-w', packed], {
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return generated.endsWith('\n') ? generated.slice(0, -1) : generated;
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


