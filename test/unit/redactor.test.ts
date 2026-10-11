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
});
