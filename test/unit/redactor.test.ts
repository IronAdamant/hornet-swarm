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

  it('ignores empty and very short values', () => {
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', '');
    redactor.register('qa-user-1.password', 'ab');
    expect(redactor.redact('ab stays')).toBe('ab stays');
    expect(redactor.contains('ab')).toBe(false);
  });
});
