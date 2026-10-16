import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateDir, Redactor, writeRedactedFile } from '../../packages/core/src/index.ts';
import { folderAt, hasRevision, REPO_ROOT } from '../support/git-history.ts';

/**
 * Every shape of secret that reached a saved file in this repo's history, keyed by the commit
 * that fixed it. Each case must come out of Redactor.seal and the report sink without its leak,
 * and the proofs below show the redactor from before each fix let that leak through. The short
 * secrets that 3329d29 stopped admitting are covered by the Secret tests, not here.
 */
type LeakCase = { fixedIn: string; shape: string; secrets: Record<string, string>; text: string; leak: string };

const card = '4000000000000002';
const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const jwt = `${Buffer.from('{"typ":"JWT","alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"1","role":"user"}').toString('base64url')}.signaturevalue`;
const basic = Buffer.from('qa1@shop.test:Opal-Kestrel-19').toString('base64');

export const LEAK_CORPUS: LeakCase[] = [
  { fixedIn: 'd13f1e7', shape: 'password prefix left by a # in a saved URL', secrets: { 'qa-user-5.password': 'Abcdefghijklmnop#7a' }, text: 'https://bank.test/update?password=Abcdefghijklmnop&amp;username=zoe', leak: 'Abcdefghijklmnop' },
  { fixedIn: 'd13f1e7', shape: 'password query for an unregistered value', secrets: {}, text: 'https://bank.test/login?password=notasecretvalue', leak: 'notasecretvalue' },
  { fixedIn: '5d6f36a', shape: 'password hash in a profile body', secrets: {}, text: JSON.stringify({ email: 'kept@example.test', password: hash }), leak: hash },
  { fixedIn: '5d6f36a', shape: 'JWT access token', secrets: {}, text: JSON.stringify({ access_token: jwt, token_type: 'bearer' }), leak: jwt },
  { fixedIn: '5d6f36a', shape: 'challenge URL segment', secrets: {}, text: 'https://shop.test/cdn-cgi/challenge-platform/h/g/jsd/oneshot/build123/0.5:1700000000:MadeUpChallengeTokenValue/abcd', leak: 'MadeUpChallengeTokenValue' },
  { fixedIn: '5d6f36a', shape: 'challenge clearance cookie', secrets: {}, text: 'cf_clearance=MadeUpClearanceValue99; __cf_bm=short', leak: 'MadeUpClearanceValue99' },
  { fixedIn: 'cf684c1', shape: 'bare card number in a checkout body', secrets: {}, text: `{"fullName":"Nia Peel","cardNum":${card},"expYear":"2080"}`, leak: card },
  { fixedIn: 'cf684c1', shape: 'card number in page text', secrets: {}, text: `- Card Number: ${card}`, leak: card },
  { fixedIn: '5723644', shape: 'card number typed by Playwright fill in a trace', secrets: {}, text: `{"message":"  fill(\\"${card}\\")"}`, leak: card },
  { fixedIn: '5723644', shape: 'card number in a Playwright value record', secrets: {}, text: `{"__playwright_value_":"${card}","type":"number"}`, leak: card },
  { fixedIn: '6184a74', shape: 'form-encoded password with ! and a space', secrets: { 'qa-user-2.password': 'Hunter two!x' }, text: 'user=qa2&password=Hunter+two%21x', leak: 'Hunter+two%21x' },
  { fixedIn: 'bed382d', shape: 'password inside Basic auth base64', secrets: { 'qa-user-1.password': 'Opal-Kestrel-19' }, text: `{"name":"Authorization-Echo","value":"Basic ${basic}"}`, leak: basic },
];

function redactorFor(make: () => Redactor, secrets: Record<string, string>): Redactor {
  const redactor = make();
  for (const [label, value] of Object.entries(secrets)) redactor.register(label, value);
  return redactor;
}

describe('the leak corpus', () => {
  it.each(LEAK_CORPUS)('$fixedIn: $shape is sealed before it reaches a saved file', ({ secrets, text, leak }) => {
    const redactor = redactorFor(() => new Redactor(), secrets);
    expect(redactor.contains(text)).toBe(true);
    const sealed = redactor.seal(text);
    expect(sealed).not.toContain(leak);
    const file = join(privateDir(mkdtempSync(join(tmpdir(), 'hornet-leak-'))), 'saved.txt');
    writeRedactedFile(file, sealed);
    expect(readFileSync(file, 'utf8')).not.toContain(leak);
  });

  const commits = [...new Set(LEAK_CORPUS.map((leak) => leak.fixedIn))];
  it.each(commits.filter((commit) => hasRevision(commit)))('proof: the redactor before %s leaked its corpus cases', async (commit) => {
    const past = folderAt(`${commit}^`, 'packages/core/src', join(REPO_ROOT, 'packages/core'));
    try {
      const { Redactor: PastRedactor } = (await import(join(past.path, 'redactor.ts'))) as { Redactor: new () => Redactor };
      for (const leak of LEAK_CORPUS.filter((entry) => entry.fixedIn === commit)) {
        const redactor = redactorFor(() => new PastRedactor(), leak.secrets);
        expect(redactor.redact(leak.text), `${commit}: ${leak.shape}`).toContain(leak.leak);
      }
    } finally {
      past.cleanup();
    }
  });
});
