import { ESLint, RuleTester } from 'eslint';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import hornetSwarm from '../../eslint-rules/hornet-swarm-rules.js';
import { fileAt, hasRevision, REPO_ROOT } from '../support/git-history.ts';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' } });
const rules = hornetSwarm.rules;

tester.run('secure-fs-only', rules['secure-fs-only'], {
  valid: [
    "import { existsSync, readFileSync, rmSync, renameSync } from 'node:fs';",
    "import { privateDir, writePrivateFile } from '@hornet-swarm/core';",
  ],
  invalid: [
    { code: "import { mkdirSync } from 'node:fs';", errors: [{ messageId: 'creator' }] },
    { code: "import { writeFile } from 'node:fs/promises';", errors: [{ messageId: 'creator' }] },
    { code: "import * as fs from 'fs'; fs.chmodSync('/x', 0o777);", errors: [{ messageId: 'creator' }] },
    { code: "import fs from 'node:fs'; fs['writeFileSync']('/x', 'y');", errors: [{ messageId: 'creator' }] },
    { code: 'process.umask(0);', errors: [{ messageId: 'umask' }] },
  ],
});

tester.run('sealed-artifacts-only', rules['sealed-artifacts-only'], {
  valid: [
    'writeRedactedFile(path, redactor.seal(text));',
    { code: "import { writeRedactedFile } from '@hornet-swarm/core';", options: [{ forbidUnsealedWriters: true }] },
    "import { writePrivateFile } from '@hornet-swarm/core';",
  ],
  invalid: [
    { code: 'writeRedactedFile(path, text as Redacted);', errors: [{ messageId: 'cast' }] },
    { code: 'writeRedactedFile(path, bytes as unknown as RedactedBytes);', errors: [{ messageId: 'cast' }] },
    { code: "import { writePrivateFile } from '@hornet-swarm/core';", options: [{ forbidUnsealedWriters: true }], errors: [{ messageId: 'writer' }] },
  ],
});

tester.run('no-live-hosts-in-tests', rules['no-live-hosts-in-tests'], {
  valid: [
    "await fetch('http://127.0.0.1:4173/login');",
    'await page.goto(`http://host.docker.internal:${port}/`);',
    "await fetch('https://shop.test/cart');",
    "expect(hostAllowed('www.google.com', policy)).toBe(false);",
    "const blocked = ['https://www.google.com/'];",
  ],
  invalid: [
    { code: "await fetch('https://www.saucedemo.com/');", errors: [{ messageId: 'live' }] },
    { code: "await page.goto('https://the-internet.herokuapp.com/login');", errors: [{ messageId: 'live' }] },
    { code: "const site = 'https://example.com'; await fetch(site + '/x');", errors: [{ messageId: 'live' }] },
    { code: "await request({ url: 'https://api.github.com/' });", errors: [{ messageId: 'live' }] },
    { code: "connect({ host: 'smtp.gmail.com', port: 25 });", errors: [{ messageId: 'live' }] },
    { code: "execSync('hornet-swarm inspect --url https://www.saucedemo.com');", errors: [{ messageId: 'live' }] },
    { code: "new WebSocket('wss://stream.binance.com/ws');", errors: [{ messageId: 'live' }] },
  ],
});

/** Lints `source` as if it were `path` in this repo, under the repo's own config. */
async function lintAs(path: string, source: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const [result] = await eslint.lintText(source, { filePath: join(REPO_ROOT, path) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? '');
}

const PAST_PERMISSION_BUGS = [
  { commit: 'd0043ee', path: 'packages/controller/src/env.ts', bug: 'runner output folder chmod 0777' },
  { commit: '294967a', path: 'packages/controller/src/runner-auth.ts', bug: 'control token written 0644 in a 0755 folder' },
  { commit: 'f05f31f', path: 'packages/runner/src/main.ts', bug: 'control socket chmod 0777 after listen' },
  { commit: 'bdb438b', path: 'packages/controller/src/env.ts', bug: 'token folder made, then tightened' },
];

describe('each lint rule fails on the real bug it is meant to stop', () => {
  it.each(PAST_PERMISSION_BUGS.filter(({ commit }) => hasRevision(commit)))('secure-fs-only rejects $commit^ $path ($bug)', async ({ commit, path }) => {
    const ruleIds = await lintAs(path, fileAt(`${commit}^`, path));
    expect(ruleIds).toContain('hornet-swarm/secure-fs-only');
  });

  it.each(PAST_PERMISSION_BUGS)('the same file today passes: $path', async ({ path }) => {
    const ruleIds = await lintAs(path, readFileSync(join(REPO_ROOT, path), 'utf8'));
    expect(ruleIds.filter((id) => id.startsWith('hornet-swarm/'))).toEqual([]);
  });

  it.skipIf(!hasRevision('5723644'))('sealed-artifacts-only rejects the runner job writer from before this change, which saved redact() output unchecked', async () => {
    const path = 'packages/runner/src/job.ts';
    const ruleIds = await lintAs(path, fileAt('5723644', path));
    expect(ruleIds).toContain('hornet-swarm/secure-fs-only');
    const patched = fileAt('5723644', path).replace("import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';", "import { existsSync, readFileSync } from 'node:fs';\nimport { writePrivateFile as writeFileSync, privateDir } from '@hornet-swarm/core';");
    expect(await lintAs(path, patched)).toContain('hornet-swarm/sealed-artifacts-only');
  });
});
