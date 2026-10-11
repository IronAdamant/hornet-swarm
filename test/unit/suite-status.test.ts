import { describe, expect, it } from 'vitest';
import { foldRunStatus, journeyFromJob, type JobReport } from '../../packages/controller/src/suite.ts';

function passedStep(): JobReport['steps'][number] {
  return {
    index: 0,
    type: 'assert',
    status: 'pass',
    duration_ms: 10,
    started_at: '2026-10-11T00:00:00+11:00',
    finished_at: '2026-10-11T00:00:01+11:00',
  };
}

describe('run status fold', () => {
  it('reports rate_limited when a passed journey job was stopped for the request budget', () => {
    const journey = journeyFromJob(
      { ok: false, status: 'rate_limited', blocked_reason: 'rate_limited', steps: [passedStep()], chaosApplied: [] },
      { id: 'flag-check', name: 'Ready flag is visible', tries: 0 },
    );
    expect(journey.status).toBe('blocked');
    expect(journey.blocked_reason).toBe('rate_limited');
    expect(journey.steps.every((step) => step.blocked_reason === undefined)).toBe(true);
    expect(
      foldRunStatus({
        killed: false,
        gatePassed: true,
        users: [{ phase1: { status: 'pass' }, journeys: [journey] }],
      }),
    ).toBe('rate_limited');
  });

  it('keeps an allowlist stop blocked and a failed journey failed', () => {
    const allowlist = journeyFromJob(
      { ok: false, status: 'blocked', blocked_reason: 'allowlist', steps: [{ ...passedStep(), status: 'blocked', blocked_reason: 'allowlist' }], chaosApplied: [] },
      { id: 'off', name: 'Off list', tries: 0 },
    );
    expect(
      foldRunStatus({
        killed: false,
        gatePassed: true,
        users: [{ phase1: { status: 'pass' }, journeys: [allowlist] }],
      }),
    ).toBe('blocked');
    const failed = journeyFromJob(
      { ok: false, status: 'failed', steps: [{ ...passedStep(), status: 'fail' }], chaosApplied: [] },
      { id: 'flag-check', name: 'Ready flag is visible', tries: 0 },
    );
    expect(
      foldRunStatus({
        killed: false,
        gatePassed: true,
        users: [{ phase1: { status: 'pass' }, journeys: [failed] }],
      }),
    ).toBe('failed');
  });

  it('duration stop with a passed phase and skipped journeys returns blocked', () => {
    expect(
      foldRunStatus({
        killed: false,
        gatePassed: true,
        durationStop: true,
        users: [{ phase1: { status: 'pass' }, journeys: [{ status: 'skipped', steps: [] }] }],
      }),
    ).toBe('blocked');
    const proxy = journeyFromJob(
      { ok: false, status: 'blocked', blocked_reason: 'proxy', steps: [{ ...passedStep(), status: 'blocked', blocked_reason: 'proxy' }], chaosApplied: [] },
      { id: 'proxy-check', name: 'Proxy', tries: 0 },
    );
    expect(
      foldRunStatus({
        killed: false,
        gatePassed: true,
        users: [{ phase1: { status: 'pass' }, journeys: [proxy] }],
      }),
    ).toBe('blocked');
  });
});
