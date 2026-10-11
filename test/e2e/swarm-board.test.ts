import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSwarm, saveSwarmBoard, startCredentialPage } from '../../packages/controller/dist/index.js';
import { home, root } from './helper.js';

const project = 'board';
const password = 'BoardOnly-s3cret"<&value>';
const projectDir = join(home, 'projects', project);

beforeAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  const source = readFileSync(join(home, 'projects/fixture/project.yaml'), 'utf8').replace(/^id: fixture$/m, 'id: board');
  writeFileSync(join(projectDir, 'project.yaml'), source);
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('swarm board', () => {
  it('shows ten login cards and a Ready button', async () => {
    const page = await startCredentialPage(home, 7791);
    try {
      const response = await fetch('http://127.0.0.1:7791/setup?project=board');
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('>Ready<');
      expect(html).toContain('qa-user-10');
      expect(html).toContain('name="password_1"');
      expect(html).toContain('name="personality_10"');
      expect(html).toContain('name="selector_username"');
      expect(html).toContain('#email');
      expect(html).toContain('value="/dashboard"');
      expect(html).not.toContain(password);
    } finally {
      await page.close();
    }
  });

  it('stores the website and personalities for agents, and keeps the password out of that view', () => {
    const view = saveSwarmBoard(
      {
        project,
        website: 'http://127.0.0.1:4173/login',
        cards: [
          { username: 'qa1@example.test', password, personality: 'Careful first visitor' },
          { username: 'qa2@example.test', password: 'other-board-secret', personality: password },
          { username: '', password: '', personality: '' },
        ],
      },
      home,
    );
    expect(view.ready).toBe(true);
    expect(view.website).toBe('http://127.0.0.1:4173/login');
    expect(view.agents.map((agent) => agent.label)).toEqual(['qa-user-1', 'qa-user-2']);
    expect(view.agents[0]?.personality).toBe('Careful first visitor');
    expect(view.agents[1]?.personality).toBe('[REDACTED:qa-user-1.password]');
    const visible = JSON.stringify(readSwarm(project, home));
    expect(visible).not.toContain('BoardOnly-s3cret');
    expect(visible).not.toContain('other-board-secret');
    const projectText = readFileSync(join(projectDir, 'project.yaml'), 'utf8');
    expect(projectText).toContain('http://127.0.0.1:4173/login');
    expect(projectText).toContain('Careful first visitor');
    expect(projectText).not.toContain('BoardOnly-s3cret');
    const cli = execFileSync(process.execPath, [join(root, 'packages/cli/dist/main.js'), 'swarm', '--project', project, '--json'], {
      encoding: 'utf8',
    });
    expect(cli).not.toContain('BoardOnly-s3cret');
    expect(JSON.parse(cli).ready).toBe(true);
  });

  it('refuses a website that is not authorised', () => {
    expect(() =>
      saveSwarmBoard(
        {
          project,
          website: 'https://example.com/',
          cards: [{ username: 'board-user', password: 'nope-long', personality: 'curious' }],
        },
        home,
      ),
    ).toThrow(/not authorised/);
  });

  it('refuses fixture selectors on a non-fixture host and stores selectors for an authorised host', () => {
    const authFile = join(home, 'authorisations/selector-owner.yaml');
    const projectFile = join(projectDir, 'project.yaml');
    const original = readFileSync(projectFile, 'utf8');
    writeFileSync(
      authFile,
      `id: selector-owner
basis: owner
client: self
authoriser: { name: Aron Amos, role: Owner, email: aron.amos@ironadamant.com }
granted_to: Aron Amos
scope:
  domains: [localhost, selectors.example]
  environments: [test]
activities: [signin_smoke]
exclusions: []
valid_from: "2026-01-01"
valid_until: "2027-12-31"
document: { path: local.txt, sha256: "0000000000000000000000000000000000000000000000000000000000000000" }
`,
    );
    writeFileSync(projectFile, original.replace('authorisation_id: fixture-owner', 'authorisation_id: selector-owner'));
    try {
      expect(() =>
        saveSwarmBoard(
          {
            project,
            website: 'https://selectors.example/login',
            cards: [{ username: 'board-user', password: 'nope-selector', personality: 'curious' }],
            selectors: { username: '#email', password: '#password', submit: "role=button[name='Sign in']", success: '/dashboard' },
          },
          home,
        ),
      ).toThrow(/practice site/);
      const view = saveSwarmBoard(
        {
          project,
          website: 'https://selectors.example/login',
          cards: [{ username: 'board-user', password: 'nope-selector', personality: 'curious' }],
          selectors: { username: '#user', password: '#pass', submit: "role=button[name='Continue']", success: '/home' },
        },
        home,
      );
      expect(view.ready).toBe(true);
      const saved = readFileSync(projectFile, 'utf8');
      expect(saved).toContain('#user');
      expect(saved).toContain('#pass');
      expect(saved).toContain('/home');
      expect(saved).not.toContain('nope-selector');
      expect(JSON.stringify(readSwarm(project, home))).not.toContain('nope-selector');
    } finally {
      writeFileSync(projectFile, original);
      rmSync(authFile, { force: true });
    }
  });
});

