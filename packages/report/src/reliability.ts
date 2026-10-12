import type { RunResult } from '@hornet-swarm/core';

export type ReliabilityRow = {
  id: string;
  attempts: number;
  passed: number;
  failed: number;
  flaky: number;
  blocked: number;
  errors: number;
  skipped: number;
  /** Passed attempts over attempts that reached a verdict. Blocked, error, and skipped attempts are left out. */
  pass_rate: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  last_status: string;
  /** Verdicts since the last pass that were fail or flaky. */
  failing_streak: number;
};

export type ReliabilityReport = {
  project: string;
  runs: number;
  first_run: string | null;
  last_run: string | null;
  run_statuses: Record<string, number>;
  signin: ReliabilityRow;
  journeys: ReliabilityRow[];
  notes: string[];
};

type Sample = { status: string; duration: number };

/**
 * Reliability over many runs, oldest first. One attempt is one account running one journey, or
 * one sign-in. Timings use attempts that passed, so a timeout does not skew the percentiles.
 */
export function summarizeReliability(project: string, runs: RunResult[]): ReliabilityReport {
  const ordered = [...runs].sort((left, right) => left.started_at.localeCompare(right.started_at));
  const signin: Sample[] = [];
  const journeys = new Map<string, Sample[]>();
  const statuses: Record<string, number> = {};
  for (const run of ordered) {
    statuses[run.status] = (statuses[run.status] ?? 0) + 1;
    for (const user of run.users) {
      signin.push({ status: user.phase1.status, duration: user.phase1.duration_ms });
      for (const journey of user.journeys) {
        const samples = journeys.get(journey.id) ?? [];
        samples.push({ status: journey.status, duration: journey.duration_ms });
        journeys.set(journey.id, samples);
      }
    }
  }
  const rows = [...journeys.entries()].map(([id, samples]) => row(id, samples)).sort((left, right) => (left.pass_rate ?? 2) - (right.pass_rate ?? 2) || left.id.localeCompare(right.id));
  const notes: string[] = [];
  if (ordered.length < 5) notes.push('Fewer than five runs. Run the checks more times before trusting these rates.');
  for (const entry of rows) {
    if (entry.failing_streak >= 2) notes.push(`${entry.id} has failed ${entry.failing_streak} times in a row.`);
    else if (entry.flaky > 0) notes.push(`${entry.id} passed only on a retry ${entry.flaky} time${entry.flaky === 1 ? '' : 's'}.`);
  }
  const signinRow = row('sign-in', signin);
  if (signinRow.pass_rate !== null && signinRow.pass_rate < 1) notes.push(`Sign-in passed ${Math.round(signinRow.pass_rate * 100)}% of the time.`);
  return {
    project,
    runs: ordered.length,
    first_run: ordered[0]?.started_at ?? null,
    last_run: ordered[ordered.length - 1]?.started_at ?? null,
    run_statuses: statuses,
    signin: signinRow,
    journeys: rows,
    notes,
  };
}

function row(id: string, samples: Sample[]): ReliabilityRow {
  const count = (status: string) => samples.filter((sample) => sample.status === status).length;
  const passed = count('pass');
  const failed = count('fail');
  const flaky = count('flaky');
  const verdicts = passed + failed + flaky;
  const timings = samples.filter((sample) => sample.status === 'pass').map((sample) => sample.duration).sort((left, right) => left - right);
  let streak = 0;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const status = samples[index]?.status;
    if (status === 'pass') break;
    if (status === 'fail' || status === 'flaky') streak += 1;
  }
  return {
    id,
    attempts: samples.length,
    passed,
    failed,
    flaky,
    blocked: count('blocked'),
    errors: count('error'),
    skipped: count('skipped'),
    pass_rate: verdicts === 0 ? null : Math.round((passed / verdicts) * 1000) / 1000,
    p50_ms: percentile(timings, 0.5),
    p95_ms: percentile(timings, 0.95),
    last_status: samples[samples.length - 1]?.status ?? 'none',
    failing_streak: streak,
  };
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function reliabilityMarkdown(report: ReliabilityReport): string {
  const pct = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);
  const ms = (value: number | null) => (value === null ? '-' : `${value} ms`);
  const line = (entry: ReliabilityRow) =>
    `| ${entry.id} | ${entry.attempts} | ${pct(entry.pass_rate)} | ${entry.failed} | ${entry.flaky} | ${entry.blocked} | ${entry.errors} | ${ms(entry.p50_ms)} | ${ms(entry.p95_ms)} | ${entry.last_status} |`;
  return [
    `# Reliability for ${report.project}`,
    '',
    `${report.runs} run${report.runs === 1 ? '' : 's'}${report.first_run ? `, ${report.first_run} to ${report.last_run}` : ''}.`,
    '',
    '| Check | Attempts | Pass rate | Failed | Flaky | Blocked | Errors | p50 | p95 | Last |',
    '|---|---|---|---|---|---|---|---|---|---|',
    line(report.signin),
    ...report.journeys.map(line),
    '',
    ...(report.notes.length > 0 ? ['Notes:', ...report.notes.map((note) => `- ${note}`), ''] : []),
  ].join('\n');
}
