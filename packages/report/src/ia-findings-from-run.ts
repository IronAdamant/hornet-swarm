/**
 * Builds an ia-findings/0.1 file from a hornet-swarm run.
 *
 * One finding is one problem. axe-core violations are grouped by rule, and every page that hit
 * the rule is listed. Incomplete axe results, and harness checks that cannot decide, become
 * needs_review with no severity. The file is always internal: this build does not mark a run
 * client_ready.
 *
 * Severity uses AXE_IMPACT_TO_SEVERITY (critical, high, medium, low). That is separate from the
 * High / Medium / Low grades on a client report.
 */
import {
  accessibilityTags,
  wcagCriterion,
  type AccessibilityImpact,
  type AccessibilityResult,
  type RunResult,
} from '@hornet-swarm/core';
import { accessibilityFileOf, pageAddress, wcag22Issues, type PageCheck } from './client-report-page-issues.js';
import { plainAxeRule, plainHarnessCheck } from './plain-language-rules.js';
import {
  AXE_IMPACT_TO_SEVERITY,
  CONFIDENCE_RUBRIC,
  IA_DATE_TIME,
  IA_FINDINGS_SCHEMA_VERSION,
  IaFindingsError,
  RUN_METHOD,
  applyReviewerBump,
  clippedEscape,
  nonAsciiCharacters,
  safeProse,
  validateIaFindings,
  type IaFinding,
  type IaFindingsFile,
  type IaSeverity,
  type IaSubjectKind,
} from './ia-findings.js';

/** The axe-core version declared by the runner package. run.json does not record the version that ran. */
export const DECLARED_AXE_VERSION = '4.10.2';

const IMPACT_RANK: Record<AccessibilityImpact, number> = { critical: 4, serious: 3, moderate: 2, minor: 1 };

const STANDARD_BY_ID: Record<string, { version: string; level: 'A' | 'AA'; rank: number }> = {
  wcag2a: { version: '2.0', level: 'A', rank: 1 },
  wcag2aa: { version: '2.0', level: 'AA', rank: 2 },
  wcag21aa: { version: '2.1', level: 'AA', rank: 3 },
  wcag22aa: { version: '2.2', level: 'AA', rank: 4 },
};

export type IaRecordedFact = {
  title: string;
  page: string;
  url: string;
  who: string;
  how: string;
  /** Which recorded-fact basis to use. Score is 0.9. */
  basis: 'http' | 'links' | 'pass';
  expected?: string;
  actual?: string;
  recommendation?: string;
  description?: string;
  selector?: string;
  evidenceRef: string;
  evidenceType?: IaFinding['evidence'][number]['type'];
  quote?: string;
};

export type IaRunContext = {
  /** Saved `accessibility-*.json` files, keyed by their path inside the run folder. */
  axeFiles?: readonly { path: string; body: unknown }[];
  baseUrl?: string;
  subjectName?: string;
  /**
   * Leave unset and a local address is fictional_demo. Anything else is own_site.
   * This converter does not choose client: the file is internal groundwork.
   */
  subjectKind?: IaSubjectKind;
  axeVersion?: string;
  facts?: readonly IaRecordedFact[];
  /** Names an independent reviewer, bumps every score by 0.1, and still leaves status internal. */
  reviewedBy?: readonly string[];
  viewport?: string;
  scopeOut?: readonly string[];
};

type Hit = {
  rule: string;
  impact: AccessibilityImpact;
  help: string;
  criteria: string[];
  count: number;
  page: string;
  url: string;
  step: number;
  selector: string;
  html: string;
  summary: string;
  evidenceRef: string;
};

type Located = { check: PageCheck; userIndex: number; journeyIndex: number; stepIndex: number };

const FACT_BASIS: Record<IaRecordedFact['basis'], string> = {
  http: 'HTTP status recorded by the test run',
  links: 'Link count recorded by the test run',
  pass: 'Each step has a pass check and a screenshot',
};

export function iaFindingsFromRun(result: RunResult, context: IaRunContext = {}): IaFindingsFile {
  if (!IA_DATE_TIME.test(result.started_at)) throw new IaFindingsError(['run.started_at is not a date-time']);
  const axeByPath = new Map((context.axeFiles ?? []).map((file) => [file.path, savedNodes(file.body)]));
  const located = locate(result);
  const reviewers = (context.reviewedBy ?? []).flatMap((name) => {
    const prose = optionalProse(name);
    return prose ? [prose] : [];
  });
  const confirmed = reviewers.length > 0;
  const baseUrl = chooseBaseUrl(located, context.baseUrl);
  const issues = [
    ...axeIssues(located, axeByPath, context.axeVersion ?? DECLARED_AXE_VERSION, confirmed),
    ...harnessIssues(located, context.axeFiles ?? [], confirmed),
  ].sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.title.localeCompare(right.title));
  const needsReview = [...axeNeedsReview(located, axeByPath, new Set(issues.map((issue) => issue.source?.rule_id).filter((id): id is string => Boolean(id))), context.axeVersion ?? DECLARED_AXE_VERSION, confirmed), ...signalReviews(result, located, confirmed)];
  const observations = (context.facts ?? []).flatMap((fact) => factObservation(fact, confirmed));
  const worked = whatWorked(result, baseUrl, confirmed);
  const findings = numberFindings([...issues, ...needsReview, ...observations, ...(worked ? [worked] : [])]);
  const doc: IaFindingsFile = {
    schema_version: IA_FINDINGS_SCHEMA_VERSION,
    report: reportOf(result, located, context, baseUrl, reviewers),
    findings,
  };
  const validation = validateIaFindings(doc);
  if (validation.errors.length > 0) throw new IaFindingsError(validation.errors);
  return doc;
}

function locate(result: RunResult): Located[] {
  const located: Located[] = [];
  result.users.forEach((user, userIndex) => {
    user.journeys.forEach((journey, journeyIndex) => {
      journey.steps.forEach((step, stepIndex) => {
        if (!step.accessibility) return;
        located.push({
          check: {
            label: user.label,
            journey: journey.id,
            step: step.index,
            result: step.accessibility,
            address: pageAddress(step.accessibility.url),
          },
          userIndex,
          journeyIndex,
          stepIndex,
        });
      });
    });
  });
  return located;
}

function savedNodes(body: unknown): Map<string, { target: string; html: string; summary: string }> {
  const map = new Map<string, { target: string; html: string; summary: string }>();
  if (!body || typeof body !== 'object') return map;
  const violations = (body as { violations?: unknown }).violations;
  if (!Array.isArray(violations)) return map;
  for (const violation of violations) {
    if (!violation || typeof violation !== 'object') continue;
    const id = (violation as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const nodes = (violation as { nodes?: unknown }).nodes;
    const node = Array.isArray(nodes) ? nodes[0] : undefined;
    const record = node && typeof node === 'object' ? (node as { target?: unknown; html?: unknown; summary?: unknown }) : {};
    map.set(id, {
      target: typeof record.target === 'string' ? record.target : '',
      html: typeof record.html === 'string' ? record.html : '',
      summary: typeof record.summary === 'string' ? record.summary : '',
    });
  }
  return map;
}

function axeIssues(located: Located[], axeByPath: Map<string, Map<string, { target: string; html: string; summary: string }>>, axeVersion: string, confirmed: boolean): IaFinding[] {
  const groups = new Map<string, Hit[]>();
  for (const entry of located) {
    const nodes = axeByPath.get(accessibilityFileOf(entry.check));
    for (const violation of entry.check.result.violations) {
      const node = nodes?.get(violation.rule);
      const list = groups.get(violation.rule) ?? [];
      list.push(hitFrom(entry, violation, node));
      groups.set(violation.rule, list);
    }
  }
  return [...groups.entries()]
    .sort((left, right) => IMPACT_RANK[worstImpact(right[1])] - IMPACT_RANK[worstImpact(left[1])] || left[0].localeCompare(right[0]))
    .map(([rule, hits]) => axeFinding(rule, hits, 'issue', AXE_IMPACT_TO_SEVERITY[worstImpact(hits)], axeVersion, confirmed));
}

function axeNeedsReview(
  located: Located[],
  axeByPath: Map<string, Map<string, { target: string; html: string; summary: string }>>,
  alreadyIssued: Set<string>,
  axeVersion: string,
  confirmed: boolean,
): IaFinding[] {
  const groups = new Map<string, Hit[]>();
  for (const entry of located) {
    for (const rule of entry.check.result.review_rules ?? []) {
      if (alreadyIssued.has(rule.rule)) continue;
      const list = groups.get(rule.rule) ?? [];
      list.push({
        rule: rule.rule,
        impact: 'minor',
        help: rule.rule,
        criteria: rule.criteria,
        count: rule.count,
        page: entry.check.result.name,
        url: entry.check.result.url,
        step: entry.check.step,
        selector: '',
        html: '',
        summary: '',
        evidenceRef: evidenceRefFor(entry, axeByPath.has(accessibilityFileOf(entry.check)), 'review_rules'),
      });
      groups.set(rule.rule, list);
    }
  }
  return [...groups.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([rule, hits]) => axeFinding(rule, hits, 'needs_review', 'none', axeVersion, confirmed));
}

function hitFrom(entry: Located, violation: AccessibilityResult['violations'][number], node: { target: string; html: string; summary: string } | undefined): Hit {
  return {
    rule: violation.rule,
    impact: violation.impact,
    help: violation.help,
    criteria: violation.criteria ?? [],
    count: violation.count,
    page: entry.check.result.name,
    url: entry.check.result.url,
    step: entry.check.step,
    selector: node?.target || violation.example,
    html: node?.html ?? '',
    summary: node?.summary || violation.help,
    evidenceRef: evidenceRefFor(entry, Boolean(node), 'violations'),
  };
}

function evidenceRefFor(entry: Located, haveFile: boolean, bucket: 'violations' | 'review_rules'): string {
  if (haveFile) return `${accessibilityFileOf(entry.check)}#/${bucket}`;
  return `run.json#/users/${entry.userIndex}/journeys/${entry.journeyIndex}/steps/${entry.stepIndex}/accessibility/${bucket}`;
}

function axeFinding(rule: string, hits: Hit[], kind: 'issue' | 'needs_review', severity: IaSeverity, axeVersion: string, confirmed: boolean): IaFinding {
  const primary = kind === 'issue' ? hits.reduce((best, hit) => (IMPACT_RANK[hit.impact] > IMPACT_RANK[best.impact] ? hit : best)) : hits[0];
  if (!primary) throw new IaFindingsError([`no hit for ${rule}`]);
  const plain = plainAxeRule(rule, primary.help, primary.criteria);
  const pages = new Set(hits.map((hit) => hit.page)).size;
  const named = primary.selector.trim().length > 0;
  const basis = kind === 'issue'
    ? `axe-core rule violation${named ? ' on a named element' : ''}, same result on ${pages} page(s)`
    : 'axe-core could not decide (needs review); no manual check yet';
  const score = kind === 'issue' ? CONFIDENCE_RUBRIC.automatedRule : CONFIDENCE_RUBRIC.toolUndecided;
  const criteria = [...new Set(hits.flatMap((hit) => (hit.criteria.length > 0 ? hit.criteria : plain.criteria)))];
  const quote = evidenceQuote(primary.summary);
  const alsoOn = uniquePages(hits, primary.page);
  const element = elementOf(primary.selector, primary.html, undefined);
  return {
    id: 'F-000',
    kind,
    title: clip(safeProse(plain.title, `Rule ${rule}`)),
    severity,
    location: {
      page: safeProse(primary.page, 'Page'),
      url: asciiText(primary.url, 'http://127.0.0.1'),
      journey_step: primary.step,
      ...(element ? { element } : {}),
      ...(alsoOn.length > 0 ? { also_on: alsoOn.map((page) => safeProse(page, 'Page')) } : {}),
    },
    affects: [{ who: audience(plain.why), how: safeProse(plain.why, 'Some people may find this part of the page hard to use.') }],
    ...wcagField(criteria),
    confidence: scored(score, basis, confirmed),
    recommendation: safeProse(plain.fix, 'See the saved results for each place this was found.'),
    source: { method: 'automated', tool: `axe-core ${axeVersion}`, rule_id: rule },
    occurrences: Math.max(1, hits.reduce((sum, hit) => sum + hit.count, 0)),
    evidence: [{ type: 'tool_output', ref: primary.evidenceRef, ...(quote ? { quote } : {}) }],
  };
}

function harnessIssues(located: Located[], axeFiles: readonly { path: string; body: unknown }[], confirmed: boolean): IaFinding[] {
  const checks = located.map((entry) => entry.check);
  const files = new Set(axeFiles.map((file) => file.path));
  return wcag22Issues(checks, (path) => files.has(path)).flatMap((issue) => {
    const first = issue.where[0];
    if (!first) return [];
    const plain = plainHarnessCheck(issue.key === 'wcag22:consistent-help' ? 'consistent-help' : issue.key === 'wcag22:paste-blocked' ? 'paste-blocked' : 'focus-not-obscured');
    const pages = issue.where.length;
    const entry = located.find((item) => item.check.result.name === first.page);
    const ref = issue.evidence[0] ? `${issue.evidence[0]}#/wcag22` : entry ? evidenceRefFor(entry, false, 'violations').replace(/\/violations$/, '/wcag22') : 'run.json#/wcag22';
    const severity: IaSeverity = issue.key === 'wcag22:consistent-help' ? 'low' : 'medium';
    const description = optionalProse(first.example);
    const named = Boolean(description);
    return [{
      id: 'F-000',
      kind: 'issue' as const,
      title: clip(safeProse(plain.title, 'Harness check')),
      severity,
      location: {
        page: safeProse(first.page, 'Page'),
        url: entry?.check.result.url ? asciiText(entry.check.result.url, 'http://127.0.0.1') : 'http://127.0.0.1',
        ...(entry ? { journey_step: entry.check.step } : {}),
        ...(description ? { element: { description } } : {}),
        ...(issue.where.length > 1 ? { also_on: issue.where.slice(1).map((item) => safeProse(item.page, 'Page')) } : {}),
      },
      affects: [{ who: audience(plain.why), how: safeProse(plain.why, 'Some people may find this part of the page hard to use.') }],
      ...wcagField(plain.criteria),
      confidence: scored(CONFIDENCE_RUBRIC.automatedRule, `Automated rule violation${named ? ' on a named element' : ''}, same result on ${pages} page(s)`, confirmed),
      recommendation: safeProse(plain.fix, 'See the saved results for each place this was found.'),
      source: { method: 'automated' as const, tool: 'hornet-swarm', rule_id: issue.key },
      occurrences: Math.max(1, issue.where.reduce((sum, item) => sum + item.places, 0)),
      evidence: [{ type: 'tool_output' as const, ref }],
    }];
  });
}

function signalReviews(result: RunResult, located: Located[], confirmed: boolean): IaFinding[] {
  const findings: IaFinding[] = [];
  const dragging = located.flatMap((entry) => (entry.check.result.wcag22?.dragging ?? []).map((item) => ({ entry, item })));
  if (dragging.length > 0) {
    const first = dragging[0];
    if (first) {
      findings.push(reviewFinding({
        title: 'A control looks like it is moved only by dragging',
        who: 'People who cannot drag',
        how: 'The check saw a control that looks draggable. A person needs to confirm it can also be used with single clicks or taps.',
        recommendation: 'Add a single click or tap way to do the same thing, or confirm one already exists.',
        criteria: ['2.5.7'],
        page: first.entry.check.result.name,
        url: first.entry.check.result.url,
        step: first.entry.check.step,
        selector: first.item.target,
        alsoOn: uniqueNames(dragging.map((item) => item.entry.check.result.name), first.entry.check.result.name),
        occurrences: dragging.length,
        ref: `${accessibilityFileOf(first.entry.check)}#/wcag22/dragging`,
        confirmed,
      }));
    }
  }
  const autocomplete = located.flatMap((entry) => (entry.check.result.wcag22?.authentication.autocomplete_off ?? []).map((selector) => ({ entry, selector })));
  if (autocomplete.length > 0 && autocomplete[0]) {
    findings.push(reviewFinding({
      title: 'A password field turns autocomplete off',
      who: 'People who use a password manager',
      how: 'Autocomplete is off, which can stop some password managers from filling the field. A person needs to check that a password manager can still sign in.',
      recommendation: 'Allow a password manager to fill the field.',
      criteria: ['3.3.8'],
      page: autocomplete[0].entry.check.result.name,
      url: autocomplete[0].entry.check.result.url,
      step: autocomplete[0].entry.check.step,
      selector: autocomplete[0].selector,
      alsoOn: uniqueNames(autocomplete.map((item) => item.entry.check.result.name), autocomplete[0].entry.check.result.name),
      occurrences: autocomplete.length,
      ref: `${accessibilityFileOf(autocomplete[0].entry.check)}#/wcag22/authentication`,
      confirmed,
    }));
  }
  const puzzles = located.filter((entry) => entry.check.result.wcag22?.authentication.puzzle);
  const puzzle = puzzles[0];
  if (puzzle) {
    findings.push(reviewFinding({
      title: 'A puzzle is on the page',
      who: 'People who cannot solve a puzzle',
      how: 'The check saw a puzzle. A person needs to check there is a way through that does not rely on solving it.',
      recommendation: 'Offer a way through that does not ask someone to solve a puzzle.',
      criteria: ['3.3.8'],
      page: puzzle.check.result.name,
      url: puzzle.check.result.url,
      step: puzzle.check.step,
      alsoOn: uniqueNames(puzzles.map((entry) => entry.check.result.name), puzzle.check.result.name),
      occurrences: puzzles.length,
      ref: `${accessibilityFileOf(puzzle.check)}#/wcag22/authentication`,
      confirmed,
    }));
  }
  const repeated: { journey: string; field: string; step: number }[] = [];
  for (const user of result.users) {
    for (const journey of user.journeys) {
      for (const step of journey.steps) {
        if (step.redundant_entry) repeated.push({ journey: journey.id, field: step.redundant_entry.field, step: step.index });
      }
    }
  }
  const firstRepeated = repeated[0];
  if (firstRepeated) {
    findings.push(reviewFinding({
      title: 'A value was typed again on a later page',
      who: 'People who find it hard to type the same thing twice',
      how: 'A later step typed a value an earlier step had already given. A person needs to check whether the site could fill it in or offer it to choose.',
      recommendation: 'Offer the earlier value again, or fill the field from it.',
      criteria: ['3.3.7'],
      page: firstRepeated.journey,
      url: chooseBaseUrl(located),
      step: firstRepeated.step,
      selector: firstRepeated.field,
      alsoOn: uniqueNames(repeated.map((item) => item.journey), firstRepeated.journey),
      occurrences: repeated.length,
      ref: 'run.json#/redundant_entry',
      confirmed,
    }));
  }
  return findings;
}

function reviewFinding(input: {
  title: string;
  who: string;
  how: string;
  recommendation: string;
  criteria: string[];
  page: string;
  url: string;
  step: number;
  selector?: string;
  alsoOn: string[];
  occurrences: number;
  ref: string;
  confirmed: boolean;
}): IaFinding {
  const element = input.selector ? elementOf(input.selector, '', undefined) : undefined;
  return {
    id: 'F-000',
    kind: 'needs_review',
    title: clip(input.title),
    severity: 'none',
    location: {
      page: safeProse(input.page, 'Page'),
      url: asciiText(input.url, 'http://127.0.0.1'),
      journey_step: input.step,
      ...(element ? { element } : {}),
      ...(input.alsoOn.length > 0 ? { also_on: input.alsoOn.map((page) => safeProse(page, 'Page')) } : {}),
    },
    affects: [{ who: input.who, how: input.how }],
    ...wcagField(input.criteria),
    confidence: scored(CONFIDENCE_RUBRIC.toolUndecided, 'Tool could not decide; no manual check yet', input.confirmed),
    recommendation: input.recommendation,
    source: { method: 'automated', tool: 'hornet-swarm' },
    occurrences: Math.max(1, input.occurrences),
    evidence: [{ type: 'tool_output', ref: input.ref }],
  };
}

function factObservation(fact: IaRecordedFact, confirmed: boolean): IaFinding[] {
  const ref = asciiText(fact.evidenceRef, '');
  if (!ref) return [];
  const quote = fact.quote ? evidenceQuote(fact.quote) : undefined;
  const element = elementOf(fact.selector ?? '', '', optionalProse(fact.description ?? ''));
  return [{
    id: 'F-000',
    kind: 'observation',
    title: clip(safeProse(fact.title, 'Recorded fact')),
    severity: 'low',
    location: {
      page: safeProse(fact.page, 'Page'),
      url: asciiText(fact.url, 'http://127.0.0.1'),
      ...(element ? { element } : {}),
    },
    affects: [{ who: safeProse(fact.who, 'People using the site'), how: safeProse(fact.how, 'A recorded fact from the run.') }],
    confidence: scored(CONFIDENCE_RUBRIC.recordedFact, FACT_BASIS[fact.basis], confirmed),
    ...(optionalProse(fact.expected ?? '') ? { expected: optionalProse(fact.expected ?? '') } : {}),
    ...(optionalProse(fact.actual ?? '') ? { actual: optionalProse(fact.actual ?? '') } : {}),
    ...(optionalProse(fact.recommendation ?? '') ? { recommendation: optionalProse(fact.recommendation ?? '') } : {}),
    source: { method: 'journey' },
    evidence: [{ type: fact.evidenceType ?? (fact.basis === 'http' ? 'http' : 'tool_output'), ref, ...(quote ? { quote } : {}) }],
  }];
}

function whatWorked(result: RunResult, baseUrl: string, confirmed: boolean): IaFinding | undefined {
  const steps = result.users.flatMap((user) => user.journeys.flatMap((journey) => journey.steps));
  if (steps.length === 0 || steps.some((step) => step.status !== 'pass')) return undefined;
  const shots = steps.flatMap((step) => {
    const shot = step.screenshot;
    if (!shot || shot.includes('..') || nonAsciiCharacters(shot).length > 0) return [];
    const ref = shot.startsWith('/') ? (shot.split('/').at(-1) ?? '') : shot;
    return ref ? [ref] : [];
  });
  const everyStepHasShot = shots.length === steps.length;
  const basis = everyStepHasShot ? 'Each step has a pass check and a screenshot' : 'Each step was recorded as passed';
  return {
    id: 'F-000',
    kind: 'what_worked',
    title: clip(safeProse(`All ${steps.length} recorded steps passed`, 'Recorded steps passed')),
    severity: 'none',
    location: { page: 'Whole journey', url: baseUrl },
    affects: [{ who: 'People using the site', how: 'The recorded steps passed from start to finish.' }],
    confidence: scored(CONFIDENCE_RUBRIC.recordedFact, basis, confirmed),
    source: { method: 'journey' },
    evidence: shots.length > 0 ? shots.map((ref) => ({ type: 'screenshot' as const, ref })) : [{ type: 'log', ref: 'run.json#/totals', quote: `passed steps: ${steps.length}` }],
  };
}

function reportOf(result: RunResult, located: Located[], context: IaRunContext, baseUrl: string, reviewers: string[]): IaFindingsFile['report'] {
  const standards = [...new Set(located.map((entry) => entry.check.result.standard))];
  const known = standards.flatMap((id) => {
    const row = STANDARD_BY_ID[id];
    return row ? [{ id, ...row }] : [];
  });
  const lowest = known.reduce<(typeof known)[number] | undefined>((best, row) => (!best || row.rank < best.rank ? row : best), undefined);
  const version = lowest?.version ?? (standards.length === 0 ? '2.2' : '2.0');
  const level = lowest?.level ?? (standards.length === 0 ? 'AA' : 'A');
  const toolTags = lowest && lowest.id in STANDARD_BY_ID ? accessibilityTags(lowest.id as 'wcag2a' | 'wcag2aa' | 'wcag21aa' | 'wcag22aa') : [];
  const pages = uniqueNames(located.map((entry) => entry.check.result.name), '');
  const journeys = [...new Set(result.users.flatMap((user) => user.journeys.map((journey) => journey.id)))];
  const scopeIn = pages.length > 0 ? pages.map((page) => safeProse(page, 'Page')) : journeys.length > 0 ? journeys.map((id) => `Journey ${id}`) : ['No named page was recorded'];
  const scopeOut = [
    'A manual pass was not recorded on this run',
    ...(standards.length === 0 ? ['No accessibility check was recorded on this run'] : []),
    ...(standards.length > 1 ? ['Pages were checked against more than one standard. This file records the lowest one.'] : []),
    ...(context.scopeOut ?? []).flatMap((item) => {
      const prose = optionalProse(item);
      return prose ? [prose] : [];
    }),
  ];
  const name = safeProse(context.subjectName ?? result.project, result.project);
  const viewport = optionalProse(context.viewport);
  return {
    id: reportId(result),
    title: safeProse(`Accessibility check: ${name}`, 'Accessibility check'),
    subject: { name, base_url: baseUrl, kind: context.subjectKind ?? kindFor(baseUrl) },
    standard: { name: 'WCAG', version, level, ...(toolTags.length > 0 ? { tool_tags: toolTags } : {}) },
    method: RUN_METHOD,
    run: {
      started_at: result.started_at,
      ...(result.finished_at && IA_DATE_TIME.test(result.finished_at) ? { finished_at: result.finished_at } : {}),
      timezone: 'Australia/Sydney',
      ...(viewport ? { viewport } : {}),
      tools: [
        { name: 'hornet-swarm', version: '0.1.0' },
        { name: 'axe-core', version: asciiText(context.axeVersion ?? DECLARED_AXE_VERSION, DECLARED_AXE_VERSION) },
      ],
    },
    scope: {
      in: scopeIn,
      out: [...new Set(scopeOut)],
      data_note: 'Internal file for Iron Adamant. Not for a client.',
    },
    status: 'internal',
    ...(reviewers.length > 0 ? { review: { reviewed_by: reviewers, reviewed_at: result.started_at.slice(0, 10) } } : {}),
  };
}

function reportId(result: RunResult): string {
  const dated = /^run_(\d{8})/.exec(result.run_id);
  const fromStart = result.started_at.slice(0, 10).replaceAll('-', '');
  const date = dated?.[1] ?? (/^\d{8}$/.test(fromStart) ? fromStart : '19700101');
  const project = result.project.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'run';
  const tail = result.run_id.split('_').at(-1)?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  const slug = [project, tail && tail !== project ? tail : ''].filter(Boolean).join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const id = `IA-R-${date}-${slug || 'run'}`;
  return /^IA-R-[0-9]{8}-[a-z0-9-]+$/.test(id) ? id : `IA-R-${date}-run`;
}

function chooseBaseUrl(located: Located[], preferred?: string): string {
  if (preferred && nonAsciiCharacters(preferred).length === 0 && preferred.trim()) return preferred.trim();
  for (const entry of located) {
    const origin = originOf(entry.check.result.url);
    if (origin) return origin;
  }
  return 'http://127.0.0.1';
}

function kindFor(url: string): IaSubjectKind {
  const host = originHost(url);
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) return 'fictional_demo';
  return 'own_site';
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function originHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function scored(score: number, basis: string, confirmed: boolean): IaFinding['confidence'] {
  return {
    score: applyReviewerBump(score, confirmed),
    basis: confirmed ? `${basis}; an independent reviewer confirmed it` : basis,
    evidence_state: 'verified_in_evidence',
  };
}

function wcagField(criteria: readonly string[]): { wcag: NonNullable<IaFinding['wcag']> } | Record<string, never> {
  const wcag: NonNullable<IaFinding['wcag']> = [];
  const seen = new Set<string>();
  for (const id of criteria) {
    if (seen.has(id)) continue;
    seen.add(id);
    const known = wcagCriterion(id);
    if (!known || known.obsolete) continue;
    wcag.push({ sc: known.id, name: known.title, level: known.level });
  }
  return wcag.length > 0 ? { wcag } : {};
}

function elementOf(selector: string, html: string, description: string | undefined): IaFinding['location']['element'] | undefined {
  const element: NonNullable<IaFinding['location']['element']> = {};
  const safeSelector = selector.trim() ? clippedEscape(selector, 300) : '';
  const snippet = html.trim() ? clippedEscape(html, 300) : '';
  if (safeSelector) element.selector = safeSelector;
  if (snippet) element.snippet = snippet;
  if (description) element.description = description;
  return Object.keys(element).length > 0 ? element : undefined;
}

function evidenceQuote(summary: string): string | undefined {
  const flat = summary.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  const escaped = clippedEscape(flat, 500);
  return escaped || undefined;
}

function audience(why: string): string {
  const text = why.toLowerCase();
  if (text.includes('screen reader')) return 'Screen reader users';
  if (text.includes('speech') || text.includes('voice')) return 'Speech input users';
  if (text.includes('keyboard')) return 'Keyboard users';
  if (text.includes('low vision') || text.includes('zoom') || text.includes('magnification')) return 'People with low vision';
  if (text.includes('deaf') || text.includes('caption')) return 'Deaf and hard-of-hearing people';
  if (text.includes('colour') || text.includes('color')) return 'People who cannot tell colours apart';
  if (text.includes('shaky') || text.includes('tap')) return 'People using a touch screen';
  return 'People using the page';
}

function optionalProse(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  const prose = safeProse(text, '');
  return prose || undefined;
}

function asciiText(value: string, fallback: string): string {
  const ascii = [...value].filter((char) => (char.codePointAt(0) ?? 0) < 128).join('').trim();
  return ascii || fallback;
}

function clip(title: string): string {
  return title.length <= 120 ? title : title.slice(0, 120).trim();
}

function uniquePages(hits: Hit[], primary: string): string[] {
  return uniqueNames(hits.map((hit) => hit.page), primary);
}

function uniqueNames(names: string[], primary: string): string[] {
  const seen = new Set<string>(primary ? [primary] : []);
  const out: string[] = [];
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function worstImpact(hits: Hit[]): AccessibilityImpact {
  return hits.reduce<AccessibilityImpact>((best, hit) => (IMPACT_RANK[hit.impact] > IMPACT_RANK[best] ? hit.impact : best), 'minor');
}

function severityRank(severity: IaSeverity): number {
  const order = ['critical', 'high', 'medium', 'low', 'none'];
  const index = order.indexOf(severity);
  return index === -1 ? order.length : index;
}

function numberFindings(findings: IaFinding[]): IaFinding[] {
  if (findings.length > 999) throw new IaFindingsError(['a findings file holds at most 999 findings']);
  return findings.map((finding, index) => ({ ...finding, id: `F-${String(index + 1).padStart(3, '0')}` }));
}
