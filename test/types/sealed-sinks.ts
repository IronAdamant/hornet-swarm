// Compile-time proofs, checked by `pnpm typecheck` against the built packages. Every expected
// error below fails the typecheck if the line it guards ever compiles.
import { appendRedactedFile, fixedText, Redactor, Secret, writeRedactedFile, type Redacted } from '../../packages/core/dist/index.js';
import { setSecrets } from '../../packages/controller/dist/index.js';

declare const pageText: string;
declare const bytes: Buffer;
const redactor = new Redactor();

writeRedactedFile('/tmp/summary.md', redactor.seal(pageText));
writeRedactedFile('/tmp/trace.zip', redactor.sealBytes(bytes));
appendRedactedFile('/tmp/audit.log', redactor.seal(pageText));
writeRedactedFile('/tmp/marker', fixedText('quarantined\n'));

// @ts-expect-error Text read from a page is not Redacted until a Redactor seals it.
writeRedactedFile('/tmp/summary.md', pageText);
// @ts-expect-error Raw bytes are not RedactedBytes until a Redactor seals them.
writeRedactedFile('/tmp/trace.zip', bytes);
// @ts-expect-error The audit log takes sealed text only.
appendRedactedFile('/tmp/audit.log', `${pageText}\n`);
// @ts-expect-error fixedText takes a literal, so a value cannot be laundered through it.
fixedText(pageText);
// @ts-expect-error A template with a value in it is a string, not a literal.
fixedText(`${pageText}\n`);
// @ts-expect-error Concatenating sealed text with raw text gives a plain string.
writeRedactedFile('/tmp/summary.md', redactor.seal('a') + pageText);
export const stillSealed: Redacted = redactor.seal(pageText);

// @ts-expect-error A Secret has one constructor, Secret.parse, which carries the length rule.
new Secret('password');
// @ts-expect-error The store takes Secrets, so a raw string cannot skip the length rule.
setSecrets('shop', { 'qa-user-1': { password: 'abc' } });
const parsed = Secret.parse('password', pageText);
if (parsed.ok) setSecrets('shop', { 'qa-user-1': { password: parsed.secret } });
