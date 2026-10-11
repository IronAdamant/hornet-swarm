import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearSignins, home, hornet, journeys, readRun } from './helper.js';

describe('request bucket versus allowlist', () => {
  it('keeps a passing journey passed when off-list requests are aborted, and reports rate_limited when the bucket trips', async () => {
    clearSignins();
    const off = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'offlist-pass.journey.yaml')]);
    expect(off.status, off.stdout + off.stderr).toBe(0);
    const offBody = JSON.parse(off.stdout) as { status: string; run_id: string; parent: { status: string }; users: { journeys: { id: string; status: string; steps: { status: string; blocked_reason?: string }[] }[] }[] };
    expect(offBody.status).toBe('passed');
    expect(offBody.parent.status).toBe('passed');
    expect(JSON.stringify(offBody)).not.toContain('rate_limited');
    const offRun = readRun();
    expect(offRun.result.status).toBe('passed');
    const harPath = join(home, 'runs', offBody.run_id, 'qa-user-1', 'offlist-pass', 'network.har');
    expect(existsSync(harPath), harPath).toBe(true);
    const har = readFileSync(harPath, 'utf8');
    expect(har).toContain('off-list.invalid');
    const afterOff = await fetch('http://127.0.0.1:4173/__admin/stats').then((response) => response.json()) as { pingCount: number; offlistPages: number; burstPages: number };
    expect(afterOff.offlistPages).toBeGreaterThanOrEqual(1);
    expect(afterOff.pingCount).toBeGreaterThanOrEqual(12);

    clearSignins();
    const burst = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'burst-budget.journey.yaml')]);
    expect(burst.status, burst.stdout + burst.stderr).toBe(2);
    const burstBody = JSON.parse(burst.stdout) as { status: string; parent: { status: string }; users: { journeys: { id: string; status: string; steps: { status: string; blocked_reason?: string }[] }[] }[] };
    expect(burstBody.status).toBe('rate_limited');
    expect(burstBody.parent.status).toBe('rate_limited');
    const journey = burstBody.users[0]?.journeys.find((entry) => entry.id === 'burst-budget');
    expect(journey?.steps.every((step) => step.status === 'pass' && step.blocked_reason === undefined)).toBe(true);
    expect(JSON.stringify(burstBody)).not.toContain('allowlist');
    expect(readRun().result.status).toBe('rate_limited');
    const afterBurst = await fetch('http://127.0.0.1:4173/__admin/stats').then((response) => response.json()) as { pingCount: number; burstPages: number };
    expect(afterBurst.burstPages).toBeGreaterThanOrEqual(1);
    expect(afterBurst.pingCount - afterOff.pingCount).toBeLessThan(40);
    clearSignins();
  });
});
