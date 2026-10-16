import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { listFields, setSecret, setSecrets } from '../../packages/controller/src/broker.ts';
import { parseLogin, Redactor, Secret, SHORT_SECRET_ERROR, shortSecretError, valueForField } from '../../packages/core/src/index.ts';
import { folderAt, hasRevision, REPO_ROOT } from '../support/git-history.ts';

const BEFORE_THIS_CHANGE = '5723644';

describe('the Secret type', () => {
  it('is the one place the length rule lives: passwords and TOTP secrets need 8, usernames need 1', () => {
    expect(Secret.parse('password', 'short').ok).toBe(false);
    expect(Secret.parse('totp_secret', 'JBSWY3D').ok).toBe(false);
    expect(Secret.parse('password', 'eightchr').ok).toBe(true);
    expect(Secret.parse('username', 'bob').ok).toBe(true);
    expect(Secret.parse('username', '').ok).toBe(false);
    expect(Secret.parse('password', 'short')).toEqual({ ok: false, error: SHORT_SECRET_ERROR });
    expect(shortSecretError(undefined, '', 'short')).toBe(SHORT_SECRET_ERROR);
    expect(parseLogin({ username: 'bob', password: 'short' })).toEqual({ ok: false, error: SHORT_SECRET_ERROR });
    const login = parseLogin({ username: 'bob', password: 'long-enough' });
    expect(login.ok && login.secrets.username?.reveal()).toBe('bob');
  });

  it('never prints its value through JSON, string conversion, or console output', () => {
    const secret = Secret.require('password', 'correct-horse-battery');
    const report = JSON.stringify({ login: secret, note: `${secret}` });
    expect(report).toBe('{"login":"[REDACTED:password]","note":"[REDACTED:password]"}');
    expect(inspect({ secret })).not.toContain('correct-horse');
    const redactor = new Redactor();
    redactor.registerSecret('qa-user-1.password', secret);
    expect(redactor.redact('typed correct-horse-battery')).toBe('typed [REDACTED:qa-user-1.password]');
  });

  it('closes the store bypass: setSecret and setSecrets refuse a short password the request page already refused', () => {
    const home = mkdtempSync(join(tmpdir(), 'hornet-secret-type-'));
    expect(() => setSecret('shop', 'qa-user-1', 'password', 'abc', home)).toThrow(SHORT_SECRET_ERROR);
    expect(() => setSecrets('shop', { 'qa-user-1': { password: 'abc' as unknown as Secret } }, home)).toThrow(/Secret made by Secret.parse/);
    const forged = Object.create(Secret.prototype) as Secret;
    expect(() => setSecrets('shop', { 'qa-user-1': { password: forged } }, home)).toThrow(/Secret made by Secret.parse/);
    const username = Secret.require('username', 'abc');
    Object.defineProperty(username, 'field', { value: 'password' });
    username.reveal = () => 'long-enough-password';
    expect(() => valueForField(username, 'password')).toThrow(/Secret made by Secret.parse/);
    const password = Secret.require('password', 'long-enough');
    password.reveal = () => 'abc';
    expect(valueForField(password, 'password')).toBe('long-enough');
    expect(listFields('shop', 'qa-user-1', home)).toEqual([]);
  });

  it.skipIf(!hasRevision('539d310'))('proof: the length rule before 539d310 refused a short username, which Secret accepts', async () => {
    const past = folderAt('539d310^', 'packages/core/src', join(REPO_ROOT, 'packages/core'));
    try {
      const old = (await import(join(past.path, 'secret-length.ts'))) as { shortSecretError: (...values: string[]) => string | undefined };
      expect(old.shortSecretError('bob')).toBe(SHORT_SECRET_ERROR);
      expect(Secret.parse('username', 'bob').ok).toBe(true);
    } finally {
      past.cleanup();
    }
  });

  it.skipIf(!hasRevision(BEFORE_THIS_CHANGE))('proof: the store before this change saved a 3-character password that Secret refuses', async () => {
    const past = folderAt(BEFORE_THIS_CHANGE, 'packages/controller/src', join(REPO_ROOT, 'packages/controller'));
    const home = mkdtempSync(join(tmpdir(), 'hornet-secret-past-'));
    try {
      const old = (await import(join(past.path, 'broker.ts'))) as {
        setSecret: (project: string, label: string, field: string, value: string, home: string) => unknown;
        listFields: (project: string, label: string, home: string) => string[];
      };
      old.setSecret('shop', 'qa-user-1', 'password', 'abc', home);
      expect(old.listFields('shop', 'qa-user-1', home)).toEqual(['password']);
      expect(() => setSecret('shop', 'qa-user-1', 'password', 'abc', home)).toThrow(SHORT_SECRET_ERROR);
    } finally {
      past.cleanup();
    }
  }, 30_000);
});
