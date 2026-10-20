import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readInboxCode } from '../../packages/runner/src/inbox.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CLIENT_SENTENCE =
  'If a journey does not use an inbox step, ask the client to pre-verify the test accounts and to turn captcha off on staging. The harness does not solve a captcha, and it does not read a verification email unless the journey has an inbox step that names a test inbox.';

describe('test inbox instructions', () => {
  it('tells clients to pre-verify accounts and turn captcha off on staging when a journey has no inbox step', () => {
    for (const file of ['docs/client-engagement.md', 'docs/reference.md']) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text).toMatch(/pre-verify/i);
      expect(text).toMatch(/turn captcha off on staging/i);
      expect(text).toContain(CLIENT_SENTENCE);
    }
  });

  it('returns a verification code from the newest message in the local test inbox', () => {
    const inbox = mkdtempSync(join(tmpdir(), 'hornet-inbox-docs-'));
    mkdirSync(join(inbox, 'signup'));
    writeFileSync(join(inbox, 'signup', 'a-older.txt'), 'Your code is 111111\n');
    writeFileSync(join(inbox, 'signup', 'b-newer.txt'), 'Your verification code is 482913\n');
    expect(readInboxCode(inbox, 'signup')).toBe('482913');
  });
});
