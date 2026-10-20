import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const CODE = /\b(\d{4,8})\b/;

/**
 * The newest message in one mailbox under the test inbox. The mailbox name is a single path
 * segment, so the step cannot read a file outside that inbox.
 */
export function readInboxCode(root: string, mailbox: string): string {
  if (!root) throw new Error('no test inbox is configured');
  if (!/^[a-z0-9-]+$/.test(mailbox)) throw new Error('inbox mailbox name is not allowed');
  const base = resolve(root);
  const dir = resolve(base, mailbox);
  if (dir !== base && !dir.startsWith(`${base}${sep}`)) throw new Error('inbox mailbox is outside the test inbox');
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.txt')).sort();
  } catch {
    throw new Error('the test inbox has no message');
  }
  const latest = names.at(-1);
  if (!latest) throw new Error('the test inbox has no message');
  const text = readFileSync(join(dir, latest), 'utf8');
  const code = CODE.exec(text)?.[1];
  if (!code) throw new Error('the test inbox message has no code');
  return code;
}
