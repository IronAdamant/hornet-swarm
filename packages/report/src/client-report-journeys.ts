import { JOURNEY_KINDS, type ClientJob, type JourneyKind, type RunResult } from '@hornet-swarm/core';
import { JOURNEY_TITLES, type ClientJourneyResult } from './client-report-model.js';
import type { DraftIssue } from './client-report-page-issues.js';
import { REASON_TEXT, plainFailure } from './render.js';

type RunUser = RunResult['users'][number];
type RunJourney = RunUser['journeys'][number];
type Outcome = { label: string; journey: RunJourney };

const WHY: Readonly<Record<JourneyKind | 'other', string>> = {
  sign_up: 'New customers cannot create an account, so any purchase that needs one is lost.',
  login: 'Returning customers cannot reach their account, their orders, or their saved details.',
  cart: 'Customers who cannot add products to the cart cannot buy anything.',
  checkout: 'Customers who cannot finish checkout cannot pay, so the shop loses the sale.',
  other: 'Customers may not be able to finish this task on the site.',
};

const FIX = 'Open the screenshot and page text saved for the failed step, listed under Evidence, and fix the cause. The next re-test confirms the fix.';

/**
 * The four journeys every report shows (sign-up, log in, add to cart, checkout), then any other
 * journey in the job. When no journey covers log in, the run's own sign-in check stands for it.
 */
export function journeyResults(job: ClientJob, run: RunResult, journeyNames: ReadonlyMap<string, string>, hasFile: (path: string) => boolean): { results: ClientJourneyResult[]; issues: DraftIssue[] } {
  const results: ClientJourneyResult[] = [];
  const issues: DraftIssue[] = [];
  const members = run.users.filter((user) => user.phase1.blocked_reason !== 'guest');
  for (const kind of JOURNEY_KINDS) {
    const covering = job.journeys.filter((entry) => entry.covers === kind).map((entry) => entry.id);
    const outOfScope = job.not_in_scope.find((entry) => entry.covers === kind);
    if (covering.length === 0 && kind === 'login' && members.length > 0) {
      const { result, issue } = signInResult(members, hasFile);
      results.push(result);
      if (issue) issues.push(issue);
      continue;
    }
    if (covering.length === 0) {
      results.push({
        kind,
        title: JOURNEY_TITLES[kind],
        status: outOfScope ? 'out_of_scope' : 'not_tested',
        summary: outOfScope ? `Left out of this round on purpose: ${outOfScope.reason}` : `No journey in this job covers ${JOURNEY_TITLES[kind].toLowerCase()}.`,
        journeys: [],
        evidence: [],
      });
      continue;
    }
    const { result, issue } = coveredResult(kind, JOURNEY_TITLES[kind], covering, run, journeyNames, hasFile);
    results.push(result);
    if (issue) issues.push(issue);
  }
  for (const entry of job.journeys.filter((journey) => journey.covers === undefined)) {
    const title = journeyNames.get(entry.id) ?? entry.id;
    const { result, issue } = coveredResult('other', title, [entry.id], run, journeyNames, hasFile);
    results.push(result);
    if (issue) issues.push(issue);
  }
  return { results, issues };
}

function signInResult(members: RunUser[], hasFile: (path: string) => boolean): { result: ClientJourneyResult; issue?: DraftIssue } {
  const failed = members.filter((user) => user.phase1.status !== 'pass');
  const title = JOURNEY_TITLES.login;
  if (failed.length === 0) {
    return { result: { kind: 'login', title, status: 'worked', summary: `Worked for ${countWords(members.length, members.length)}, checked by the sign-in that starts every run.`, journeys: ['sign-in'], evidence: [] } };
  }
  const blocked = failed.every((user) => user.phase1.status === 'blocked');
  const reason = failed[0]?.phase1.blocked_reason;
  const detail = blocked ? `the run stopped because ${REASON_TEXT[reason ?? ''] ?? 'something outside the site stopped it'}` : firstLine(failed[0]?.phase1.error ?? 'the site did not sign the account in');
  const summary = `${blocked ? 'Stopped' : 'Failed'} for ${countWords(failed.length, members.length)}: ${detail}.`;
  // The sign-in check's steps are not in run.json, so its saved failure is found by name.
  const evidence = failed
    .flatMap((user) => Array.from({ length: 12 }, (_, index) => [`${user.label}/phase1/failed-step-${index}.png`, `${user.label}/phase1/failed-step-${index}.txt`]).flat())
    .filter(hasFile);
  const result: ClientJourneyResult = { kind: 'login', title, status: blocked ? 'blocked' : 'failed', summary, journeys: ['sign-in'], evidence };
  if (blocked) return { result };
  return {
    result,
    issue: {
      key: 'journey:login',
      source: 'journey',
      severity: 'High',
      severity_reason: 'A customer cannot complete something the site exists for.',
      title: 'Customers could not log in',
      where: [{ page: 'Sign-in page', address: '', places: failed.length, example: detail }],
      why_it_matters: WHY.login,
      how_to_fix: FIX,
      criteria: [],
      evidence,
    },
  };
}

function coveredResult(
  kind: JourneyKind | 'other',
  title: string,
  ids: string[],
  run: RunResult,
  journeyNames: ReadonlyMap<string, string>,
  hasFile: (path: string) => boolean,
): { result: ClientJourneyResult; issue?: DraftIssue } {
  const outcomes: Outcome[] = run.users.flatMap((user) => user.journeys.filter((journey) => ids.includes(journey.id)).map((journey) => ({ label: user.label, journey })));
  const named = ids.map((id) => journeyNames.get(id) ?? id);
  if (outcomes.length === 0) {
    return { result: { kind, title, status: 'not_tested', summary: `The journey ${named.join(', ')} was not in this run.`, journeys: named, evidence: [] } };
  }
  const failed = outcomes.filter((outcome) => ['fail', 'error', 'flaky'].includes(outcome.journey.status));
  const blocked = outcomes.filter((outcome) => outcome.journey.status === 'blocked');
  const notRun = outcomes.filter((outcome) => outcome.journey.status === 'skipped' || outcome.journey.steps.length === 0);
  const worked = outcomes.filter((outcome) => outcome.journey.status === 'pass');
  if (failed.length > 0) {
    const first = failed[0] as Outcome;
    const step = first.journey.steps.find((entry) => entry.status !== 'pass' && entry.status !== 'skipped');
    const flakyOnly = failed.every((outcome) => outcome.journey.status === 'flaky');
    const detail = flakyOnly ? 'it worked only when tried a second time' : step ? `at step ${step.index + 1} of ${first.journey.steps.length}, ${plainFailure(step)}` : 'it stopped before its first step';
    const evidence = failed
      .flatMap((outcome) => {
        const failing = outcome.journey.steps.find((entry) => entry.status !== 'pass' && entry.status !== 'skipped');
        return failing ? [`${outcome.label}/${outcome.journey.id}/failed-step-${failing.index}.png`, `${outcome.label}/${outcome.journey.id}/failed-step-${failing.index}.txt`] : [];
      })
      .filter(hasFile);
    const summary = `Did not work for ${countWords(failed.length, outcomes.length)}: ${detail}.`;
    const core = kind !== 'other';
    return {
      result: { kind, title, status: 'failed', summary, journeys: named, evidence },
      issue: {
        key: `journey:${kind === 'other' ? first.journey.id : kind}`,
        source: 'journey',
        severity: flakyOnly || !core ? 'Medium' : 'High',
        severity_reason: flakyOnly ? 'It worked on a second try, so customers can get through, but some will not.' : core ? 'A customer cannot complete something the site exists for.' : 'Starting grade for a journey outside sign-up, log in, cart, and checkout.',
        title: `${title} did not work`,
        where: [{ page: journeyNames.get(first.journey.id) ?? first.journey.id, address: '', places: failed.length, example: detail }],
        why_it_matters: WHY[kind],
        how_to_fix: FIX,
        criteria: [],
        evidence,
      },
    };
  }
  if (blocked.length > 0) {
    const first = blocked[0] as Outcome;
    const reason = first.journey.steps.find((entry) => entry.blocked_reason)?.blocked_reason;
    const why = reason ? (REASON_TEXT[reason] ?? reason) : 'something outside the site stopped it';
    return { result: { kind, title, status: 'blocked', summary: `Stopped before the end for ${countWords(blocked.length, outcomes.length)}, because ${why}. This says nothing yet about whether it works.`, journeys: named, evidence: [] } };
  }
  if (worked.length === 0 || notRun.length === outcomes.length) {
    return { result: { kind, title, status: 'not_tested', summary: 'It was not run, because sign-in did not work for the accounts that would have run it.', journeys: named, evidence: [] } };
  }
  return { result: { kind, title, status: 'worked', summary: `Worked for ${countWords(worked.length, outcomes.length)}.`, journeys: named, evidence: [] } };
}

function countWords(count: number, of: number): string {
  if (count === of) return of === 1 ? 'the test account' : `all ${of} test accounts`;
  return `${count} of ${of} test accounts`;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? text).trim().replace(/\.$/, '');
}
