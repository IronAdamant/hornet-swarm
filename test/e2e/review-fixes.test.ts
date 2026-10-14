import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSecret } from '../../packages/controller/dist/index.js';
import { clearSignins, home, hornet, journeys, readRun, resetFixture, root, secret } from './helper.js';

const authPath = join(home, 'authorisations/fixture-owner.yaml');
const documentFile = join(home, 'authorisations/fixture-owner.txt');

beforeAll(async () => {
  clearSignins();
  await resetFixture({ failFlag: false });
  const up = hornet(['env', 'up', '--project', 'fixture', '--json']);
  expect(up.status, up.stdout + up.stderr).toBe(0);
});

afterAll(async () => {
  await resetFixture({ failFlag: false });
  clearSignins();
});

describe('review fixes on the offline fixture', () => {
  it('records no regression from a single journey run', async () => {
    await resetFixture({ failFlag: true });
    try {
      const single = hornet(['journey', join(journeys, 'flag.journey.yaml'), '--project', 'fixture', '--json']);
      expect(single.status, single.stdout).toBe(1);
      expect(existsSync(join(home, 'regressions/fixture/flag-check.journey.yaml'))).toBe(false);
    } finally {
      await resetFixture({ failFlag: false });
    }
  });

  it('runs a journey that does not need the sign-in check when sign-in fails, and skips one that does', () => {
    setSecret('fixture', 'qa-user-1', 'password', 'wrong-password-value', home);
    try {
      const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'offlist-pass.journey.yaml'), '--journey', join(journeys, 'flag.journey.yaml')]);
      expect(run.status, run.stdout).toBe(1);
      const users = readRun().result.users as { phase1: { status: string }; journeys: { id: string; status: string }[] }[];
      expect(users[0]?.phase1.status).not.toBe('pass');
      expect(users[0]?.journeys.find((journey) => journey.id === 'offlist-pass')?.status).toBe('pass');
      expect(users[0]?.journeys.find((journey) => journey.id === 'flag-check')?.status).toBe('skipped');
    } finally {
      setSecret('fixture', 'qa-user-1', 'password', secret, home);
      clearSignins();
    }
  });

  it('refuses a journey or an access check that the authorisation does not list', () => {
    const original = readFileSync(authPath, 'utf8');
    try {
      writeFileSync(authPath, original.replace('[signin_smoke, functional_e2e, access_control_checks, chaos]', '[signin_smoke, access_control_checks]'));
      const journey = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'flag.journey.yaml')]);
      expect(journey.status).toBe(3);
      expect(journey.stdout).toContain('activity_not_authorised:functional_e2e:flag-check');
      writeFileSync(authPath, original.replace('[signin_smoke, functional_e2e, access_control_checks, chaos]', '[signin_smoke, functional_e2e]'));
      const isolation = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(root, 'examples/journeys/example-app/02-tenant-isolation.journey.yaml')]);
      expect(isolation.status).toBe(3);
      expect(isolation.stdout).toContain('activity_not_authorised:access_control_checks:tenant-isolation');
    } finally {
      writeFileSync(authPath, original);
    }
  });

  it('refuses to run when the signed document changed, and auth check names its real hash', () => {
    const original = readFileSync(documentFile, 'utf8');
    try {
      expect(hornet(['auth', 'check', 'fixture-owner', '--json']).status).toBe(0);
      writeFileSync(documentFile, `${original}A line added later.\n`);
      const run = hornet(['sign-in', '--project', 'fixture', '--json']);
      expect(run.status).toBe(3);
      expect(run.stdout).toContain('authorisation_document_mismatch');
      const check = hornet(['auth', 'check', 'fixture-owner', '--json']);
      expect(check.status).toBe(3);
      expect(check.stdout).toMatch(/has sha256 [0-9a-f]{64}/);
    } finally {
      writeFileSync(documentFile, original);
    }
  });
});
