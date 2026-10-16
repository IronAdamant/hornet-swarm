#!/usr/bin/env node
// Installs a public practice site as a Hornet Swarm project. Run `pnpm build` first.
//
//   node scripts/setup-practice.mjs the-internet
//   node scripts/setup-practice.mjs the-internet --no-statement   (skip saving the statement page)
//
// It copies the authorisation, the project, and its journeys into ~/.hornet-swarm, stores the
// login each site publishes on its own login page in the encrypted store, saves a dated copy of
// the page where the site says it is for practice, and fills the swarm board with a personality
// and rules for each label. It contacts the site only to read the published login and save that
// statement. Set HORNET_PRACTICE_PASSWORD to skip reading the password from the site.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse, stringify } from 'yaml';

const root = join(import.meta.dirname, '..');
const home = process.env.AEGIS_HOME ?? join(homedir(), '.hornet-swarm');

const SHARED_RULES = [
  'Use only the login stored for your label. Never ask for, type, or repeat a password.',
  'Stay on the allowed site. Do not try to break in, overload it, or get around a limit.',
  'Stop and report a captcha or a second-code page. Do not try to solve it.',
  'Never type a real name, address, email, phone number, or card number.',
  'Report what the evidence shows. Check the screenshot before calling something broken.',
].join(' ');

const SITES = {
  'the-internet': {
    project: 'the-internet',
    authorisation: 'the-internet-practice',
    // The login page says: Enter tomsmith for the username and <password> for the password.
    usernames: { 'qa-user-1': 'tomsmith', 'qa-user-2': 'tomsmith' },
    async publishedPassword() {
      const page = await fetchText('https://the-internet.herokuapp.com/login');
      return page.match(/and <em>([^<]+)<\/em> for the password/)?.[1];
    },
    agents: {
      'qa-user-1': {
        personality: 'A methodical tester who checks every message the site shows, word for word.',
        rules: `${SHARED_RULES} Keep the run gentle: this is a shared free host.`,
      },
      'qa-user-2': {
        personality: 'An impatient visitor who clicks as soon as something appears, to catch timing problems.',
        rules: `${SHARED_RULES} Keep the run gentle: this is a shared free host.`,
      },
    },
  },
};

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
}

function askHidden(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (text) => write(text.startsWith(question) ? text : '');
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// The password each site prints on its own login page. It is never written to this repo.
async function practicePassword(site) {
  if (process.env.HORNET_PRACTICE_PASSWORD) return process.env.HORNET_PRACTICE_PASSWORD;
  try {
    const password = await site.publishedPassword();
    if (password) return password;
    process.stdout.write('The login page no longer shows the password where this script expects it.\n');
  } catch (error) {
    process.stdout.write(`Could not read the login page (${error instanceof Error ? error.message : error}).\n`);
  }
  if (!process.stdin.isTTY) {
    process.stderr.write('Set HORNET_PRACTICE_PASSWORD to the password shown on the login page and run this again.\n');
    process.exit(5);
  }
  return askHidden('Password shown on the login page: ');
}

const name = process.argv[2];
const site = SITES[name];
if (!site) {
  process.stderr.write(`Usage: node scripts/setup-practice.mjs <${Object.keys(SITES).join('|')}>\n`);
  process.exit(3);
}

let setSecret;
let privateDir;
let writePrivateFile;
let copyPrivateFile;
try {
  ({ setSecret } = await import(join(root, 'packages/controller/dist/index.js')));
  ({ privateDir, writePrivateFile, copyPrivateFile } = await import(join(root, 'packages/core/dist/index.js')));
} catch {
  process.stderr.write('Build the workspace first: pnpm build\n');
  process.exit(4);
}

// Authorisation: today plus 90 days, with a dated copy of the statement page as the document.
const authorisation = parse(readFileSync(join(root, 'examples/authorisations', `${site.authorisation}.yaml`), 'utf8'));
const today = new Date();
const until = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
authorisation.valid_from = today.toISOString().slice(0, 10);
authorisation.valid_until = until.toISOString().slice(0, 10);
const docsDir = join(home, 'authorisations', 'docs');
privateDir(docsDir);
const saveStatement = !process.argv.includes('--no-statement');
if (saveStatement) {
  try {
    const response = await fetch(authorisation.public_statement.url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const file = join(docsDir, `${site.authorisation}-${authorisation.valid_from}.html`);
    writePrivateFile(file, body);
    authorisation.document = { path: file, sha256: createHash('sha256').update(body).digest('hex') };
    process.stdout.write(`Saved the practice statement: ${file}\n`);
  } catch (error) {
    process.stdout.write(`Could not save the practice statement (${error instanceof Error ? error.message : error}). The authorisation still records its address.\n`);
  }
}
writePrivateFile(join(privateDir(join(home, 'authorisations')), `${site.authorisation}.yaml`), stringify(authorisation));

// Project and journeys.
const projectDir = join(home, 'projects', site.project);
const journeysDir = join(projectDir, 'journeys');
privateDir(journeysDir);
const sourceDir = join(root, 'examples/projects', site.project);
copyPrivateFile(join(sourceDir, 'project.yaml'), join(projectDir, 'project.yaml'));
for (const file of readdirSync(join(sourceDir, 'journeys')).filter((entry) => entry.endsWith('.yaml'))) {
  copyPrivateFile(join(sourceDir, 'journeys', file), join(journeysDir, file));
}

// Logins go into the encrypted store, never into a project file. Each site publishes its own login.
const password = await practicePassword(site);
for (const [label, username] of Object.entries(site.usernames)) {
  setSecret(site.project, label, 'username', username, home);
  setSecret(site.project, label, 'password', password, home);
}
const count = Object.keys(site.usernames).length;

// The swarm board agents read with get_swarm. Existing notes are kept.
const project = parse(readFileSync(join(projectDir, 'project.yaml'), 'utf8'));
const board = {
  ready: true,
  project: site.project,
  website: project.targets.base_url,
  agents: Object.entries(site.agents).map(([label, agent]) => ({ label, ...agent })),
};
writePrivateFile(join(projectDir, 'swarm.json'), `${JSON.stringify(board, null, 2)}\n`);

process.stdout.write(
  [
    `Installed ${site.project} with ${count} login${count === 1 ? '' : 's'}.${existsSync(join(projectDir, 'notes')) ? ' Existing agent notes were kept.' : ''}`,
    '',
    'Next:',
    `  pnpm hornet-swarm env up --project ${site.project}`,
    `  pnpm hornet-swarm sign-in --project ${site.project}`,
    `  pnpm hornet-swarm suite --project ${site.project}`,
    `  pnpm hornet-swarm stats --project ${site.project}`,
    '',
  ].join('\n'),
);
