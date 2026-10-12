import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearSignins, home, hornet, journeys, readRun } from './helper.js';

describe('request pacing versus allowlist and site overload', () => {
  it('keeps a passing journey passed when off-list requests are aborted, paces a burst without dropping it, and reports rate_limited when the site answers 429', async () => {
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
    expect(burst.status, burst.stdout + burst.stderr).toBe(0);
    const burstBody = JSON.parse(burst.stdout) as { status: string; parent: { status: string } };
    expect(burstBody.status).toBe('passed');
    expect(burstBody.parent.status).toBe('passed');
    expect(JSON.stringify(burstBody)).not.toContain('rate_limited');
    const afterBurst = await fetch('http://127.0.0.1:4173/__admin/stats').then((response) => response.json()) as { pingCount: number; burstPages: number };
    expect(afterBurst.burstPages).toBeGreaterThanOrEqual(1);
    // The runner paced the burst. It did not drop a single request.
    expect(afterBurst.pingCount - afterOff.pingCount).toBe(40);

    clearSignins();
    const overloaded = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'overload.journey.yaml')]);
    expect(overloaded.status, overloaded.stdout + overloaded.stderr).toBe(2);
    const overloadBody = JSON.parse(overloaded.stdout) as { status: string; parent: { status: string; summary: string } };
    expect(overloadBody.status).toBe('rate_limited');
    expect(overloadBody.parent.status).toBe('rate_limited');
    expect(overloadBody.parent.summary).toContain('HTTP 429 or 503');
    expect(readRun().result.status).toBe('rate_limited');
    clearSignins();
  });
});
