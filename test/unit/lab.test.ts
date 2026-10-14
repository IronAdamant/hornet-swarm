import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { authorisationSchema, chaosSequence, projectSchema, renderTemplate, validateJourneyDocument, type Project } from '../../packages/core/src/index.ts';
import { reliabilityReport } from '../../packages/controller/src/suite.ts';
import { utimesSync } from 'node:fs';
import { failureList, summaryMarkdown } from '../../packages/report/src/render.ts';
import { closestText, executeJob, type JobRequest } from '../../packages/runner/src/job.ts';
import { busyMessage } from '../../packages/controller/src/suite.ts';
import { changedSince, settledFingerprints, staleBuilds } from '../../packages/mcp-server/src/freshness.ts';
import { chaosFailureGroups, writeErrorsOnPassingSteps } from '../../packages/report/src/render.ts';
import { bankPassword } from '../../scripts/lab-passwords.mjs';

const root = join(import.meta.dirname, '..', '..');
const readYaml = (path: string): unknown => parse(readFileSync(path, 'utf8'));
const project = (id: string): Project => projectSchema.parse(readYaml(join(root, 'examples/projects', id, 'project.yaml')));
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((path) => existsSync(path));

describe('the local labs', () => {
  it('cover this Mac only, and leave cross-account checks out for now', () => {
    const auth = authorisationSchema.parse(readYaml(join(root, 'examples/authorisations/lab-owner.yaml')));
    expect(auth.basis).toBe('owner');
    expect(auth.scope.domains.sort()).toEqual(['host.docker.internal', 'localhost']);
    expect(auth.activities).not.toContain('access_control_checks');
    for (const id of ['toolshop-lab', 'booker-lab', 'parabank-lab']) {
      const config = project(id);
      expect(config.authorisation_id).toBe('lab-owner');
      for (const origin of [config.targets.base_url, ...config.targets.allowed_origins]) expect(new URL(origin).hostname).toMatch(/^(127\.0\.0\.1|host\.docker\.internal)$/);
      expect(config.targets.allowed_third_party).toEqual([]);
    }
  });

  it('bind every lab port to 127.0.0.1', () => {
    const compose = parse(readFileSync(join(root, 'labs/docker-compose.yml'), 'utf8')) as { services: Record<string, { ports?: string[] }> };
    const ports = Object.values(compose.services).flatMap((service) => service.ports ?? []);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port.startsWith('127.0.0.1:'), port).toBe(true);
  });

  it('keep passwords out of journeys and the setup script', () => {
    for (const id of ['toolshop-lab', 'booker-lab', 'parabank-lab']) {
      const config = project(id);
      const dir = join(root, 'examples/projects', id, 'journeys');
      for (const file of readdirSync(dir)) {
        const steps = (readYaml(join(dir, file)) as { steps: Record<string, { selector?: string; value?: string; credential?: string }>[] }).steps;
        for (const fill of steps.flatMap((step) => (step.fill ? [step.fill] : []))) {
          if (fill.selector !== config.auth.selectors.password) continue;
          // A literal is only allowed as a deliberately wrong password.
          if (fill.value !== undefined) expect(fill.value, `${id}/${file}`).toMatch(/not-the-password/);
          else expect(fill.credential, `${id}/${file}`).toMatch(/^self\.|^qa-user-\d+\./);
        }
      }
    }
    const script = readFileSync(join(root, 'scripts/setup-lab.mjs'), 'utf8');
    expect(script).not.toMatch(/password:\s*['"`]/);
    expect(script).not.toMatch(/HORNET_BOOKER_ADMIN_PASSWORD\s*\?\?\s*['"`]/);
  });

  it('gives ParaBank an alphanumeric password, because the profile page puts it in a URL', () => {
    const script = readFileSync(join(root, 'scripts/setup-lab.mjs'), 'utf8');
    expect(script).toContain('const password = bankPassword()');
    for (let index = 0; index < 40; index += 1) {
      const password = bankPassword();
      expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
      expect(password.includes('#')).toBe(false);
    }
  });
});

describe('journey templates and steps', () => {
  const context = { users: { 'qa-user-4': { vars: { first_name: 'Dev' } } }, run: { id: 'run_x', label: 'qa-user-4' } };

  it('fill in the run id, the running label, its own vars, and a date from today', () => {
    expect(renderTemplate('nova.{{run.id}}@example.com', context)).toBe('nova.run_x@example.com');
    expect(renderTemplate('{{run.label}}', context)).toBe('qa-user-4');
    expect(renderTemplate('{{self.vars.first_name}}', context)).toBe('Dev');
    const inThirty = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(renderTemplate('{{date.+30}}', context)).toBe(inThirty);
    expect(renderTemplate('{{date.soon}}', context)).toBe('{{date.soon}}');
    // A short part of the run id, for sites with a username length limit.
    expect(renderTemplate('nova{{run.tag}}', { run: { id: 'run_20261014-144636_67a533', label: 'qa-user-1' } })).toBe('nova67a533');
  });

  it('checks select and field_value steps, and never lets field_value read the password', () => {
    const config = project('toolshop-lab');
    const check = (steps: unknown[]) => validateJourneyDocument({ version: 1, id: 'x', name: 'x', users: ['qa-user-1'], steps }, config).errors;
    expect(check([{ select: { selector: '#c', label: 'Australia' } }])).toEqual([]);
    expect(check([{ select: { selector: '#c', index: 1 } }])).toEqual([]);
    expect(check([{ select: { selector: '#c', index: 1, label: 'Australia' } }])[0]).toContain('exactly one');
    expect(check([{ select: { selector: '#c' } }])[0]).toContain('select needs exactly one of value, label, or index');
    expect(check([{ assert: { type: 'field_value', selector: '#city', value: 'Testville' } }])).toEqual([]);
    expect(check([{ assert: { type: 'field_value', value: 'x' } }])[0]).toContain('needs a selector');
    expect(check([{ assert: { type: 'field_value', selector: config.auth.selectors.password, value: 'x' } }])[0]).toContain('may not read the password');
    expect(check([{ assert: { type: 'text_visible', selector: '#a', value: 'x' } }])[0]).toContain('only field_value takes a selector');
  });
});

describe('reports list every failure', () => {
  const step = (index: number, status: string, extra: Record<string, unknown> = {}) => ({ index, type: 'assert', status, duration_ms: 1, started_at: '', finished_at: '', ...extra });
  const users = [
    { label: 'qa-user-1', phase1: { status: 'pass', duration_ms: 1 }, journeys: [{ id: 'cart', name: 'Cart', status: 'fail', duration_ms: 1, steps: [step(0, 'pass'), step(1, 'fail', { assertion: 'text_visible Related products', error: 'text was not visible' })] }] },
    { label: 'qa-user-3', phase1: { status: 'pass', duration_ms: 1 }, journeys: [{ id: 'cart', name: 'Cart', status: 'fail', duration_ms: 1, steps: [step(0, 'pass'), step(1, 'fail', { assertion: 'text_visible Related products', error: 'text was not visible' })] }, { id: 'cod', name: 'Cash on delivery', status: 'fail', duration_ms: 1, steps: [step(0, 'fail', { assertion: "selector_visible [data-test='finish']:enabled", error: 'locator.waitFor: Timeout 10000ms exceeded.\nCall log:' })] }] },
  ] as unknown as Parameters<typeof failureList>[0];

  it('merges one failure seen on several accounts and puts timeouts in plain words', () => {
    const list = failureList(users);
    expect(list).toHaveLength(2);
    expect(list[0]).toBe('qa-user-1, qa-user-3 · Cart · step 1 (assert text_visible Related products): text was not visible');
    expect(list[1]).toContain('it did not appear within 10 seconds');
    expect(list.join('\n')).not.toContain('Call log');
  });

  it('counts sign-ins and journeys, and explains a chaos run', () => {
    const text = summaryMarkdown(users, 'failed', { profile: 'default', seed: 'lab-1' });
    expect(text).toContain('2 checks did not pass.');
    expect(text).toContain('Sign-in: 2 of 2 accounts got in.');
    expect(text).toContain('Journeys: 0 of 3 passed.');
    expect(text).toContain('seed lab-1');
    expect(text).not.toContain('The later checks passed');
  });

  it('gives each label and journey its own repeatable chaos pattern', () => {
    const a = chaosSequence('lab-1:qa-user-1:cart', 'default', 20);
    expect(chaosSequence('lab-1:qa-user-1:cart', 'default', 20)).toEqual(a);
    expect(chaosSequence('lab-1:qa-user-3:cart', 'default', 20)).not.toEqual(a);
  });
});

describe('reliability keeps chaos runs apart', () => {
  it('leaves chaos runs out by default, and counts only them with chaos: only', () => {
    const home = mkdtempSync(join(tmpdir(), 'hornet-rel-'));
    const write = (id: string, status: 'pass' | 'fail', chaos: boolean) => {
      const dir = join(home, 'runs', id);
      mkdirSync(dir, { recursive: true });
      const run = {
        schema_version: '1',
        run_id: id,
        project: 'lab',
        started_at: `2026-10-14T0${id.slice(-1)}:00:00Z`,
        status: status === 'pass' ? 'passed' : 'failed',
        gate: 'per_user',
        gate_passed: true,
        totals: { users: 1, journeys: 1, steps: 1, passed: 1, failed: 0, skipped: 0 },
        users: [{ label: 'qa-user-1', phase1: { status: 'pass', duration_ms: 500 }, journeys: [{ id: 'contact', status, duration_ms: 900, steps: [] }] }],
        environment: 'test',
        authorisation_id: 'lab-owner',
        redaction: 'pass',
      };
      writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
      writeFileSync(join(dir, 'analysis.json'), JSON.stringify({ chaos: chaos ? { profile: 'default', seed: 's', actions: [] } : null }));
    };
    write('run_1', 'pass', false);
    write('run_2', 'pass', false);
    write('run_3', 'fail', true);
    const normal = reliabilityReport('lab', 20, home);
    expect(normal.runs).toBe(2);
    expect(normal.journeys[0]?.pass_rate).toBe(1);
    expect(normal.notes.join(' ')).toContain('1 chaos run was left out');
    const chaos = reliabilityReport('lab', 20, home, 'only');
    expect(chaos.runs).toBe(1);
    expect(chaos.journeys[0]?.pass_rate).toBe(0);
  });
});

describe('the runner on a real page', () => {
  let server: Server;
  let port = 0;
  let submits = 0;

  beforeAll(async () => {
    process.env.AEGIS_HEADLESS = '1';
    if (chrome) process.env.AEGIS_BROWSER = chrome;
    server = createServer((req, res) => {
      if (req.url === '/submit') submits += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      if (req.url === '/form') {
        res.end(`<!doctype html><html><body>
<label for="subject">Subject</label>
<select id="subject"><option value="">Select a subject</option><option value="cs" selected>Customer service</option><option value="e101">Error 101: Subject not found</option></select>
<p>Contact us</p>
</body></html>`);
        return;
      }
      if (req.url === '/shop') {
        res.end(`<!doctype html><html><body>
<h2>Reltded products</h2>
<div class="toast-message">Oeps, something went wrong.</div>
<label for="postcode">Postcode</label><input id="postcode" value="missing value">
<p>Errror 304 - Missing Payment Gateway</p>
<button data-test="finish" disabled>Confirm</button>
<button data-test="search">Serch</button>
</body></html>`);
        return;
      }
      res.end(`<!doctype html><html><body>
<select id="country"><option value="">Pick</option><option value="AU">Australia</option><option value="NZ">New Zealand</option></select>
<input id="city" value="Testville"><input id="name">
<button id="send" onclick="fetch('/submit')">Send</button>
</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.AEGIS_HEADLESS;
    delete process.env.AEGIS_BROWSER;
  });

  const job = (steps: JobRequest['steps'], name: string, chaosActions: JobRequest['chaosActions'] = []): JobRequest => ({
    runId: 'run_lab',
    label: 'qa-user-1',
    journeyId: name,
    baseUrl: `http://127.0.0.1:${port}`,
    steps,
    allowOrigins: [`http://127.0.0.1:${port}`],
    passiveOrigins: [],
    authEndpoints: [],
    minStepDelayMs: 0,
    rps: 50,
    burst: 50,
    accessDeniedMarkers: [],
    chaosActions,
    outDir: join(mkdtempSync(join(tmpdir(), 'hornet-lab-')), name),
    vars: {},
    users: { 'qa-user-1': { vars: { city: 'Testville' } } },
  });

  it('chooses an option by label and checks a field value, and names what the field held', async () => {
    const passed = await executeJob(
      job(
        [
          { navigate: { url: '/' } },
          { select: { selector: '#country', label: 'New Zealand' } },
          { assert: { type: 'field_value', selector: '#country', value: 'NZ' } },
          { select: { selector: '#country', index: 1 } },
          { assert: { type: 'field_value', selector: '#country', value: 'AU' } },
          { assert: { type: 'field_value', selector: '#city', value: '{{self.vars.city}}' } },
        ],
        'select',
      ),
      new Map(),
      () => false,
    );
    expect(passed.status, JSON.stringify(passed.steps.map((entry) => entry.error))).toBe('passed');
    const failed = await executeJob(job([{ navigate: { url: '/' } }, { assert: { type: 'field_value', selector: '#city', value: 'Elsewhere' } }], 'field-fail'), new Map(), () => false);
    expect(failed.status).toBe('failed');
    expect(failed.steps.at(-1)?.error).toContain('field held "Testville"');
  }, 60_000);

  it('skips a chaos refresh while a form is half filled, and double-clicks the step\'s own button', async () => {
    const before = submits;
    const report = await executeJob(
      job(
        [{ navigate: { url: '/' } }, { fill: { selector: '#name', value: 'Avery' } }, { assert: { type: 'field_value', selector: '#name', value: 'Avery' } }, { click: { selector: '#send' } }, { wait: { for: 'timeout', ms: 500 } }],
        'chaos',
        [
          { step: 2, kind: 'refresh', detail: 'refresh' },
          { step: 3, kind: 'double-click', detail: 'double-click' },
        ],
      ),
      new Map(),
      () => false,
    );
    expect(report.status, JSON.stringify(report.steps.map((entry) => entry.error))).toBe('passed');
    expect(report.chaosApplied).toEqual(['refresh:skipped (form in progress)', 'double-click:double-click']);
    expect(submits - before).toBe(2);
  }, 60_000);

  it('quotes the page when a check fails: the closest heading, the toast, and other error lines', async () => {
    const request = job([{ navigate: { url: '/shop' } }, { assert: { type: 'text_visible', value: 'Related products' } }], 'quote');
    const report = await executeJob(request, new Map(), () => false);
    const error = report.steps.at(-1)?.error ?? '';
    expect(error).toContain('closest text on the page: "Reltded products"');
    expect(error).toContain('page said: "Oeps, something went wrong."');
    expect(error).toContain('Errror 304 - Missing Payment Gateway');
    // The failed step leaves its own picture and the page's words, form values included.
    const text = readFileSync(join(request.outDir, 'failed-step-1.txt'), 'utf8');
    expect(text).toContain('Reltded products');
    expect(text).toContain('- Postcode: missing value');
    expect(text).toContain('- Confirm (disabled)');
    expect(report.steps.at(-1)?.screenshot_paths?.some((path) => path.endsWith('failed-step-1.png'))).toBe(true);
  }, 60_000);

  it('says a control is disabled, or what a button actually reads', async () => {
    const disabled = await executeJob(job([{ navigate: { url: '/shop' } }, { assert: { type: 'selector_visible', value: "[data-test='finish']:enabled" } }], 'disabled'), new Map(), () => false);
    expect(disabled.steps.at(-1)?.error).toContain('it is on the page but disabled');
    expect(disabled.steps.at(-1)?.error).toContain('Errror 304 - Missing Payment Gateway');
    const label = await executeJob(job([{ navigate: { url: '/shop' } }, { assert: { type: 'selector_visible', value: "[data-test='search']:has-text('Search')" } }], 'label'), new Map(), () => false);
    expect(label.steps.at(-1)?.error).toContain('it reads "Serch"');
  }, 60_000);

  it('leaves dropdown options out of the page text and the clues, and shows the chosen one', async () => {
    const request = job([{ navigate: { url: '/form' } }, { assert: { type: 'text_visible', value: 'Thanks for your message' } }], 'options');
    const report = await executeJob(request, new Map(), () => false);
    expect(report.steps.at(-1)?.error).not.toContain('Error 101');
    const text = readFileSync(join(request.outDir, 'failed-step-1.txt'), 'utf8');
    expect(text).not.toContain('Error 101: Subject not found');
    expect(text).toContain('Contact us');
    expect(text).toContain('- Subject: Customer service');
  }, 60_000);

  it('never drops the page load itself under chaos, and says so', async () => {
    const report = await executeJob(job([{ navigate: { url: '/' } }, { assert: { type: 'selector_visible', value: '#send' } }], 'spare', [{ step: 0, kind: 'drop', detail: 'once' }]), new Map(), () => false);
    expect(report.status, JSON.stringify(report.steps.map((entry) => entry.error))).toBe('passed');
    expect(report.chaosApplied).toContain('drop:spared the page load');
  }, 60_000);
});

describe('small helpers behind the clearer reports', () => {
  it('finds the closest words on the page, and nothing when no line is close', () => {
    expect(closestText(['Home', 'Reltded products', 'Contakt'], 'Related products')).toBe('Reltded products');
    expect(closestText(['Thanks for shopping'], 'Payment declined')).toBeUndefined();
  });

  it('names a busy login, its time, and that the site is not at fault', () => {
    const text = busyMessage('qa-user-5', '2026-10-14T00:16:18.745Z');
    expect(text).toContain('qa-user-5 is busy until 2026-10-14');
    expect(text).toContain('This is not a site failure.');
  });

  it('notes a passing step whose write was refused', () => {
    const users = [
      { label: 'qa-user-4', phase1: { status: 'pass', duration_ms: 1 }, journeys: [{ id: 'favourites', name: 'Favourites', status: 'pass', duration_ms: 1, steps: [{ index: 7, type: 'click', status: 'pass', duration_ms: 1, started_at: '', finished_at: '', network_errors: [{ method: 'POST', url: 'http://host.docker.internal:8091/favorites', status: 409 }, { method: 'GET', url: 'http://host.docker.internal:8091/users/me', status: 401 }] }] }] },
    ] as unknown as Parameters<typeof writeErrorsOnPassingSteps>[0];
    expect(writeErrorsOnPassingSteps(users)).toEqual(['qa-user-4 · Favourites · step 7 passed, but POST /favorites answered 409.']);
  });

  it('spots a build older than its source, and a rebuild that changed the code', () => {
    const root = mkdtempSync(join(tmpdir(), 'hornet-fresh-'));
    const src = join(root, 'packages', 'core', 'src');
    const dist = join(root, 'packages', 'core', 'dist');
    mkdirSync(src, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), 'export const a = 1;');
    writeFileSync(join(src, 'index.ts'), 'export const a = 1;');
    utimesSync(join(dist, 'index.js'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(staleBuilds(root)).toEqual(['core']);
    utimesSync(join(dist, 'index.js'), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(staleBuilds(root)).toEqual([]);
    const prints = settledFingerprints(root);
    writeFileSync(join(dist, 'index.js'), 'export const a = 1;');
    expect(changedSince(root, prints)).toEqual([]);
    writeFileSync(join(dist, 'index.js'), 'export const a = 2;');
    expect(changedSince(root, prints)).toEqual(['core']);
  });
});

describe('the summary explains the sign-in gate', () => {
  it('says a passed gate does not mean the journeys passed', () => {
    const users = [{ label: 'qa-user-1', phase1: { status: 'pass', duration_ms: 1 }, journeys: [{ id: 'cart', name: 'Cart', status: 'fail', duration_ms: 1, steps: [{ index: 3, type: 'assert', status: 'fail', duration_ms: 1, started_at: '', finished_at: '', error: 'text was not visible' }] }] }] as unknown as Parameters<typeof summaryMarkdown>[0];
    expect(summaryMarkdown(users, 'failed')).toContain('Sign-in gate: passed, because every account signed in. It does not mean the journeys passed.');
  });
});

describe('chaos summaries', () => {
  it('turns one cause across many journeys into one line', () => {
    const failed = (name: string) => ({ id: name, name, status: 'fail', duration_ms: 1, steps: [{ index: 5, type: 'assert', status: 'fail', duration_ms: 1, started_at: '', finished_at: '', assertion: "selector_visible [data-test='nav-user-menu']", error: 'locator.waitFor: Timeout 10000ms exceeded.' }] });
    const users = [
      { label: 'qa-user-1', phase1: { status: 'pass', duration_ms: 1 }, journeys: [failed('Cart'), failed('Checkout')] },
      { label: 'qa-user-4', phase1: { status: 'pass', duration_ms: 1 }, journeys: [failed('Profile')] },
    ] as unknown as Parameters<typeof chaosFailureGroups>[0];
    const lines = chaosFailureGroups(users);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the same failure stopped 3 journeys');
    expect(lines[0]).toContain('qa-user-1 · Cart (step 5); qa-user-1 · Checkout (step 5); qa-user-4 · Profile (step 5)');
    expect(summaryMarkdown(users, 'failed', { profile: 'default', seed: 'lab-1' })).toContain('Failed: the same failure stopped 3 journeys');
  });
});

