import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  authorisationSchema,
  chaosPermitted,
  PUBLIC_PRACTICE_LIMITS,
  practiceLimits,
  productionGate,
  projectDomainsAuthorised,
  projectSchema,
  resolveSelf,
  validateJourneyDocument,
  type Authorisation,
  type Project,
} from '../../packages/core/src/index.ts';
import { listFields, listLabels } from '../../packages/controller/src/broker.ts';
import { diagnose, summaryMarkdown } from '../../packages/report/src/render.ts';
import { browserLaunchOptions } from '../../packages/runner/src/launch.ts';

const root = join(import.meta.dirname, '..', '..');
const readYaml = (path: string): unknown => parse(readFileSync(path, 'utf8'));
const authorisation = (id: string): Authorisation => authorisationSchema.parse(readYaml(join(root, 'examples/authorisations', `${id}.yaml`)));
const project = (id: string): Project => projectSchema.parse(readYaml(join(root, 'examples/projects', id, 'project.yaml')));

describe('public practice authorisations', () => {
  it('parses every example authorisation', () => {
    for (const file of readdirSync(join(root, 'examples/authorisations'))) {
      expect(() => authorisationSchema.parse(readYaml(join(root, 'examples/authorisations', file))), file).not.toThrow();
    }
    expect(authorisation('the-internet-practice').basis).toBe('public_practice');
  });

  it('needs the published statement, and refuses chaos, access-control probing, passive security checks, and production', () => {
    const base = readYaml(join(root, 'examples/authorisations/the-internet-practice.yaml')) as Record<string, unknown>;
    expect(authorisationSchema.safeParse({ ...base, public_statement: undefined }).success).toBe(false);
    expect(authorisationSchema.safeParse({ ...base, activities: ['functional_e2e', 'chaos'] }).success).toBe(false);
    expect(authorisationSchema.safeParse({ ...base, activities: ['access_control_checks'] }).success).toBe(false);
    expect(authorisationSchema.safeParse({ ...base, activities: ['passive_security_checks'] }).success).toBe(false);
    expect(authorisationSchema.safeParse({ ...base, scope: { domains: ['the-internet.herokuapp.com'], environments: ['test', 'production'] } }).success).toBe(false);
  });

  it('still requires an authoriser and a document for owner and contract records', () => {
    const owner = readYaml(join(root, 'examples/authorisations/example-app-owner.yaml')) as Record<string, unknown>;
    expect(authorisationSchema.safeParse({ ...owner, authoriser: undefined }).success).toBe(false);
    expect(authorisationSchema.safeParse({ ...owner, document: undefined }).success).toBe(false);
  });

  it('passes the production gate on its own statement, covers its domain, and never allows chaos', () => {
    const record = { ...authorisation('the-internet-practice'), valid_from: '2026-01-01', valid_until: '2099-01-01' };
    const config = project('the-internet');
    expect(projectDomainsAuthorised(config, record).ok).toBe(true);
    expect(productionGate(config, record, false).ok).toBe(true);
    expect(practiceLimits(config, record).ok).toBe(true);
    expect(chaosPermitted(record, config).ok).toBe(false);
  });

  it('refuses a practice project that would push the shared site too hard', () => {
    const record = authorisation('the-internet-practice');
    const config = project('the-internet');
    const louder = { ...config, limits: { ...config.limits, max_requests_per_second_total: PUBLIC_PRACTICE_LIMITS.requestsPerSecondTotal + 1 } };
    expect(practiceLimits(louder, record)).toEqual({ ok: false, reason: 'public_practice_limit:max_requests_per_second_total<=10' });
    expect(practiceLimits({ ...config, runners: { ...config.runners, count: 7 } }, record).ok).toBe(false);
    expect(practiceLimits({ ...config, environment: 'staging' }, record).ok).toBe(false);
    const owner = authorisation('example-app-owner');
    expect(practiceLimits(louder, owner).ok).toBe(true);
  });
});

describe('example projects and journeys', () => {
  it('every example journey is valid for its project', () => {
    for (const site of readdirSync(join(root, 'examples/projects'))) {
      const config = project(site);
      const journeysDir = existsSync(join(root, 'examples/projects', site, 'journeys'))
        ? join(root, 'examples/projects', site, 'journeys')
        : join(root, 'examples/journeys', site);
      const files = readdirSync(journeysDir).filter((file) => file.endsWith('.yaml'));
      expect(files.length, site).toBeGreaterThan(0);
      for (const file of files) {
        const checked = validateJourneyDocument(readYaml(join(journeysDir, file)), config);
        expect(checked.errors, `${site}/${file}`).toEqual([]);
        for (const label of checked.journey?.users ?? []) expect(config.users.map((user) => user.label), `${site}/${file}`).toContain(label);
      }
    }
  });

  it('keeps practice passwords out of the repo: journeys use handles and the setup script reads the site', () => {
    const config = project('the-internet');
    const dir = join(root, 'examples/projects', 'the-internet', 'journeys');
    for (const file of readdirSync(dir)) {
      const steps = (readYaml(join(dir, file)) as { steps: Record<string, { selector?: string; value?: string; credential?: string }>[] }).steps;
      for (const fill of steps.flatMap((step) => (step.fill ? [step.fill] : []))) {
        if (fill.selector === config.auth.selectors.password) {
          // A literal is only allowed as a deliberately wrong password.
          if (fill.value !== undefined) expect(fill.value, file).toMatch(/not-the-password/);
          else expect(fill.credential, file).toMatch(/^self\.|^qa-user-\d+\./);
        }
      }
    }
    const script = readFileSync(join(root, 'scripts/setup-practice.mjs'), 'utf8');
    expect(script).not.toMatch(/password:\s*['"`]/);
  });
});

describe('self credential handles', () => {
  it('resolve to the label that runs the journey', () => {
    expect(resolveSelf('self.password', 'qa-user-3')).toBe('qa-user-3.password');
    expect(resolveSelf('self', 'qa-user-3')).toBe('qa-user-3');
    expect(resolveSelf('qa-user-1.username', 'qa-user-3')).toBe('qa-user-1.username');
  });

  it('are accepted by the validator for credentials and TOTP', () => {
    const config = project('the-internet');
    const checked = validateJourneyDocument(
      {
        version: 1,
        id: 'self-check',
        name: 'Self',
        users: ['qa-user-1'],
        steps: [
          { navigate: { url: '/login' } },
          { fill: { selector: '#username', credential: 'self.username' } },
          { fill: { selector: '#otp', totp: 'self' } },
        ],
      },
      config,
    );
    expect(checked.errors).toEqual([]);
  });
});

describe('setup-practice script', () => {
  it('installs The Internet into a fresh home with two stored logins and a ready swarm board', () => {
    const placeholder = 'practice-placeholder-pass';
    const swarmHome = join(homedir(), '.hornet-swarm');
    const home = mkdtempSync(join(swarmHome, 'work-practice-'));
    const out = execFileSync(process.execPath, [join(root, 'scripts/setup-practice.mjs'), 'the-internet', '--no-statement'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AEGIS_HOME: home, HORNET_PRACTICE_PASSWORD: placeholder },
    });
    expect(out).toContain('Installed the-internet with 2 logins.');
    expect(out).not.toContain(placeholder);
    expect(listLabels('the-internet', home).sort()).toEqual(['qa-user-1', 'qa-user-2']);
    expect(listFields('the-internet', 'qa-user-2', home).sort()).toEqual(['password', 'username']);
    const store = readFileSync(join(home, 'projects/the-internet/secrets.sops.yaml'), 'utf8');
    expect(store).not.toContain(placeholder);
    expect(store).not.toContain('tomsmith');
    const board = JSON.parse(readFileSync(join(home, 'projects/the-internet/swarm.json'), 'utf8')) as { ready: boolean; website: string; agents: { label: string; rules: string }[] };
    expect(board.ready).toBe(true);
    expect(board.website).toBe('https://the-internet.herokuapp.com');
    expect(board.agents).toHaveLength(2);
    expect(board.agents.every((agent) => agent.rules.includes('Never ask for, type, or repeat a password.'))).toBe(true);
    const auth = authorisationSchema.parse(readYaml(join(home, 'authorisations/the-internet-practice.yaml')));
    expect(Date.parse(auth.valid_until)).toBeGreaterThan(Date.now());
    expect(readdirSync(join(home, 'projects/the-internet/journeys')).sort()).toEqual([
      'dynamic-loading.journey.yaml',
      'secure-area.journey.yaml',
      'status-codes.journey.yaml',
      'wrong-password.journey.yaml',
    ]);
  });
});

describe('what the first live runs taught the reports', () => {
  const phase = (label: string, status: 'pass' | 'fail', error?: string) => ({
    label,
    phase1: { status, duration_ms: 100, ...(error ? { error } : {}) },
    journeys: [],
  });

  it('names the one account that was refused instead of saying sign-in did not work', () => {
    const text = summaryMarkdown([phase('qa-user-1', 'pass'), phase('qa-user-2', 'fail', 'url did not match (page said: "Your account is locked out.")')], 'failed');
    expect(text).toContain('Sign-in failed for qa-user-2 (1 of 2 accounts). The other accounts signed in.');
    expect(text).toContain('locked out');
    expect(text).not.toContain('Sign-in did not work');
  });

  it('calls a page that never finished loading a stalled page, not a broken sign-in', () => {
    const stalled = 'page.goto: Timeout 15000ms exceeded.\nCall log:\n  - navigating to "https://site.test/login", waiting until "domcontentloaded"\n';
    const text = summaryMarkdown([phase('qa-user-1', 'fail', stalled)], 'failed');
    expect(text).toContain('did not finish loading in time');
    expect(text).not.toContain('Call log');
    const result = diagnose([phase('qa-user-1', 'fail', stalled)], 'failed');
    expect(result.suspected).toBe('qa-user-1 · the sign-in page did not finish loading within 15 seconds.');
    expect(result.next.join(' ')).toContain('runners.http2: false');
  });

  it('turns HTTP/2 off in the browser only when the project asks', () => {
    expect(browserLaunchOptions().args).not.toContain('--disable-http2');
    expect(browserLaunchOptions({ http2: false }).args).toContain('--disable-http2');
    expect(project('the-internet').runners.http2).toBe(false);
    expect(project('juice-shop-lab').runners.http2).toBe(true);
  });
});
