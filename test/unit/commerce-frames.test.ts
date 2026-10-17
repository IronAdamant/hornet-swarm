import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stepSchema } from '../../packages/core/src/index.ts';
import { readInboxCode } from '../../packages/runner/src/inbox.ts';
import { executeJob, type JobRequest } from '../../packages/runner/src/job.ts';
import { createFixture } from '../fixture-app/server.js';

const TEST_CARD = '4242424242424242';

describe('a test inbox', () => {
  it('returns the code from the newest message and refuses a mailbox outside the inbox', () => {
    const root = mkdtempSync(join(tmpdir(), 'hornet-inbox-'));
    mkdirSync(join(root, 'customer'));
    writeFileSync(join(root, 'customer', 'a.txt'), 'older 111111\n');
    writeFileSync(join(root, 'customer', 'b.txt'), 'Your code is 654321\n');
    expect(readInboxCode(root, 'customer')).toBe('654321');
    expect(() => readInboxCode(root, '../secrets')).toThrow(/not allowed/);
    expect(() => readInboxCode('', 'customer')).toThrow(/no test inbox/);
  });
});

describe('card frames, a storefront password, and an emailed code', () => {
  let server: Server;
  let port = 0;
  const storePassword = `pw-${Math.random().toString(36).slice(2)}`;
  const emailCode = String(100000 + Math.floor(Math.random() * 900000));
  const inbox = mkdtempSync(join(tmpdir(), 'hornet-mail-'));

  beforeAll(async () => {
    process.env.AEGIS_HEADLESS = '1';
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(chrome)) process.env.AEGIS_BROWSER = chrome;
    mkdirSync(join(inbox, 'customer'));
    writeFileSync(join(inbox, 'customer', 'code.txt'), `Your code is ${emailCode}\n`);
    const app = createFixture();
    server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    await fetch(`http://127.0.0.1:${port}/__admin/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ users: [], storePassword, emailCode }),
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.AEGIS_HEADLESS;
  });

  const job = (steps: JobRequest['steps'], name: string): JobRequest => ({
    runId: 'run_commerce',
    label: 'qa-user-1',
    journeyId: name,
    baseUrl: `http://127.0.0.1:${port}`,
    steps,
    allowOrigins: [`http://127.0.0.1:${port}`],
    authEndpoints: [],
    minStepDelayMs: 0,
    rps: 50,
    burst: 50,
    accessDeniedMarkers: [],
    chaosActions: [],
    outDir: join(mkdtempSync(join(tmpdir(), 'hornet-commerce-')), name),
    vars: {},
    users: {},
    inboxDir: inbox,
  });

  const secrets = () =>
    new Map<string, string>([
      ['qa-user-1.password', storePassword],
      ['qa-user-1.card', TEST_CARD],
    ]);

  it('accepts the new steps', () => {
    expect(stepSchema.safeParse({ fill: { selector: '[name=cardnumber]', frame: 'iframe[title="card payment"]', credential: 'self.card' } }).success).toBe(true);
    expect(stepSchema.safeParse({ storefront_password: { credential: 'self.password' } }).success).toBe(true);
    expect(stepSchema.safeParse({ inbox: { mailbox: 'customer', selector: 'input[name=code]' } }).success).toBe(true);
  });

  it('fills a card field inside a payment frame and refuses a captcha frame', async () => {
    const paid = await executeJob(
      job(
        [
          { navigate: { url: '/pay' } },
          { fill: { selector: '[name=cardnumber]', frame: 'iframe[title="card payment"]', credential: 'self.card' } },
          { fill: { selector: '[name=exp]', frame: 'iframe[title="card payment"]', value: '12 / 34' } },
          { fill: { selector: '[name=cvc]', frame: 'iframe[title="card payment"]', value: '123' } },
          { click: { selector: '#pay-now' } },
          { assert: { type: 'text_visible', value: 'card accepted' } },
        ],
        'pay',
      ),
      secrets(),
      () => false,
    );
    expect(paid.status, JSON.stringify(paid.steps.map((step) => step.error))).toBe('passed');
    const captcha = await executeJob(
      job([{ navigate: { url: '/pay' } }, { fill: { selector: '[name=cardnumber]', frame: 'iframe[title="recaptcha"]', value: '1' } }], 'captcha'),
      secrets(),
      () => false,
    );
    expect(captcha.status).toBe('failed');
    expect(captcha.steps.at(-1)?.error).toContain('does not fill a captcha frame');
  });

  it('opens a storefront password page with the test password', async () => {
    const report = await executeJob(
      job(
        [
          { navigate: { url: '/store-password' } },
          { storefront_password: { credential: 'self.password' } },
          { assert: { type: 'text_visible', value: 'store open' } },
        ],
        'gate',
      ),
      secrets(),
      () => false,
    );
    expect(report.status, JSON.stringify(report.steps.map((step) => step.error))).toBe('passed');
  });

  it('types an emailed code from the test inbox, and stops when the journey has no inbox step', async () => {
    const signedIn = await executeJob(
      job(
        [
          { navigate: { url: '/emailed-code' } },
          { inbox: { mailbox: 'customer', selector: 'input[name=code]' } },
          { click: { selector: 'button[type=submit]' } },
          { assert: { type: 'text_visible', value: 'signed in' } },
        ],
        'code',
      ),
      secrets(),
      () => false,
    );
    expect(signedIn.status, JSON.stringify(signedIn.steps.map((step) => step.error))).toBe('passed');
    const stopped = await executeJob(job([{ navigate: { url: '/emailed-code' } }, { assert: { type: 'text_visible', value: 'signed in' } }], 'no-inbox'), secrets(), () => false);
    expect(stopped.status).toBe('blocked');
    expect(stopped.blocked_reason).toBe('2fa');
  });
});
