import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { hornet, clearSignins, home, resetFixture, secret } from './helper.js';

beforeAll(async () => {
  clearSignins();
  await resetFixture();
});

type Map = {
  url: string;
  title: string;
  headings: string[];
  fields: { kind: string; label: string; selector: string; checked: boolean }[];
  buttons: { text: string; selector: string }[];
  links: { text: string; href: string }[];
  text: string;
};

function inspect(args: string[]): { ok: boolean; page?: Map; screenshot?: string; error?: string; run_id: string } {
  const run = hornet(['inspect', '--project', 'fixture', '--user', 'qa-user-1', '--json', ...args]);
  try {
    return JSON.parse(run.stdout) as { ok: boolean; page?: Map; screenshot?: string; error?: string; run_id: string };
  } catch {
    throw new Error(`inspect printed no JSON: ${run.stdout} ${run.stderr}`);
  }
}

describe('inspecting a page to draft a journey', () => {
  it('maps a page as a guest, with a checked selector for each field and button', () => {
    const outcome = inspect(['--url', '/login', '--guest']);
    expect(outcome.ok, outcome.error).toBe(true);
    const page = outcome.page as Map;
    expect(page.title).toBe('Sign in');
    expect(page.headings).toContain('Sign in');
    const email = page.fields.find((field) => field.label === 'Email');
    expect(email).toMatchObject({ kind: 'text', selector: '#email', checked: true });
    expect(page.fields.find((field) => field.kind === 'password')?.selector).toBe('#password');
    // The hidden backup-code field is not something a person can see or fill.
    expect(page.fields.some((field) => field.selector.includes('backup-code'))).toBe(false);
    expect(page.buttons.find((button) => button.text === 'Sign in')?.selector).toBe('role=button[name="Sign in"]');
    expect(outcome.screenshot && existsSync(outcome.screenshot)).toBe(true);
  });

  it('signs in first for a page behind the login, and saves no password', () => {
    const outcome = inspect(['--url', '/projects', '--name', 'projects-page']);
    expect(outcome.ok, outcome.error).toBe(true);
    expect(outcome.page?.url).toContain('/projects');
    expect(outcome.page?.text).toContain('QA Smoke Project');
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(existsSync(join(home, 'runs', outcome.run_id, 'qa-user-1', 'inspect-projects-page', 'inspect-projects-page.json'))).toBe(true);
    // Inspections stay out of the project's journeys, so a suite never runs one.
    expect(readdirSync(join(home, 'projects', 'fixture', 'inspections'))).toContain('inspect-projects-page.journey.yaml');
  });

  it('leaves at most one browser profile in the runner after several jobs', () => {
    // Chrome writes its profile as the browser user, which Playwright cannot delete. Left behind,
    // the profiles filled the runner's small /tmp until Chrome could not start.
    inspect(['--url', '/login', '--guest', '--name', 'profile-check']);
    const count = execFileSync('docker', ['exec', 'hornet-swarm-fixture-qa-user-1', 'sh', '-c', 'ls -d /tmp/playwright_chromiumdev_profile-* 2>/dev/null | wc -l'], { encoding: 'utf8' }).trim();
    expect(Number(count)).toBeLessThanOrEqual(1);
  });

  it('refuses a page outside the allowed sites before opening anything', () => {
    const run = hornet(['inspect', '--project', 'fixture', '--user', 'qa-user-1', '--url', 'https://example.com/', '--guest', '--json']);
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/not allowed|allowed_origins|allowlist|origin/i);
  });
});
