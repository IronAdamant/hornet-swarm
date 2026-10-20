import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETEST_INTERVAL_DAYS, writePrivateFile } from '@hornet-swarm/core';
import { writeAudit } from './audit.js';
import { savedJobReports, writeClientReport, writeRetestDiff, type LoadedJob, type WrittenClientReport, type WrittenRetestDiff } from './client-report-service.js';
import { aegisHome } from './home.js';
import { runSuite } from './suite.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A scheduler may call --if-due hourly. An attempt that left no report waits this long, so a failing job does not re-run the swarm against the client's site every hour. */
const FAILED_ATTEMPT_BACKOFF_MS = DAY_MS;

function attemptPath(home: string, jobId: string): string {
  return join(home, 'retests', `${jobId}.last-attempt`);
}

function lastAttempt(home: string, jobId: string): number | undefined {
  const path = attemptPath(home, jobId);
  if (!existsSync(path)) return undefined;
  const at = Date.parse(readFileSync(path, 'utf8').trim());
  return Number.isNaN(at) ? undefined : at;
}

export type RetestDue = { due: boolean; last_tested_at?: string; next_due_at?: string; reason: string };

/** Whether the job's cadence has passed since its last saved client report. A job with no report is due. */
export function retestDue(home: string, loaded: LoadedJob, now = new Date()): RetestDue {
  const reports = savedJobReports(home, loaded.job.id);
  const last = reports[reports.length - 1];
  const attempted = lastAttempt(home, loaded.job.id);
  if (attempted !== undefined && (!last || attempted > Date.parse(last.tested_at)) && now.getTime() < attempted + FAILED_ATTEMPT_BACKOFF_MS) {
    const retry = new Date(attempted + FAILED_ATTEMPT_BACKOFF_MS).toISOString();
    return { due: false, next_due_at: retry, reason: `${loaded.job.id} was last attempted ${new Date(attempted).toISOString()} without a new report. It is tried again from ${retry}.` };
  }
  if (!last) return { due: true, reason: `${loaded.job.id} has no saved report yet.` };
  const days = RETEST_INTERVAL_DAYS[loaded.job.schedule.cadence];
  const next = new Date(Date.parse(last.tested_at) + days * DAY_MS);
  const due = now.getTime() >= next.getTime();
  return {
    due,
    last_tested_at: last.tested_at,
    next_due_at: next.toISOString(),
    reason: due ? `${loaded.job.id} was last tested ${last.tested_at}, more than ${days} days ago.` : `${loaded.job.id} is next due ${next.toISOString()}.`,
  };
}

export type RetestOutcome =
  | { ran: false; due: RetestDue }
  | { ran: true; run_id: string; status: string; report?: WrittenClientReport; diff?: WrittenRetestDiff; not_reported?: string };

/**
 * Re-runs a saved job: its journeys on its accounts, through the same authorised suite as any
 * other run, then writes the client report and the comparison with the previous report.
 * A run that failed its redaction check gets neither, because it must not be shared.
 */
export async function runRetest(input: { job: LoadedJob; home?: string; ifDue?: boolean; against?: string; confirmProduction?: boolean; agentId?: string; via?: 'cli' | 'mcp'; now?: Date }): Promise<RetestOutcome> {
  const home = input.home ?? aegisHome();
  const { job } = input.job;
  if (input.ifDue) {
    const due = retestDue(home, input.job, input.now);
    if (!due.due) return { ran: false, due };
  }
  writePrivateFile(attemptPath(home, job.id), `${(input.now ?? new Date()).toISOString()}\n`);
  const result = await runSuite({
    project: job.project,
    home,
    journeyFiles: job.journeys.map((journey) => journey.id),
    journeyPathsAllowed: false,
    includeRegressions: false,
    confirmProduction: Boolean(input.confirmProduction),
    via: input.via ?? 'cli',
    ...(job.users ? { users: job.users } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  });
  if (result.status === 'redaction_failure' || result.redaction === 'fail') {
    writeAudit({ interface: input.via ?? 'cli', action: 'retest', project: job.project, run_id: result.run_id, result: 'not_reported_redaction_failure' }, undefined, home);
    return { ran: true, run_id: result.run_id, status: result.status, not_reported: 'The run failed its redaction check, so no client report was written. Fix it and run again.' };
  }
  const report = writeClientReport({ job: input.job, runId: result.run_id, home });
  const diff = writeRetestDiff({ job: input.job, runId: result.run_id, home, ...(input.against ? { against: input.against } : {}) });
  writeAudit({ interface: input.via ?? 'cli', action: 'retest', project: job.project, run_id: result.run_id, result: diff.diff ? 'reported_with_diff' : 'reported' }, undefined, home);
  return { ran: true, run_id: result.run_id, status: result.status, report, diff };
}
