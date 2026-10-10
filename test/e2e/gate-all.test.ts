import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { setSecret } from '../../packages/controller/dist/index.js';
import { aegis, clearSignins, home, journeys, otherSecret, readRun } from './helper.js';

beforeAll(() => {
  clearSignins();
});

describe('gate all', () => {
  it('skips earlier journeys when a later sign-in fails', () => {
    clearSignins();
    const up = aegis(['env', 'up', '--project', 'fixture', '--count', '2', '--json']);
    expect(up.status, up.stdout + up.stderr).toBe(0);
    let spoiled = false;
    try {
      setSecret('fixture', 'qa-user-2', 'password', 'wrong-password-value', home);
      spoiled = true;
      const run = aegis([
        'suite',
        '--project',
        'fixture',
        '--json',
        '--gate',
        'all',
        '--journey',
        join(journeys, 'both-users-flag.journey.yaml'),
      ]);
      expect(run.status, run.stdout + run.stderr).toBe(1);
      const report = readRun();
      const users = report.result.users as {
        label: string;
        phase1: { status: string };
        journeys: { id: string; status: string; steps: unknown[] }[];
      }[];
      expect(users.map((user) => user.label)).toEqual(['qa-user-1', 'qa-user-2']);
      expect(users[0]?.phase1.status).toBe('pass');
      expect(users[1]?.phase1.status).not.toBe('pass');
      expect(report.result.gate).toBe('all');
      expect(report.result.gate_passed).toBe(false);
      expect(users[0]?.journeys).toEqual([
        expect.objectContaining({ id: 'both-users-flag', status: 'skipped', steps: [] }),
      ]);
      expect(users[1]?.journeys.every((journey) => journey.status === 'skipped' && journey.steps.length === 0)).toBe(true);
    } finally {
      if (spoiled) setSecret('fixture', 'qa-user-2', 'password', otherSecret, home);
      const back = aegis(['env', 'up', '--project', 'fixture', '--count', '1', '--json']);
      expect(back.status, back.stdout + back.stderr).toBe(0);
    }
  });
});
