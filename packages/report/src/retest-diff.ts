import { assertNoComplianceClaim } from '@hornet-swarm/core';
import { reportDate } from './client-report-builder.js';
import { clientReportSchema, type ClientIssue, type ClientJourneyResult, type ClientReport } from './client-report-model.js';

type IssueLine = { key: string; id: string; title: string; severity: ClientIssue['severity'] };
type JourneyChange = { kind: ClientJourneyResult['kind']; title: string; before: ClientJourneyResult['status']; now: ClientJourneyResult['status']; summary: string };

export type RetestDiff = {
  job_id: string;
  previous_run: string;
  current_run: string;
  previous_tested_at: string;
  current_tested_at: string;
  new_issues: IssueLine[];
  fixed: IssueLine[];
  still_open: (IssueLine & { previous_severity: ClientIssue['severity']; places_before: number; places_now: number })[];
  /** Open last time, but none of its pages or journeys was checked this time, so it is neither fixed nor open. */
  not_rechecked: IssueLine[];
  withdrawn_since: IssueLine[];
  journey_regressions: JourneyChange[];
  journey_fixes: JourneyChange[];
  journey_not_rechecked: JourneyChange[];
};

const places = (issue: ClientIssue) => issue.where.reduce((sum, entry) => sum + entry.places, 0);
const line = (issue: ClientIssue): IssueLine => ({ key: issue.key, id: issue.id, title: issue.title, severity: issue.severity });

/** Compares two client reports of the same job by each issue's re-test key and each journey's result. */
export function diffClientReports(previousInput: ClientReport, currentInput: ClientReport): RetestDiff {
  const previous = clientReportSchema.parse(previousInput);
  const current = clientReportSchema.parse(currentInput);
  if (previous.job_id !== current.job_id) throw new Error(`Cannot compare job ${previous.job_id} with job ${current.job_id}.`);
  const now = new Map(current.issues.map((issue) => [issue.key, issue]));
  const before = new Map(previous.issues.map((issue) => [issue.key, issue]));
  const pagesNow = new Set(current.pages_tested.map((page) => page.name));
  const journeysNow = new Map(current.journeys.map((journey) => [journey.kind === 'other' ? journey.journeys.join() : journey.kind, journey]));
  const withdrawnNow = new Set(current.withdrawn.map((entry) => entry.key));
  const diff: RetestDiff = {
    job_id: current.job_id,
    previous_run: previous.run_id,
    current_run: current.run_id,
    previous_tested_at: previous.tested_at,
    current_tested_at: current.tested_at,
    new_issues: current.issues.filter((issue) => !before.has(issue.key)).map(line),
    fixed: [],
    still_open: [],
    not_rechecked: [],
    withdrawn_since: [],
    journey_regressions: [],
    journey_fixes: [],
    journey_not_rechecked: [],
  };
  for (const issue of previous.issues) {
    const open = now.get(issue.key);
    if (open) {
      diff.still_open.push({ ...line(open), previous_severity: issue.severity, places_before: places(issue), places_now: places(open) });
      continue;
    }
    if (withdrawnNow.has(issue.key)) {
      diff.withdrawn_since.push(line(issue));
      continue;
    }
    const rechecked = issue.source === 'journey' ? journeyRechecked(issue, previous, journeysNow) : issue.where.some((entry) => pagesNow.has(entry.page));
    (rechecked ? diff.fixed : diff.not_rechecked).push(line(issue));
  }
  for (const journey of previous.journeys) {
    const key = journey.kind === 'other' ? journey.journeys.join() : journey.kind;
    const latest = journeysNow.get(key);
    if (!latest) continue;
    const change = { kind: journey.kind, title: journey.title, before: journey.status, now: latest.status, summary: latest.summary };
    if (journey.status === 'worked' && latest.status === 'failed') diff.journey_regressions.push(change);
    else if (journey.status === 'failed' && latest.status === 'worked') diff.journey_fixes.push(change);
    else if ((journey.status === 'worked' || journey.status === 'failed') && (latest.status === 'blocked' || latest.status === 'not_tested')) diff.journey_not_rechecked.push(change);
  }
  return diff;
}

function journeyRechecked(issue: ClientIssue, previous: ClientReport, journeysNow: Map<string, ClientJourneyResult>): boolean {
  const kind = issue.key.replace(/^journey:/, '');
  const earlier = previous.journeys.find((journey) => journey.kind === kind || (journey.kind === 'other' && journey.journeys.includes(issue.where[0]?.page ?? '')));
  const key = earlier ? (earlier.kind === 'other' ? earlier.journeys.join() : earlier.kind) : kind;
  const latest = journeysNow.get(key);
  return latest?.status === 'worked';
}

/** The re-test comparison an owner reads each month, under the same brand as the report. */
function permissionLine(auth: ClientReport['authorisation']): string {
  if (auth.basis === 'public_practice') return `Testing was done under the site's published permission for test practice${auth.public_statement_url ? ` (${auth.public_statement_url})` : ''}, record ${auth.id}.`;
  return `Testing was done with the site owner's written authorisation${auth.authoriser ? `, given by ${auth.authoriser}` : ''}, record ${auth.id}, in force until ${auth.valid_until}.`;
}

export function retestDiffMarkdown(diff: RetestDiff, current: ClientReport): string {
  const lines: string[] = [];
  if (current.brand.logo_data_uri) lines.push(`![${current.brand.logo_alt ?? current.brand.name}](${current.brand.logo_data_uri})`, '');
  lines.push(
    `# Re-test comparison: ${current.client.site_name}`,
    '',
    `Prepared by ${current.brand.name} for ${current.client.business_name} · ${reportDate(diff.current_tested_at)} compared with ${reportDate(diff.previous_tested_at)} · Runs ${diff.previous_run} and ${diff.current_run}`,
    '',
    '## Summary',
    '',
    `**${diff.new_issues.length} new, ${diff.fixed.length} fixed, and ${diff.still_open.length} still open, against WCAG 2.2 AA in tested pages${diff.journey_regressions.length > 0 ? `. ${diff.journey_regressions.length} ${diff.journey_regressions.length === 1 ? 'journey that worked last time no longer works' : 'journeys that worked last time no longer work'}` : ''}.**`,
    '',
  );
  const section = (heading: string, empty: string, rows: string[]) => lines.push(`## ${heading}`, '', ...(rows.length > 0 ? rows : [empty]), '');
  section(
    'Journeys that stopped working',
    'None. Every journey that worked last time still works, or could not be checked (listed below).',
    diff.journey_regressions.map((change) => `- **${change.title}:** worked last time, did not work this time. ${change.summary}`),
  );
  section('Journeys that work again', 'None.', diff.journey_fixes.map((change) => `- **${change.title}:** did not work last time, works now.`));
  section('New issues', 'None.', diff.new_issues.map((issue) => `- ${issue.id} · ${issue.severity} · ${issue.title} (\`${issue.key}\`)`));
  section('Fixed since last time', 'None.', diff.fixed.map((issue) => `- ${issue.title} (was ${issue.severity}, \`${issue.key}\`)`));
  section(
    'Still open',
    'None.',
    diff.still_open.map(
      (issue) =>
        `- ${issue.id} · ${issue.severity} · ${issue.title}: ${issue.places_before} ${issue.places_before === 1 ? 'place' : 'places'} last time, ${issue.places_now} now${issue.previous_severity !== issue.severity ? `; graded ${issue.previous_severity} last time` : ''} (\`${issue.key}\`)`,
    ),
  );
  const unchecked = [
    ...diff.not_rechecked.map((issue) => `- ${issue.title} (\`${issue.key}\`): its pages were not checked this time, so it is neither fixed nor confirmed.`),
    ...diff.journey_not_rechecked.map((change) => `- ${change.title}: ${change.summary}`),
    ...diff.withdrawn_since.map((issue) => `- ${issue.title} (\`${issue.key}\`): withdrawn by the reviewer since the last run.`),
  ];
  if (unchecked.length > 0) section('Not re-checked this time', 'None.', unchecked);
  lines.push(
    '## Scope and limits',
    '',
    '- This comparison lists issues found against WCAG 2.2 AA in tested pages, in both runs. It covers only the pages and journeys in those runs.',
    '- "Fixed" means the automated checks no longer find the issue on pages that were checked again. Criteria that need a person still need one.',
    '- This is not a security test. Nothing was done to look for vulnerabilities, and the results say nothing about how secure the site is.',
    `- ${permissionLine(current.authorisation)}`,
    `- The full report for this run is \`client-report.md\` in \`${diff.current_run}\`.`,
    '',
  );
  const markdown = lines.join('\n');
  assertNoComplianceClaim(markdown, 'The re-test comparison says');
  return markdown;
}
