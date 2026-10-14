import { describe, expect, it } from 'vitest';
import { htmlEscape, maskHeader, Redactor } from '../../packages/core/src/redactor.ts';

const password = 's3cret"<&value>';
const username = 'QA1@Example.TEST';

describe('redactor', () => {
  it('removes a secret and every derived form', () => {
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', password);
    redactor.register('qa-user-1.username', username);
    const samples = [
      password,
      encodeURIComponent(password),
      Buffer.from(password, 'utf8').toString('base64'),
      JSON.stringify(password).slice(1, -1),
      htmlEscape(password),
      username.toLowerCase(),
    ];
    for (const sample of samples) {
      expect(redactor.redact(`before ${sample} after`)).not.toContain(sample);
      expect(redactor.contains(sample)).toBe(true);
    }
    expect(redactor.redact(`user ${username.toLowerCase()}`)).toContain('[REDACTED:qa-user-1.username]');
    expect(redactor.redact(password)).toBe('[REDACTED:qa-user-1.password]');
  });

  it('removes a secret nested in a HAR file and a DOM snapshot', () => {
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', password);
    const once = JSON.stringify(password).slice(1, -1);
    const har = JSON.stringify({ post: `{"echo":"${once}"}` });
    const textNode = password.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const snapshot = JSON.stringify(`<div id="dom">${textNode}</div>`);
    expect(redactor.contains(har)).toBe(true);
    expect(redactor.contains(snapshot)).toBe(true);
    const cleanedHar = redactor.redact(har);
    const cleanedSnapshot = redactor.redact(snapshot);
    expect(cleanedHar).not.toContain('s3cret');
    expect(cleanedSnapshot).not.toContain('s3cret');
    expect(redactor.contains(cleanedHar)).toBe(false);
    expect(redactor.contains(cleanedSnapshot)).toBe(false);
  });

  it('masks credential headers and drops value fields from objects', () => {
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', password);
    expect(maskHeader('Authorization', `Bearer ${password}`, redactor)).toBe('[REDACTED:header]');
    expect(maskHeader('X-Trace', password, redactor)).toBe('[REDACTED:qa-user-1.password]');
    const cleaned = redactor.redactUnknown({
      password,
      nested: { cookie: 'session=abc', note: password },
      items: [password],
    }) as { password: string; nested: { cookie: string; note: string }; items: string[] };
    expect(JSON.stringify(cleaned)).not.toContain(password);
    expect(cleaned.password).toBe('[REDACTED:field]');
    expect(cleaned.nested.cookie).toBe('[REDACTED:header]');
  });

  it('redacts encoded forms of a secret that is at least 8 characters', () => {
    const secret = 'a"b<c>d&';
    expect(secret.length).toBe(8);
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', secret);
    const encoded = [
      encodeURIComponent(secret),
      Buffer.from(secret, 'utf8').toString('base64'),
      JSON.stringify(secret).slice(1, -1),
    ];
    for (const form of encoded) {
      expect(form.length).toBeGreaterThan(0);
      expect(redactor.redact(`before ${form} after`)).toBe('before [REDACTED:qa-user-1.password] after');
      expect(redactor.contains(form)).toBe(true);
    }
  });

  it('redacts a username shorter than 4 characters, including its encoded form', () => {
    const name = '"';
    const redactor = new Redactor();
    redactor.register('qa-user-1.username', name);
    const encoded = JSON.stringify(name).slice(1, -1);
    expect(encoded.length).toBeLessThan(4);
    expect(encoded).not.toBe(name);
    expect(redactor.redact(`user ${name} end`)).toBe('user [REDACTED:qa-user-1.username] end');
    expect(redactor.redact(encoded)).toBe('[REDACTED:qa-user-1.username]');
    expect(redactor.contains(Buffer.from(name, 'utf8').toString('base64'))).toBe(true);
    const passwordOnly = new Redactor();
    passwordOnly.register('qa-user-1.password', name);
    expect(passwordOnly.redact(name)).toBe('[REDACTED:qa-user-1.password]');
    expect(passwordOnly.redact(encoded)).toBe(`\\[REDACTED:qa-user-1.password]`);
  });

  it('keeps a short original secret and drops a short derived form', () => {
    const empty = new Redactor();
    empty.register('qa-user-1.password', '');
    expect(empty.redact('ab stays')).toBe('ab stays');
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', 'xyz');
    expect(redactor.redact('pin xyz end')).toBe('pin [REDACTED:qa-user-1.password] end');
    expect(redactor.contains('xyz')).toBe(true);
    const spaced = new Redactor();
    spaced.register('qa-user-1.password', ' ');
    expect(spaced.redact('a b')).toContain('[REDACTED:qa-user-1.password]');
    expect(spaced.contains(' ')).toBe(true);
    expect(spaced.contains('%20')).toBe(true);
    expect(spaced.redact('%20')).toBe('[REDACTED:qa-user-1.password]');
    const folded = new Redactor();
    folded.register('qa-user-1.password', password);
    expect(folded.redact(password.toLowerCase())).toBe('[REDACTED:qa-user-1.password]');
    const totp = new Redactor();
    totp.register('qa-user-1.totp_secret', 'JBSWY3DPEHPK3PXP');
    expect(totp.redact('jbswy3dpehpk3pxp')).toBe('[REDACTED:qa-user-1.totp_secret]');
  });

  it('masks a password query that a hash cut down to a prefix', () => {
    const secret = 'Abcdefghijklmnop#7a';
    const redactor = new Redactor();
    redactor.register('qa-user-5.password', secret);
    const truncated = 'https://bank.test/parabank/updateprofile.htm?firstName=Zoe&amp;password=Abcdefghijklmnop&amp;username=zoefd3ea3';
    expect(redactor.contains(truncated)).toBe(true);
    const cleaned = redactor.redact(truncated);
    expect(cleaned).toBe(
      'https://bank.test/parabank/updateprofile.htm?firstName=Zoe&amp;password=[REDACTED:qa-user-5.password]&amp;username=zoefd3ea3',
    );
    expect(cleaned).not.toContain('Abcdefghijklmnop');
    expect(cleaned).toContain('zoefd3ea3');
    expect(redactor.contains(cleaned)).toBe(false);

    const withHash = 'https://bank.test/update?password=Abcdefghijklmnop#7a&username=zoefd3ea3';
    expect(redactor.redact(withHash)).toBe('https://bank.test/update?password=[REDACTED:qa-user-5.password]&username=zoefd3ea3');
    expect(redactor.redact('https://bank.test/update?Password=Abcdefghijklmnop')).toBe(
      'https://bank.test/update?Password=[REDACTED:qa-user-5.password]',
    );
    expect(redactor.redact('note%26password=Abcdefghijklmnop')).toBe('note%26password=[REDACTED:qa-user-5.password]');

    const already = 'email=qa1%40example.test&amp;password=[REDACTED:qa-user-1.password]';
    expect(redactor.redact(already)).toBe(already);
    expect(redactor.contains(already)).toBe(false);
    expect(redactor.redact('https://bank.test/search?q=Abcdefghijklmnop')).toBe('https://bank.test/search?q=Abcdefghijklmnop');
    expect(redactor.redact('https://bank.test/login?password=short')).toBe('https://bank.test/login?password=short');
    expect(redactor.contains('https://bank.test/login?password=short')).toBe(false);

    const unknown = new Redactor();
    const wrong = 'https://bank.test/login?password=notasecretvalue';
    expect(unknown.contains(wrong)).toBe(true);
    expect(unknown.redact(wrong)).toBe('https://bank.test/login?password=[REDACTED:query]');
    expect(unknown.contains(unknown.redact(wrong))).toBe(false);
  });

  it('masks a session token, a password hash, and a challenge value that are not stored logins', () => {
    const redactor = new Redactor();
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '1', role: 'user' })).toString('base64url');
    const jwt = `${header}.${payload}.signaturevalue`;
    const profile = JSON.stringify({ email: 'kept@example.test', password: hash });
    const login = JSON.stringify({ access_token: jwt, token_type: 'bearer', expires_in: 3600 });
    const har = JSON.stringify({ text: profile });
    const challenge =
      'https://shop.test/cdn-cgi/challenge-platform/h/g/jsd/oneshot/build123/0.5:1700000000:MadeUpChallengeTokenValue/abcd';
    const script = 'https://shop.test/cdn-cgi/challenge-platform/h/g/scripts/jsd/build123/main.js';
    const cookie = 'cf_clearance=MadeUpClearanceValue99; __cf_bm=short';

    expect(redactor.contains(profile)).toBe(true);
    expect(redactor.contains(login)).toBe(true);
    expect(redactor.contains(har)).toBe(true);
    expect(redactor.contains(challenge)).toBe(true);
    expect(redactor.contains(cookie)).toBe(true);
    expect(redactor.contains(script)).toBe(false);
    expect(redactor.contains(JSON.stringify({ password: 'short' }))).toBe(false);

    const cleanedProfile = redactor.redact(profile);
    expect(cleanedProfile).toBe('{"email":"kept@example.test","password":"[REDACTED:field]"}');
    expect(cleanedProfile).not.toContain(hash);
    const cleanedLogin = redactor.redact(login);
    expect(cleanedLogin).toContain('[REDACTED:jwt]');
    expect(cleanedLogin).not.toContain(jwt);
    expect(cleanedLogin).toContain('"token_type":"bearer"');
    const cleanedHar = redactor.redact(har);
    expect(cleanedHar).not.toContain(hash);
    expect(cleanedHar).toContain('[REDACTED:field]');
    const cleanedChallenge = redactor.redact(challenge);
    expect(cleanedChallenge).toBe(
      'https://shop.test/cdn-cgi/challenge-platform/h/g/jsd/oneshot/build123/[REDACTED:challenge]/abcd',
    );
    expect(redactor.redact(script)).toBe(script);
    expect(redactor.redact(cookie)).toBe('cf_clearance=[REDACTED:challenge]; __cf_bm=short');
    expect(redactor.redact(JSON.stringify({ password: '[REDACTED:qa-user-1.password]' }))).toBe(
      '{"password":"[REDACTED:qa-user-1.password]"}',
    );

    for (const cleaned of [cleanedProfile, cleanedLogin, cleanedHar, cleanedChallenge, redactor.redact(cookie)]) {
      expect(redactor.contains(cleaned)).toBe(false);
    }
  });
});
