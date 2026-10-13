#!/usr/bin/env node
// Sets up the local practice labs: Toolshop (sprint 5 with deliberate bugs) and Restful Booker
// Platform, running in Docker on this Mac and bound to 127.0.0.1. Run `pnpm build` first.
//
//   node scripts/setup-lab.mjs            start the labs and install both projects
//   node scripts/setup-lab.mjs --reset    also wipe both labs' data back to the seed
//
// It builds the shop's front end once, starts labs/docker-compose.yml, writes an owner
// authorisation for this Mac only, installs the toolshop-lab and booker-lab projects, signs up
// five made-up Toolshop customers with random passwords, and stores every login in the encrypted
// store. The two admin logins each site publishes in its README are read from that README, so no
// password is kept in this repo. No password is printed.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const root = join(import.meta.dirname, '..');
const home = process.env.AEGIS_HOME ?? join(homedir(), '.hornet-swarm');
const labsDir = join(homedir(), '.hornet-swarm', 'labs');
const compose = ['compose', '-f', join(root, 'labs', 'docker-compose.yml')];
const reset = process.argv.includes('--reset');
const SHOP = 'http://127.0.0.1:4300';
const SHOP_API = 'http://127.0.0.1:8091';
const BOOKER = 'http://127.0.0.1:3300';

const SHARED_RULES = [
  'Test only the lab on this Mac. Never open another site.',
  'Use only the login stored for your label. Never ask for, type, or repeat a password.',
  'Use made-up details only: example.com addresses, Testville, and test bank numbers.',
  'Report what the evidence shows. Check the screenshot before calling something broken.',
  'Name the step that failed and quote what the page said.',
].join(' ');

const TOOLSHOP_CUSTOMERS = {
  'qa-user-1': { first_name: 'Mara', last_name: 'Quill', personality: 'A careful first-time shopper. The control account: if this one fails, the shop is broken for everyone.' },
  'qa-user-2': { first_name: 'Tobin', last_name: 'Reyes', personality: 'A bargain hunter who searches and filters before buying anything, and signs up new accounts.' },
  'qa-user-3': { first_name: 'Iris', last_name: 'Calloway', personality: 'A rushed buyer who double-clicks, refreshes, and tries every payment method.' },
  'qa-user-4': { first_name: 'Dev', last_name: 'Okafor', personality: 'A tidy account keeper who checks the profile and favourites match what was entered.' },
  'qa-user-5': { first_name: 'Lena', last_name: 'Marsh', personality: 'A customer who writes to support and expects a clear reply on screen.' },
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

async function readmeLogin(url, pattern) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return (await response.text()).match(pattern)?.[1]?.trim();
}

function strongPassword() {
  // Upper, lower, digit, and symbol, as Toolshop's sign-up rules ask.
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let body = '';
  for (let index = 0; index < 16; index += 1) body += letters[randomInt(letters.length)];
  return `${body}#${randomInt(10)}a`;
}

// 1. The shop's front end, built once with its API at the address runners use.
const uiDir = join(labsDir, 'toolshop-ui');
if (!existsSync(join(uiDir, 'index.html'))) {
  say('Building the Toolshop front end (one time, a few minutes)...');
  mkdirSync(uiDir, { recursive: true });
  const envFile = join(labsDir, 'toolshop-env.ts');
  writeFileSync(envFile, "export const environment = {\n  production: true,\n  apiUrl: 'http://host.docker.internal:8091'\n};\n");
  docker([
    'run', '--rm', '--platform', 'linux/amd64', '-m', '3g',
    '-v', `${envFile}:/app/src/environments/environment.ts:ro`,
    '-v', `${envFile}:/app/src/environments/environment.prod.ts:ro`,
    '-v', `${uiDir}:/out`,
    '--entrypoint', 'sh', 'testsmith/practice-software-testing-sprint5-with-bugs-ui',
    '-c', 'npx ng build --configuration production --output-path /tmp/dist >/tmp/build.log 2>&1 || { tail -20 /tmp/build.log; exit 1; }; cp -r /tmp/dist/. /out/',
  ], { timeout: 900_000 });
}

// 2. The labs.
say('Starting the labs...');
docker([...compose, 'up', '-d'], { timeout: 600_000 });
if (reset) {
  say('Resetting the booker (its data lives in memory)...');
  docker([...compose, 'restart', 'rbp-booking', 'rbp-room', 'rbp-branding', 'rbp-auth', 'rbp-report', 'rbp-message'], { timeout: 300_000 });
}
if (!(await waitFor(`${SHOP_API}/status`, (response) => response.status < 500)) && !(await waitFor(`${SHOP_API}/brands`, (response) => response.status < 500, 60))) {
  say('The Toolshop API did not answer. See: docker compose -f labs/docker-compose.yml logs laravel-api');
  process.exit(5);
}
const seeded = await waitFor(`${SHOP_API}/products?page=1`, async (response) => response.ok && ((await response.json()).data ?? []).length > 0, 10);
if (!seeded || reset) {
  say('Seeding the Toolshop database...');
  docker([...compose, 'exec', '-T', 'laravel-api', 'php', 'artisan', 'migrate:fresh', '--seed', '--force'], { timeout: 300_000 });
}
if (!(await waitFor(`${BOOKER}/api/room/1`))) {
  say('The booker did not answer. See: docker compose -f labs/docker-compose.yml logs rbp-site');
  process.exit(5);
}

// 3. The owner's statement and authorisation. Covers this Mac only.
const docsDir = join(home, 'authorisations', 'docs');
mkdirSync(docsDir, { recursive: true, mode: 0o700 });
// UTC, as the harness reads authorisation dates.
const today = new Date().toISOString().slice(0, 10);
const until = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
const statement = [
  `Owner statement for the Hornet Swarm practice labs, ${today}.`,
  '',
  'Iron Adamant runs local copies of two open-source testing-practice apps in Docker on its own Mac:',
  'Practice Software Testing (Toolshop, sprint 5 with deliberate bugs) and Restful Booker Platform.',
  'Their ports are bound to 127.0.0.1 and reached by the runners as host.docker.internal.',
  'Iron Adamant authorises sign-in checks, functional journeys, and chaos runs against these copies,',
  `from ${today} to ${until}. No other host is covered. Only made-up details are used.`,
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

// 4. Projects and journeys.
for (const id of ['toolshop-lab', 'booker-lab']) {
  const projectDir = join(home, 'projects', id);
  mkdirSync(join(projectDir, 'journeys'), { recursive: true });
  const source = join(root, 'examples/projects', id);
  copyFileSync(join(source, 'project.yaml'), join(projectDir, 'project.yaml'));
  for (const file of readdirSync(join(source, 'journeys')).filter((entry) => entry.endsWith('.yaml'))) {
    copyFileSync(join(source, 'journeys', file), join(projectDir, 'journeys', file));
  }
}

// 5. Logins. Made-up Toolshop customers are signed up through the shop's own API.
let signedUp = 0;
let kept = 0;
for (const [label, person] of Object.entries(TOOLSHOP_CUSTOMERS)) {
  const email = `${person.first_name}.${person.last_name}.lab@example.com`.toLowerCase();
  const password = strongPassword();
  const response = await fetch(`${SHOP_API}/users/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
  if (response.status === 201 || response.status === 200) {
    setSecret('toolshop-lab', label, 'username', email, home);
    setSecret('toolshop-lab', label, 'password', password, home);
    signedUp += 1;
  } else if (response.status === 409 || (response.status === 422 && JSON.stringify(await response.json()).includes('already'))) {
    // Signed up on an earlier run. The stored login still holds, if there is one.
    if (!listFields('toolshop-lab', label, home).includes('password')) {
      say(`${label} exists in the shop but has no stored login. Run again with --reset.`);
      process.exit(6);
    }
    kept += 1;
  } else {
    say(`Could not sign up ${label} (HTTP ${response.status}).`);
    process.exit(6);
  }
}

const shopAdmin =
  process.env.HORNET_TOOLSHOP_ADMIN_PASSWORD ??
  (await readmeLogin('https://raw.githubusercontent.com/testsmith-io/practice-software-testing/main/README.md', /\|\s*admin\s*\|\s*admin@practicesoftwaretesting\.com\s*\|\s*([^|\s]+)\s*\|/));
if (!shopAdmin) {
  say('Could not read the Toolshop admin login from its README. Set HORNET_TOOLSHOP_ADMIN_PASSWORD and run this again.');
  process.exit(5);
}
setSecret('toolshop-lab', 'qa-user-6', 'username', 'admin@practicesoftwaretesting.com', home);
setSecret('toolshop-lab', 'qa-user-6', 'password', shopAdmin, home);

// The booker's published admin password is a common word that also appears in its own pages and
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

// 6. Swarm boards.
const boards = {
  'toolshop-lab': [
    ...Object.entries(TOOLSHOP_CUSTOMERS).map(([label, person]) => ({ label, personality: person.personality, rules: SHARED_RULES })),
    { label: 'qa-user-6', personality: 'The shop admin, who keeps the catalogue and orders in order.', rules: `${SHARED_RULES} Change only records you created in this run.` },
  ],
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
    `Labs ready. Toolshop: ${SHOP}  Booker: ${BOOKER}  (this Mac only)`,
    `toolshop-lab: ${signedUp} customers signed up${kept ? `, ${kept} kept from before` : ''}, plus the shop admin.`,
    bookerLogins ? 'booker-lab: 3 labels share the booker admin login.' : 'booker-lab: guest journeys only. Its admin login is not stored yet (see the script header).',
    `Authorisation: lab-owner, ${today} to ${until}, this Mac only.`,
    '',
    'Next:',
    '  pnpm hornet-swarm env up --project toolshop-lab',
    '  pnpm hornet-swarm suite --project toolshop-lab',
    '  pnpm hornet-swarm env up --project booker-lab',
    '  pnpm hornet-swarm suite --project booker-lab',
    '',
  ].join('\n'),
);
