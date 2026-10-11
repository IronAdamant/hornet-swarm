import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aegisHome } from '../../packages/controller/src/home.ts';
import { applyReturnedJob, type JobReport } from '../../packages/controller/src/suite.ts';

describe('returned job after an in-flight stop', () => {
  it('stops the project when the kill file is present and the job response still returns', async () => {
    const killPath = join(aegisHome(), 'KILL');
    const before = existsSync(killPath);
    const calls: Array<{ project: string; label: string | undefined }> = [];
    const result = await applyReturnedJob({
      killPresent: true,
      report: passedReport(),
      projectId: 'fixture',
      label: 'qa-user-1',
      stopRunners: async (project, label) => {
        calls.push({ project, label });
      },
    });
    expect(result.killed).toBe(true);
    expect(result.report.status).toBe('blocked');
    expect(result.report.blocked_reason).toBe('kill');
    expect(calls).toEqual([{ project: 'fixture', label: undefined }]);
    expect(existsSync(killPath)).toBe(before);
    const scratch = mkdtempSync(join(tmpdir(), 'hornet-kill-'));
    expect(existsSync(join(scratch, 'KILL'))).toBe(false);
    console.log(JSON.stringify({ case: 'kill-file', killed: result.killed, blocked_reason: result.report.blocked_reason, stop: calls, killFileUnchanged: existsSync(killPath) === before, scratchHasKillFile: existsSync(join(scratch, 'KILL')) }));
  });

  it('stops the project when the abort reason is kill and the response still returns', async () => {
    const calls: Array<{ project: string; label: string | undefined }> = [];
    const result = await applyReturnedJob({
      abortReason: 'kill',
      killPresent: false,
      report: passedReport(),
      projectId: 'fixture',
      label: 'qa-user-1',
      stopRunners: async (project, label) => {
        calls.push({ project, label });
      },
    });
    expect(result.killed).toBe(true);
    expect(result.report.blocked_reason).toBe('kill');
    expect(calls).toEqual([{ project: 'fixture', label: undefined }]);
    console.log(JSON.stringify({ case: 'abort-kill', killed: result.killed, blocked_reason: result.report.blocked_reason, stop: calls }));
  });

  it('a duration stop stays on one label, stays unkilled, and writes no kill file', async () => {
    const killPath = join(aegisHome(), 'KILL');
    const before = existsSync(killPath);
    const calls: Array<{ project: string; label: string | undefined }> = [];
    const result = await applyReturnedJob({
      abortReason: 'duration',
      killPresent: false,
      report: passedReport(),
      projectId: 'fixture',
      label: 'qa-user-1',
      stopRunners: async (project, label) => {
        calls.push({ project, label });
      },
    });
    expect(result.killed).toBe(false);
    expect(result.report.blocked_reason).toBe('duration');
    expect(calls).toEqual([{ project: 'fixture', label: 'qa-user-1' }]);
    expect(existsSync(killPath)).toBe(before);
    const scratch = mkdtempSync(join(tmpdir(), 'hornet-duration-'));
    expect(existsSync(join(scratch, 'KILL'))).toBe(false);
    console.log(JSON.stringify({ case: 'duration', killed: result.killed, blocked_reason: result.report.blocked_reason, stop: calls, killFileUnchanged: existsSync(killPath) === before, scratchHasKillFile: existsSync(join(scratch, 'KILL')) }));
  });

  it('keeps a returned second-code result when a duration abort also fired', async () => {
    const calls: string[] = [];
    const result = await applyReturnedJob({
      abortReason: 'duration',
      killPresent: false,
      report: { ok: false, status: 'blocked', blocked_reason: '2fa', steps: [], chaosApplied: [] },
      projectId: 'fixture',
      label: 'qa-user-1',
      stopRunners: async () => {
        calls.push('stopped');
      },
    });
    expect(result.killed).toBe(false);
    expect(result.report.blocked_reason).toBe('2fa');
    expect(calls).toEqual([]);
    console.log(JSON.stringify({ case: 'duration-keeps-2fa', killed: result.killed, blocked_reason: result.report.blocked_reason, stop: calls }));
  });
});

function passedReport(): JobReport {
  return { ok: true, status: 'passed', steps: [], chaosApplied: [] };
}
