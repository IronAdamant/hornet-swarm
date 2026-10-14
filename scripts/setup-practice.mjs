#!/usr/bin/env node
// Installs a public practice site as a Hornet Swarm project. Run `pnpm build` first.
//
//   node scripts/setup-practice.mjs the-internet
//   node scripts/setup-practice.mjs saucedemo
//   node scripts/setup-practice.mjs toolshop-live    (the hosted Toolshop, signs up made-up customers)
//   node scripts/setup-practice.mjs saucedemo --no-statement   (skip saving the statement page)
//
// It copies the authorisation, the project, and its journeys into ~/.hornet-swarm, stores the
// login each site publishes on its own login page in the encrypted store, saves a dated copy of
// the page where the site says it is for practice, and fills the swarm board with a personality
// and rules for each label. It contacts the site only to read the published login and save that
// statement. Set HORNET_PRACTICE_PASSWORD to skip reading the password from the site.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse, stringify } from 'yaml';
import { strongPassword } from './lab-passwords.mjs';

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
  saucedemo: {
    project: 'saucedemo',
    authorisation: 'saucedemo-practice',
    // The login page lists "Accepted usernames are:" and "Password for all users:". The page is
    // rendered by script, so the password is read from the list in its bundle.
    usernames: {
      'qa-user-1': 'standard_user',
      'qa-user-2': 'problem_user',
      'qa-user-3': 'performance_glitch_user',
      'qa-user-4': 'error_user',
      'qa-user-5': 'visual_user',
      'qa-user-6': 'locked_out_user',
    },
    async publishedPassword() {
      const page = await fetchText('https://www.saucedemo.com/');
      const bundle = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
      if (!bundle) return undefined;
      return (await fetchText(`https://www.saucedemo.com${bundle}`)).match(/\[`standard_user`[^\]]*\],\w+=`([^`]+)`/)?.[1];
    },
    agents: {
      'qa-user-1': {
        personality: 'A careful first-time shopper. This is the account that should work, so it is the control for the others.',
        rules: SHARED_RULES,
      },
      'qa-user-2': {
        personality: 'A shopper who notices when pictures or form fields look wrong.',
        rules: `${SHARED_RULES} This account is built with broken images and a broken checkout form. Say exactly which step breaks.`,
      },
      'qa-user-3': {
        personality: 'A shopper on a slow connection who waits patiently.',
        rules: `${SHARED_RULES} This account is built to be slow. Report timings. Slowness alone is not a broken page.`,
      },
      'qa-user-4': {
        personality: 'A shopper who presses every button once and expects it to work.',
        rules: `${SHARED_RULES} This account is built so some actions fail. Name the action and what the page did.`,
      },
      'qa-user-5': {
        personality: 'A shopper with a sharp eye for layout and alignment.',
        rules: `${SHARED_RULES} This account is built with visual differences. Compare screenshots with qa-user-1.`,
      },
      'qa-user-6': {
        personality: 'A returning customer whose account has been locked.',
        rules: `${SHARED_RULES} This account is built to be refused at sign-in. A refused sign-in is the expected result.`,
      },
    },
  },
  // The hosted Toolshop, sprint 5 with deliberate bugs: the same app as the local toolshop-lab, on
  // the public internet. Other testers share it, so it gets its own made-up customers instead of
  // the published accounts anyone can change, and the gentlest limits.
  'toolshop-live': {
    project: 'toolshop-live',
    authorisation: 'toolshop-live-practice',
    signUp: {
      api: 'https://api-with-bugs.practicesoftwaretesting.com',
      people: {
        'qa-user-1': { first_name: 'Mara', last_name: 'Quill' },
        'qa-user-2': { first_name: 'Tobin', last_name: 'Reyes' },
        'qa-user-3': { first_name: 'Iris', last_name: 'Calloway' },
      },
    },
    agents: {
      'qa-user-1': {
        personality: 'A careful first-time shopper on a real connection. The control account.',
        rules: `${SHARED_RULES} This is a live site other testers share. Place at most one order per run.`,
      },
      'qa-user-2': {
        personality: 'A bargain hunter who searches before buying anything.',
        rules: `${SHARED_RULES} This is a live site other testers share. Do not create accounts beyond your own.`,
      },
      'qa-user-3': {
        personality: 'A shopper who tries cash on delivery and keeps a favourites list.',
        rules: `${SHARED_RULES} This is a live site other testers share. Change only your own favourites.`,
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
try {
  ({ setSecret } = await import(join(root, 'packages/controller/dist/index.js')));
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
mkdirSync(docsDir, { recursive: true, mode: 0o700 });
const saveStatement = !process.argv.includes('--no-statement');
if (saveStatement) {
  try {
    const response = await fetch(authorisation.public_statement.url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const file = join(docsDir, `${site.authorisation}-${authorisation.valid_from}.html`);
    writeFileSync(file, body, { mode: 0o600 });
    authorisation.document = { path: file, sha256: createHash('sha256').update(body).digest('hex') };
    process.stdout.write(`Saved the practice statement: ${file}\n`);
  } catch (error) {
    process.stdout.write(`Could not save the practice statement (${error instanceof Error ? error.message : error}). The authorisation still records its address.\n`);
  }
}
mkdirSync(join(home, 'authorisations'), { recursive: true });
writeFileSync(join(home, 'authorisations', `${site.authorisation}.yaml`), stringify(authorisation));

// Project and journeys.
const projectDir = join(home, 'projects', site.project);
const journeysDir = join(projectDir, 'journeys');
mkdirSync(journeysDir, { recursive: true });
const sourceDir = join(root, 'examples/projects', site.project);
copyFileSync(join(sourceDir, 'project.yaml'), join(projectDir, 'project.yaml'));
for (const file of readdirSync(join(sourceDir, 'journeys')).filter((entry) => entry.endsWith('.yaml'))) {
  copyFileSync(join(sourceDir, 'journeys', file), join(journeysDir, file));
}

// Logins go into the encrypted store, never into a project file. A site with its own sign-up gets
// made-up customers with random passwords; the others use the login each site publishes.
let count = 0;
let signedUp = 0;
let kept = 0;
if (site.signUp) {
  const { listFields } = await import(join(root, 'packages/controller/dist/index.js'));
  for (const [label, person] of Object.entries(site.signUp.people)) {
    const email = `${person.first_name}.${person.last_name}.hornet@example.com`.toLowerCase();
    const password = strongPassword();
    const response = await fetch(`${site.signUp.api}/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        first_name: person.first_name,
        last_name: person.last_name,
        dob: '1990-01-01',
        address: '1 Test Street',
        city: 'Testville',
        state: 'NSW',
        country: 'AU',
        postcode: '2000',
        phone: '0412345678',
        email,
        password,
      }),
    });
    if (response.status === 200 || response.status === 201) {
      setSecret(site.project, label, 'username', email, home);
      setSecret(site.project, label, 'password', password, home);
      signedUp += 1;
    } else if (response.status === 409 || response.status === 422) {
      // Signed up on an earlier run. The stored login still holds, if there is one.
      if (!listFields(site.project, label, home).includes('password')) {
        process.stderr.write(`${label} already exists on the site but has no stored login here.\n`);
        process.exit(6);
      }
      kept += 1;
    } else {
      process.stderr.write(`Could not sign up ${label} (HTTP ${response.status}).\n`);
      process.exit(6);
    }
    count += 1;
  }
} else {
  const password = await practicePassword(site);
  for (const [label, username] of Object.entries(site.usernames)) {
    setSecret(site.project, label, 'username', username, home);
    setSecret(site.project, label, 'password', password, home);
  }
  count = Object.keys(site.usernames).length;
}

// The swarm board agents read with get_swarm. Existing notes are kept.
const project = parse(readFileSync(join(projectDir, 'project.yaml'), 'utf8'));
const board = {
  ready: true,
  project: site.project,
  website: project.targets.base_url,
  agents: Object.entries(site.agents).map(([label, agent]) => ({ label, ...agent })),
};
writeFileSync(join(projectDir, 'swarm.json'), `${JSON.stringify(board, null, 2)}\n`);

process.stdout.write(
  [
    `Installed ${site.project} with ${count} login${count === 1 ? '' : 's'}.${existsSync(join(projectDir, 'notes')) ? ' Existing agent notes were kept.' : ''}`,
    ...(site.signUp
      ? [
          `Signed up ${signedUp} new customer${signedUp === 1 ? '' : 's'}, kept ${kept} from before.`,
          ...(signedUp > 0 && kept === 0 && existsSync(join(projectDir, 'secrets.sops.yaml')) ? ['If these customers existed before, the site has reset its data since. Their old logins were replaced.'] : []),
        ]
      : []),
    '',
    'Next:',
    `  pnpm hornet-swarm env up --project ${site.project}`,
    `  pnpm hornet-swarm sign-in --project ${site.project}`,
    `  pnpm hornet-swarm suite --project ${site.project}`,
    `  pnpm hornet-swarm stats --project ${site.project}`,
    '',
  ].join('\n'),
);
