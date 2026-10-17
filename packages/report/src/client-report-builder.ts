import { CriterionVerdict, WCAG22_AA_CRITERIA, decideAllCriteria, type Authorisation, type ClientJob, type RunResult } from '@hornet-swarm/core';
import { CLIENT_REPORT_SCHEMA_VERSION, clientReportSchema, type ClientCriterionRow, type ClientIssue, type ClientJourneyResult, type ClientReport, type ResolvedBrand } from './client-report-model.js';
import { journeyResults } from './client-report-journeys.js';
import { accessibilityIssues, collectPageChecks, criterionEvidence, reviewItems, wcag22Issues, type DraftIssue, type PageCheck } from './client-report-page-issues.js';

export type ClientReportInput = {
  job: ClientJob;
  brand: ResolvedBrand;
  authorisation: Authorisation;
  run: RunResult;
  /** Each journey's name, from the run's analysis. */
  journeyNames: ReadonlyMap<string, string>;
  /** True for a regular file inside the run folder. Only files it vouches for are cited. */
  hasFile: (relativePath: string) => boolean;
};

const SEVERITY_RANK = { High: 3, Medium: 2, Low: 1 } as const;

/**
 * Builds the client report from one saved run. Every finding comes from the run's own results,
 * every file it cites is checked to exist in the run folder, and every criterion row is a
 * `CriterionVerdict`, so a criterion that needs a person can never come out as clear.
 */
export function buildClientReport(input: ClientReportInput): ClientReport {
  const { job, run, hasFile } = input;
  if (run.project !== job.project) throw new Error(`${run.run_id} is a run of ${run.project}, not of ${job.project}.`);
  if (run.status === 'redaction_failure' || run.redaction === 'fail') throw new Error(`${run.run_id} failed its redaction check, so it must not be shared. Fix it and run again.`);
  const checks = collectPageChecks(run);
  const journeys = journeyResults(job, run, input.journeyNames, hasFile);
  const drafts = [...journeys.issues, ...accessibilityIssues(checks, hasFile), ...wcag22Issues(checks, hasFile)];
  const withdrawnKeys = new Map(job.withdrawn_issues.map((entry) => [entry.issue, entry.reason]));
  const withdrawn = drafts.filter((draft) => withdrawnKeys.has(draft.key)).map((draft) => ({ key: draft.key, title: draft.title, reason: withdrawnKeys.get(draft.key) as string }));
  const kept = drafts.filter((draft) => !withdrawnKeys.has(draft.key)).map((draft) => graded(draft, job));
  const issues = numbered(kept);
  const items = reviewItems(checks, run);
  const verdicts = decideAllCriteria((criterion) => criterionEvidence(criterion, checks, kept, items));
  const criteria = verdicts.map(rowOf);
  const pages = pagesTested(checks);
  const report: ClientReport = {
    schema_version: CLIENT_REPORT_SCHEMA_VERSION,
    job_id: job.id,
    project: job.project,
    run_id: run.run_id,
    tested_at: run.finished_at ?? run.started_at,
    standard: 'wcag22aa',
    client: job.client,
    brand: input.brand,
    authorisation: authorisationOf(input.authorisation),
    executive_summary: executiveSummary(job, run, issues, journeys.results, criteria, pages.length),
    pages_tested: pages,
    accounts: run.users.length,
    journeys: journeys.results,
    issues,
    withdrawn,
    review_items: items,
    criteria,
    scope_and_limits: scopeAndLimits(job, input.authorisation, run, criteria),
    evidence_appendix: evidenceAppendix(run, issues, journeys.results, checks, hasFile),
  };
  return clientReportSchema.parse(report);
}

function graded(draft: DraftIssue, job: ClientJob): DraftIssue {
  const override = job.severity_overrides.find((entry) => entry.issue === draft.key);
  return override ? { ...draft, severity: override.severity, severity_reason: `Graded by the reviewer: ${override.reason}` } : draft;
}

/** Worst first. Journeys that stop a sale come before page problems of the same grade. Journey issues are J-, page issues A-. */
function numbered(drafts: DraftIssue[]): ClientIssue[] {
  const places = (draft: DraftIssue) => draft.where.reduce((sum, entry) => sum + entry.places, 0);
  const sorted = [...drafts].sort(
    (left, right) =>
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      Number(right.source === 'journey') - Number(left.source === 'journey') ||
      right.where.length - left.where.length ||
      places(right) - places(left) ||
      left.key.localeCompare(right.key),
  );
  const counters = { J: 0, A: 0 };
  return sorted.map((draft) => {
    const prefix = draft.source === 'journey' ? 'J' : 'A';
    counters[prefix] += 1;
    return { id: `${prefix}-${String(counters[prefix]).padStart(2, '0')}`, ...draft };
  });
}

function rowOf(verdict: CriterionVerdict): ClientCriterionRow {
  if (!CriterionVerdict.isDecided(verdict)) throw new Error('Only decided criteria can be reported.');
  const { criterion } = verdict;
  return {
    id: criterion.id,
    title: criterion.title,
    level: criterion.level,
    introduced: criterion.introduced,
    automation: criterion.automation,
    outcome: verdict.outcome,
    outcome_words: verdict.words,
    issues: verdict.evidence.issues,
    needs_review: verdict.evidence.needsReview,
    note: criterion.manualNote,
  };
}

function pagesTested(checks: readonly PageCheck[]): ClientReport['pages_tested'] {
  const pages = new Map<string, { name: string; address: string; accounts: Set<string> }>();
  for (const check of checks) {
    const page = pages.get(check.result.name) ?? { name: check.result.name, address: check.address, accounts: new Set<string>() };
    page.accounts.add(check.label);
    pages.set(check.result.name, page);
  }
  return [...pages.values()].map((page) => ({ name: page.name, address: page.address, accounts: [...page.accounts].sort() }));
}

function authorisationOf(auth: Authorisation): ClientReport['authorisation'] {
  return {
    id: auth.id,
    basis: auth.basis,
    ...(auth.authoriser ? { authoriser: `${auth.authoriser.name}, ${auth.authoriser.role}` } : {}),
    valid_until: auth.valid_until,
    ...(auth.public_statement ? { public_statement_url: auth.public_statement.url } : {}),
  };
}

export function reportDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function executiveSummary(job: ClientJob, run: RunResult, issues: ClientIssue[], journeys: ClientJourneyResult[], criteria: ClientCriterionRow[], pageCount: number): ClientReport['executive_summary'] {
  const bySeverity = (severity: ClientIssue['severity']) => issues.filter((issue) => issue.severity === severity).length;
  const high = bySeverity('High');
  const headline =
    issues.length === 0
      ? `No issues found against WCAG 2.2 AA in tested pages by the automated checks, with ${plural(criteria.filter((row) => row.outcome === 'needs_manual_review').length, 'criterion', 'criteria')} left for a person to review`
      : `${plural(issues.length, 'issue', 'issues')} found against WCAG 2.2 AA in tested pages${high > 0 ? `, ${high} of them high severity` : ''}`;
  const paragraphs: string[] = [];
  paragraphs.push(
    `On ${reportDate(run.finished_at ?? run.started_at)} we tested ${plural(pageCount, 'page', 'pages')} of ${job.client.site_name} (${job.client.site_url}) with ${plural(run.users.length, 'test account', 'test accounts')}. We checked the pages against WCAG 2.2 level AA, the current accessibility guidelines, and checked whether customers can sign up, log in, add to cart, and check out.`,
  );
  const core = journeys.filter((journey) => journey.kind !== 'other');
  const said = (status: ClientJourneyResult['status']) => core.filter((journey) => journey.status === status).map((journey) => journey.title.toLowerCase());
  const journeyWords: string[] = [];
  if (said('worked').length > 0) journeyWords.push(`${capitalise(listWords(said('worked')))} worked.`);
  for (const journey of core.filter((entry) => entry.status === 'failed')) journeyWords.push(`${journey.title} did not work ${lowerFirst(journey.summary.replace(/^(Did not work|Failed) /, ''))}`);
  if (said('blocked').length > 0) journeyWords.push(`${capitalise(listWords(said('blocked')))} could not be finished, for a reason outside the site, so ${said('blocked').length === 1 ? 'it needs' : 'they need'} testing again.`);
  const untested = [...said('not_tested'), ...said('out_of_scope')];
  if (untested.length > 0) journeyWords.push(`${capitalise(listWords(untested))} ${untested.length === 1 ? 'was' : 'were'} not tested this round.`);
  if (journeyWords.length > 0) paragraphs.push(journeyWords.join(' '));
  if (issues.length > 0) {
    const first = issues.slice(0, 3).map((issue) => `${issue.title.toLowerCase()} (${issue.severity.toLowerCase()})`);
    paragraphs.push(
      `We found ${plural(issues.length, 'issue', 'issues')}: ${high} high, ${bySeverity('Medium')} medium, and ${bySeverity('Low')} low. Fix these first: ${listWords(first)}. Each issue below says where it happens, why it matters to your customers, and how to fix it.`,
    );
  }
  const manual = criteria.filter((row) => row.outcome === 'needs_manual_review').length;
  paragraphs.push(
    `Automated checks find only some accessibility problems. ${manual} of the ${WCAG22_AA_CRITERIA.length} WCAG 2.2 A and AA criteria need a person to review, such as keyboard use and whether image descriptions make sense. They are marked "Needs manual review" in the criteria table, and none of them is counted as passed.`,
  );
  return { headline, paragraphs };
}

function scopeAndLimits(job: ClientJob, auth: Authorisation, run: RunResult, criteria: ClientCriterionRow[]): string[] {
  const permission =
    auth.basis === 'public_practice'
      ? `This site publicly invites test practice${auth.public_statement ? ` ("${auth.public_statement.quote}", ${auth.public_statement.url})` : ''}. It was tested under that published permission (record ${auth.id}), with no owner's written authorisation needed.`
      : `Testing was done with the site owner's written authorisation${auth.authoriser ? `, given by ${auth.authoriser.name} (${auth.authoriser.role})` : ''}, record ${auth.id}, in force until ${auth.valid_until}.`;
  const lines = [
    `This report lists issues found against WCAG 2.2 AA in tested pages. It covers only the pages and journeys named in it, as they were on ${reportDate(run.finished_at ?? run.started_at)}. Pages that are not listed were not tested, and later changes to the site are not covered.`,
    'It is not a statement that the site has no other accessibility issues, and it is not legal advice.',
    'This is not a security test. Nothing was done to look for vulnerabilities or to break into the site, and the results say nothing about how secure it is.',
    permission,
    'Only test accounts were used. Passwords, codes, and personal details are hidden in every saved file.',
    `${criteria.filter((row) => row.outcome === 'needs_manual_review').length} criteria marked "Needs manual review" were not checked by a person in this round. No criterion is marked as passed: where the automated checks found nothing, the report says only that.`,
  ];
  if (job.not_in_scope.length > 0) lines.push(`Left out on purpose: ${job.not_in_scope.map((entry) => `${entry.covers.replace('_', '-')} (${entry.reason})`).join('; ')}.`);
  if (auth.exclusions.length > 0) lines.push(`Agreed exclusions: ${auth.exclusions.join(' ')}`);
  return lines;
}

function evidenceAppendix(run: RunResult, issues: ClientIssue[], journeys: ClientJourneyResult[], checks: readonly PageCheck[], hasFile: (path: string) => boolean): ClientReport['evidence_appendix'] {
  const entries = new Map<string, string>();
  const add = (path: string, what: string) => {
    if (hasFile(path) && !entries.has(path)) entries.set(path, what);
  };
  add('run.json', 'Every account, journey, and step in this run, with its result.');
  add('summary.md', 'The run\'s own short summary.');
  add('evidence.zip', 'Screenshots, page text, network logs, and browser traces, with passwords and personal details hidden.');
  for (const check of checks) add(`${check.label}/${check.journey}/accessibility-${check.result.name}.json`, `Full accessibility results for ${check.result.name} (${check.address}), with the markup of each place found.`);
  for (const issue of issues) for (const path of issue.evidence) add(path, `Evidence for ${issue.id}.`);
  for (const journey of journeys) for (const path of journey.evidence) add(path, `What the page showed when ${journey.title.toLowerCase()} stopped.`);
  return [...entries.entries()].map(([path, what]) => ({ path, what }));
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
