#!/usr/bin/env node
// Sets up the local practice labs: Restful Booker Platform, ParaBank, and OWASP Juice Shop,
// running in Docker on this Mac and bound to 127.0.0.1. Run `pnpm build` first.
//
//   node scripts/setup-lab.mjs            start the labs and install their projects
//   node scripts/setup-lab.mjs --reset    also wipe every lab's data back to the seed
//
// It starts labs/docker-compose.yml, writes an owner authorisation for this Mac only, installs
// the booker-lab, parabank-lab, and juice-shop-lab projects, signs up made-up ParaBank and Juice
// Shop customers with random passwords, and stores every login in the encrypted store. No password
// is kept in this repo. No password is printed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { bankPassword, strongPassword } from './lab-passwords.mjs';

const root = join(import.meta.dirname, '..');
const home = process.env.AEGIS_HOME ?? join(homedir(), '.hornet-swarm');
const compose = ['compose', '-f', join(root, 'labs', 'docker-compose.yml')];
const reset = process.argv.includes('--reset');
const BOOKER = 'http://127.0.0.1:3300';
const BANK = 'http://127.0.0.1:8095/parabank';
const JUICE = 'http://127.0.0.1:3010';

const PARABANK_CUSTOMERS = {
  'qa-user-1': { first_name: 'Nova', last_name: 'Ledger', personality: 'A careful saver who checks that every cent adds up after each transfer and payment.' },
  'qa-user-2': { first_name: 'Omar', last_name: 'Penny', personality: 'A busy professional who moves money between accounts and pays bills in a hurry.' },
  'qa-user-3': { first_name: 'Ruth', last_name: 'Sterling', personality: 'A first-home buyer applying for a loan, who wants a clear yes or no.' },
  'qa-user-4': { first_name: 'Kai', last_name: 'Mint', personality: 'A customer who just moved house and updates their contact details.' },
  // A password with a symbol, as many real customers choose. Its own login never updates its
  // profile, so it stays usable; its journey shows what a profile update does to such a password.
  'qa-user-5': { first_name: 'Zoe', last_name: 'Symbol', symbol: true, personality: 'A customer whose password has a symbol in it, who updates their phone number and signs back in.' },
};

const SHARED_RULES = [
  'Test only the lab on this Mac. Never open another site.',
  'Use only the login stored for your label. Never ask for, type, or repeat a password.',
  'Use made-up details only: example.com addresses, Testville, and test bank numbers.',
  'Report what the evidence shows. Check the screenshot before calling something broken.',
  'Name the step that failed and quote what the page said.',
].join(' ');

const JUICE_CUSTOMERS = {
  'qa-user-1': { first_name: 'Nia', last_name: 'Peel', personality: 'A careful first-time shopper. The control account: if this one fails, the shop is broken for everyone.' },
  'qa-user-2': { first_name: 'Cole', last_name: 'Bramble', personality: 'A bargain hunter who searches before buying, and signs up a new account on each visit.' },
  'qa-user-3': { first_name: 'Fern', last_name: 'Harlow', personality: 'A shopper who fills a basket, changes a quantity, and checks the total before paying.' },
  'qa-user-4': { first_name: 'Jules', last_name: 'Hart', personality: 'A customer who writes a product review and expects to see it on the page.' },
  'qa-user-5': { first_name: 'Sam', last_name: 'Wicker', personality: 'A customer who updates their profile and checks the shop kept the new name.' },
};

let setSecret;
let listFields;
try {
  ({ setSecret, listFields } = await import(join(root, 'packages/controller/dist/index.js')));
} catch {
  process.stderr.write('Build the workspace first: pnpm build\n');
  process.exit(4);
}

const say = (line) => process.stdout.write(`${line}\n`);
const docker = (args, options = {}) => execFileSync('docker', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });

async function waitFor(url, test = (response) => response.ok, seconds = 180) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (await test(response)) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

// 1. The labs.
say('Starting the labs...');
docker([...compose, 'up', '-d'], { timeout: 600_000 });
if (reset) {
  say('Resetting the booker (its data lives in memory)...');
  docker([...compose, 'restart', 'rbp-booking', 'rbp-room', 'rbp-branding', 'rbp-auth', 'rbp-report', 'rbp-message'], { timeout: 300_000 });
  // Juice Shop keeps its database inside the container. A restart would keep the old customers,
  // so reset replaces the container and the image's seed data comes back.
  say('Resetting Juice Shop (a new container, so its data is fresh)...');
  docker([...compose, 'up', '-d', '--force-recreate', '--no-deps', 'juice-shop'], { timeout: 300_000 });
}
if (!(await waitFor(`${BOOKER}/api/room/1`))) {
  say('The booker did not answer. See: docker compose -f labs/docker-compose.yml logs rbp-site');
  process.exit(5);
}
if (!(await waitFor(`${BANK}/index.htm`, (response) => response.status < 500))) {
  say('ParaBank did not answer. See: docker compose -f labs/docker-compose.yml logs parabank');
  process.exit(5);
}
if (!(await waitFor(`${JUICE}/api/SecurityQuestions`, async (response) => {
  if (!response.ok) return false;
  const body = await response.json();
  return Array.isArray(body.data) && body.data.length > 0;
}))) {
  say('Juice Shop did not answer. See: docker compose -f labs/docker-compose.yml logs juice-shop');
  process.exit(5);
}

/** A ParaBank page session: the bank keeps state in a session cookie, so each form post carries it. */
async function bankSession() {
  const first = await fetch(`${BANK}/index.htm`, { redirect: 'manual' });
  const cookie = first.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  return (path, form) =>
    fetch(`${BANK}/${path}`, {
      method: form ? 'POST' : 'GET',
      redirect: 'follow',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    }).then((response) => response.text());
}

if (reset) {
  say('Resetting ParaBank to its starting data...');
  const bank = await bankSession();
  await bank('db.htm', { action: 'INIT' });
}

// 2. The owner's statement and authorisation. Covers this Mac only.
const docsDir = join(home, 'authorisations', 'docs');
mkdirSync(docsDir, { recursive: true, mode: 0o700 });
// UTC, as the harness reads authorisation dates.
const today = new Date().toISOString().slice(0, 10);
const until = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
const statement = [
  `Owner statement for the Hornet Swarm practice labs, ${today}.`,
  '',
  'Iron Adamant runs local copies of three testing-practice apps in Docker on its own Mac:',
  'Restful Booker Platform, ParaBank, a demo bank, and OWASP Juice Shop, a demo shop.',
  'Their ports are bound to 127.0.0.1 and reached by the runners as host.docker.internal.',
  'Iron Adamant authorises sign-in checks, functional journeys, chaos runs, and access-control',
  `checks against these copies, from ${today} to ${until}. No other host is covered. Only made-up`,
  'details are used. An access-control check may read ParaBank\'s Admin Page. It must not press',
  'Initialize, Clean, or the JMS control. Juice Shop\'s scoreboard and its challenge pages are out',
  'of scope. Do not solve a captcha, including the one on Juice Shop\'s customer feedback form.',
  '',
  'Aron Amos, Owner',
  '',
].join('\n');
const statementFile = join(docsDir, `lab-owner-statement-${today}.txt`);
writeFileSync(statementFile, statement, { mode: 0o600 });
const authorisation = parse(readFileSync(join(root, 'examples/authorisations/lab-owner.yaml'), 'utf8'));
authorisation.valid_from = today;
authorisation.valid_until = until;
authorisation.document = { path: statementFile, sha256: createHash('sha256').update(statement).digest('hex') };
writeFileSync(join(home, 'authorisations', 'lab-owner.yaml'), stringify(authorisation));

// 3. Projects and journeys.
for (const id of ['booker-lab', 'parabank-lab', 'juice-shop-lab']) {
  const projectDir = join(home, 'projects', id);
  mkdirSync(join(projectDir, 'journeys'), { recursive: true });
  const source = join(root, 'examples/projects', id);
  copyFileSync(join(source, 'project.yaml'), join(projectDir, 'project.yaml'));
  for (const file of readdirSync(join(source, 'journeys')).filter((entry) => entry.endsWith('.yaml'))) {
    copyFileSync(join(source, 'journeys', file), join(projectDir, 'journeys', file));
  }
}

// 4. Logins. The booker's published admin password is a common word that also appears in its own pages and
// field names, so redacting it would blank out ordinary text. Its admin login is stored only when
// the owner sets HORNET_BOOKER_ADMIN_PASSWORD. Until then, booker-lab runs its guest journeys.
let bookerLogins = false;
if (process.env.HORNET_BOOKER_ADMIN_PASSWORD) {
  for (const label of ['qa-user-1', 'qa-user-2', 'qa-user-3']) {
    setSecret('booker-lab', label, 'username', 'admin', home);
    setSecret('booker-lab', label, 'password', process.env.HORNET_BOOKER_ADMIN_PASSWORD, home);
  }
  bookerLogins = true;
}

// ParaBank customers sign up through the bank's own form. Usernames stay under its 20-character limit.
let bankSignedUp = 0;
let bankKept = 0;
for (const [label, person] of Object.entries(PARABANK_CUSTOMERS)) {
  const username = `${person.first_name}${person.last_name}`.toLowerCase();
  const password = person.symbol ? strongPassword() : bankPassword();
  const bank = await bankSession();
  await bank('register.htm');
  const page = await bank('register.htm', {
    'customer.firstName': person.first_name,
    'customer.lastName': person.last_name,
    'customer.address.street': '1 Test Street',
    'customer.address.city': 'Testville',
    'customer.address.state': 'NSW',
    'customer.address.zipCode': '2000',
    'customer.phoneNumber': '0412345678',
    'customer.ssn': '123-45-6789',
    'customer.username': username,
    'customer.password': password,
    repeatedPassword: password,
  });
  if (page.includes('created successfully')) {
    setSecret('parabank-lab', label, 'username', username, home);
    setSecret('parabank-lab', label, 'password', password, home);
    bankSignedUp += 1;
  } else if (page.includes('already exists')) {
    if (!listFields('parabank-lab', label, home).includes('password')) {
      say(`${label} exists in ParaBank but has no stored login. Run again with --reset.`);
      process.exit(6);
    }
    bankKept += 1;
  } else {
    say(`Could not sign up ${label} at ParaBank.`);
    process.exit(6);
  }
}

// Juice Shop customers sign up through the shop's own registration. The security answer is made up
// and is not a login, so it is not stored.
let juiceSignedUp = 0;
let juiceKept = 0;
const questionsResponse = await fetch(`${JUICE}/api/SecurityQuestions`, { signal: AbortSignal.timeout(15_000) });
if (!questionsResponse.ok) {
  say(`Could not read Juice Shop's security questions (HTTP ${questionsResponse.status}).`);
  process.exit(6);
}
const questions = (await questionsResponse.json()).data ?? [];
const securityQuestion = questions.find((question) => /favorite pet/i.test(question.question ?? '')) ?? questions[0];
if (!securityQuestion?.id) {
  say('Juice Shop returned no security question.');
  process.exit(6);
}
const securityAnswer = 'Testville';
for (const [label, person] of Object.entries(JUICE_CUSTOMERS)) {
  const email = `${person.first_name}.${person.last_name}.juice@example.com`.toLowerCase();
  const password = strongPassword();
  const response = await fetch(`${JUICE}/api/Users/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      email,
      password,
      passwordRepeat: password,
      securityQuestion: { id: securityQuestion.id },
      securityAnswer,
    }),
  });
  if (response.status === 201 || response.status === 200) {
    setSecret('juice-shop-lab', label, 'username', email, home);
    setSecret('juice-shop-lab', label, 'password', password, home);
    juiceSignedUp += 1;
  } else if (response.status === 400) {
    const body = await response.json().catch(() => ({}));
    const messages = JSON.stringify(body.errors ?? body.message ?? '');
    if (messages.includes('unique') && !messages.includes(password)) {
      if (!listFields('juice-shop-lab', label, home).includes('password')) {
        say(`${label} exists in Juice Shop but has no stored login. Run again with --reset.`);
        process.exit(6);
      }
      juiceKept += 1;
    } else {
      say(`Could not sign up ${label} at Juice Shop (HTTP ${response.status}).`);
      process.exit(6);
    }
  } else {
    say(`Could not sign up ${label} at Juice Shop (HTTP ${response.status}).`);
    process.exit(6);
  }
}

// 5. Swarm boards.
const boards = {
  'parabank-lab': Object.entries(PARABANK_CUSTOMERS).map(([label, person]) => ({
    label,
    personality: person.personality,
    rules: `${SHARED_RULES} Move only small amounts between your own accounts and made-up payees.`,
  })),
  'juice-shop-lab': Object.entries(JUICE_CUSTOMERS).map(([label, person]) => ({
    label,
    personality: person.personality,
    rules: `${SHARED_RULES} Do not open the scoreboard or the challenge pages. Do not solve a captcha. Use a made-up card only.`,
  })),
  'booker-lab': [
    { label: 'qa-user-1', personality: 'The front-desk manager, who adds rooms and checks they can be booked.', rules: `${SHARED_RULES} Change only rooms you created in this run.` },
    { label: 'qa-user-2', personality: 'The owner, who reads the report, the branding, and the inbox every morning.', rules: SHARED_RULES },
    { label: 'qa-user-3', personality: 'A guest planning a weekend away, who browses, asks questions, and books.', rules: SHARED_RULES },
  ],
};
for (const [id, agents] of Object.entries(boards)) {
  const project = parse(readFileSync(join(home, 'projects', id, 'project.yaml'), 'utf8'));
  writeFileSync(join(home, 'projects', id, 'swarm.json'), `${JSON.stringify({ ready: true, project: id, website: project.targets.base_url, agents }, null, 2)}\n`);
}

say(
  [
    `Labs ready. Booker: ${BOOKER}  ParaBank: ${BANK}/  Juice Shop: ${JUICE}/  (this Mac only)`,
    bookerLogins ? 'booker-lab: 3 labels share the booker admin login.' : 'booker-lab: guest journeys only. Its admin login is not stored yet (see the script header).',
    `parabank-lab: ${bankSignedUp} customers signed up${bankKept ? `, ${bankKept} kept from before` : ''}.`,
    `juice-shop-lab: ${juiceSignedUp} customers signed up${juiceKept ? `, ${juiceKept} kept from before` : ''}.`,
    `Authorisation: lab-owner, ${today} to ${until}, this Mac only.`,
    '',
    'Next:',
    '  pnpm hornet-swarm env up --project juice-shop-lab',
    '  pnpm hornet-swarm suite --project juice-shop-lab',
    '  pnpm hornet-swarm env up --project parabank-lab',
    '  pnpm hornet-swarm suite --project parabank-lab',
    '  pnpm hornet-swarm env up --project booker-lab',
    '  pnpm hornet-swarm suite --project booker-lab',
    '  pnpm hornet-swarm env up --project juice-shop-lab',
    '  pnpm hornet-swarm suite --project juice-shop-lab',
    '',
  ].join('\n'),
);
