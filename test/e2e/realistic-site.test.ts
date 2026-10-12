import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { hornet, clearSignins, containsSecret, home, journeys, latestRun, readRun, resetFixture, secret } from './helper.js';

type Stats = { assetHits: number; spaLogins: number };

const stats = (): Promise<Stats> => fetch('http://127.0.0.1:4173/__admin/stats').then((response) => response.json() as Promise<Stats>);

beforeAll(async () => {
  clearSignins();
  await resetFixture();
});

describe('a site that looks like a real one', () => {
  it('signs in to a single-page app that changes the URL with pushState and renders late', async () => {
    const before = await stats();
    const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'spa-login.journey.yaml')]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).status).toBe('passed');
    expect((await stats()).spaLogins - before.spaLogins).toBe(1);
    expect(run.stdout).not.toContain(secret);
  });

  it('loads every resource of a heavy page and ignores captcha scripts nobody can see', async () => {
    clearSignins();
    const before = await stats();
    const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'heavy.journey.yaml')]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const body = JSON.parse(run.stdout) as { status: string; users: { journeys: { id: string; status: string; steps: { blocked_reason?: string }[] }[] }[] };
    expect(body.status).toBe('passed');
    const journey = body.users[0]?.journeys.find((entry) => entry.id === 'heavy-page');
    expect(journey?.status).toBe('pass');
    expect(JSON.stringify(journey)).not.toMatch(/captcha|2fa|rate_limited/);
    // 50 images, 10 scripts, 5 stylesheets. Nothing was dropped by the harness.
    expect((await stats()).assetHits - before.assetHits).toBe(65);
  });

  it('leaves no form-encoded password in the run or the runner folder, and keeps trace frames intact', async () => {
    clearSignins();
    const run = hornet(['sign-in', '--project', 'fixture', '--json', '--user', 'qa-user-1']);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const dir = latestRun();
    const report = readRun(dir);
    expect(report.result.redaction).toBe('pass');
    expect(await containsSecret(dir)).toEqual([]);

    // The HTML login form posts application/x-www-form-urlencoded. That body is dropped as an auth endpoint.
    const harFile = join(dir, 'qa-user-1', 'phase1', 'network.har');
    const har = JSON.parse(readFileSync(harFile, 'utf8')) as { log: { entries: { request: { url: string; method: string; postData?: { text?: string }; headers: { name: string; value: string }[] } }[] } };
    const login = har.log.entries.find((entry) => entry.request.method === 'POST' && entry.request.url.endsWith('/login'));
    expect(login?.request.postData?.text).toBe('[REDACTED:auth_endpoint]');
    for (const entry of har.log.entries) {
      for (const header of entry.request.headers) if (header.name.toLowerCase() === 'cookie') expect(header.value).toBe('[REDACTED:header]');
    }

    // The runner folder copy is moved, not left behind with an unredacted trace.
    const runId = report.result.run_id as string;
    expect(existsSync(join(home, 'runners', 'fixture', 'qa-user-1', runId))).toBe(false);

    const trace = await JSZip.loadAsync(readFileSync(join(dir, 'qa-user-1', 'phase1', 'trace.zip')));
    const frames = Object.keys(trace.files).filter((name) => /\.jpe?g$/i.test(name));
    expect(frames.length).toBeGreaterThan(0);
    let intactJpegs = 0;
    for (const name of frames) {
      const bytes = await trace.files[name]!.async('nodebuffer');
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
      const placeholder = bytes.subarray(1, 4).toString('latin1') === 'PNG';
      expect(jpeg || placeholder, name).toBe(true);
      if (jpeg) intactJpegs += 1;
    }
    expect(intactJpegs).toBeGreaterThan(0);
  });

  it('reports reliability across the runs so far', () => {
    const stats = hornet(['stats', '--project', 'fixture', '--json', '--last', '50']);
    expect(stats.status, stats.stdout + stats.stderr).toBe(0);
    const report = JSON.parse(stats.stdout) as { runs: number; signin: { attempts: number; pass_rate: number | null }; journeys: { id: string; pass_rate: number | null }[] };
    expect(report.runs).toBeGreaterThan(0);
    expect(report.signin.attempts).toBeGreaterThan(0);
    expect(report.journeys.some((entry) => entry.id === 'heavy-page' && entry.pass_rate !== null)).toBe(true);
    const text = hornet(['stats', '--project', 'fixture']);
    expect(text.stdout).toContain('| sign-in |');
    expect(readdirSync(join(home, 'runs')).length).toBeGreaterThan(0);
  });
});
