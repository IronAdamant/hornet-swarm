import {
  type AccessibilityResult,
  type CriterionEvidence,
  type RunResult,
  type WcagCriterion,
  accessibilitySeverity,
  sortViolations,
} from '@hornet-swarm/core';
import type { ClientIssue, ClientReviewItem } from './client-report-model.js';
import { plainAxeRule, plainHarnessCheck } from './plain-language-rules.js';

/** An issue before the reviewer's grades and the report's numbering are applied. */
export type DraftIssue = Omit<ClientIssue, 'id'>;

/** One accessibility step in a saved run: who ran it, where it saved its results, and what it found. */
export type PageCheck = { label: string; journey: string; step: number; result: AccessibilityResult; address: string };

const IMPACT_RANK = { critical: 4, serious: 3, moderate: 2, minor: 1 } as const;
const STANDARD_RANK: Readonly<Record<string, number>> = { wcag2a: 1, wcag2aa: 2, wcag21aa: 3, wcag22aa: 4 };

export function pageAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.hash}`;
  } catch {
    return url;
  }
}

export function collectPageChecks(run: RunResult): PageCheck[] {
  return run.users.flatMap((user) =>
    user.journeys.flatMap((journey) =>
      journey.steps.flatMap((step) => (step.accessibility ? [{ label: user.label, journey: journey.id, step: step.index, result: step.accessibility, address: pageAddress(step.accessibility.url) }] : [])),
    ),
  );
}

export function accessibilityFileOf(check: PageCheck): string {
  return `${check.label}/${check.journey}/accessibility-${check.result.name}.json`;
}

/** One issue per axe-core rule, listing every page it was found on with the most places any one check counted. */
export function accessibilityIssues(checks: readonly PageCheck[], hasFile: (path: string) => boolean): DraftIssue[] {
  type Group = { rule: string; help: string; impact: keyof typeof IMPACT_RANK; criteria: Set<string>; pages: Map<string, ClientIssue['where'][number]>; evidence: Set<string> };
  const groups = new Map<string, Group>();
  for (const check of checks) {
    for (const violation of sortViolations(check.result.violations)) {
      const group = groups.get(violation.rule) ?? { rule: violation.rule, help: violation.help, impact: violation.impact, criteria: new Set<string>(), pages: new Map(), evidence: new Set<string>() };
      if (IMPACT_RANK[violation.impact] > IMPACT_RANK[group.impact]) group.impact = violation.impact;
      const plain = plainAxeRule(violation.rule, violation.help);
      for (const id of violation.criteria ?? plain.criteria) group.criteria.add(id);
      const seen = group.pages.get(check.result.name);
      if (!seen || violation.count > seen.places) group.pages.set(check.result.name, { page: check.result.name, address: check.address, places: violation.count, example: violation.example });
      const file = accessibilityFileOf(check);
      if (hasFile(file)) group.evidence.add(file);
      groups.set(violation.rule, group);
    }
  }
  return [...groups.values()].map((group) => {
    const plain = plainAxeRule(group.rule, group.help, [...group.criteria]);
    return {
      key: `a11y:${group.rule}`,
      source: 'accessibility',
      severity: accessibilitySeverity(group.impact),
      severity_reason: `Starting grade from the automated check, which rates it ${group.impact}.`,
      title: plain.title,
      where: [...group.pages.values()],
      why_it_matters: plain.why,
      how_to_fix: plain.fix,
      criteria: [...group.criteria].sort(compareCriteria),
      evidence: [...group.evidence],
    };
  });
}

/** Issues from the WCAG 2.2 checks that find a failure directly: covered focus, blocked pasting, and help that moves. */
export function wcag22Issues(checks: readonly PageCheck[], hasFile: (path: string) => boolean): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const focus = byPage(checks, (check) => {
    const hidden = check.result.wcag22?.focus_not_obscured.hidden ?? [];
    const first = hidden[0];
    return first ? { places: hidden.length, example: `${first.target}, covered by ${first.covered_by}` } : undefined;
  });
  if (focus.where.length > 0) {
    issues.push(harnessIssue('focus-not-obscured', 'wcag22:focus-not-obscured', 'Medium', 'Starting grade: keyboard users lose sight of where they are, but can carry on.', focus, hasFile));
  }
  const paste = byPage(checks, (check) => {
    const blocked = check.result.wcag22?.authentication.paste_blocked ?? [];
    return blocked[0] ? { places: blocked.length, example: blocked[0] } : undefined;
  });
  if (paste.where.length > 0) {
    issues.push(harnessIssue('paste-blocked', 'wcag22:paste-blocked', 'Medium', 'Starting grade: customers can still type the password by hand.', paste, hasFile));
  }
  const help = helpOrderDifferences(checks);
  if (help.where.length > 0) {
    issues.push(harnessIssue('consistent-help', 'wcag22:consistent-help', 'Low', 'Starting grade: customers can still find help, with more effort.', help, hasFile));
  }
  return issues;
}

/**
 * 3.2.6 asks that help offered on several pages comes in the same order relative to the rest of
 * the page. The page with the most kinds of help is the reference. A page whose shared kinds come
 * in another order is listed. Page order in the markup stands in for the order on screen.
 */
function helpOrderDifferences(checks: readonly PageCheck[]): { where: ClientIssue['where']; checks: PageCheck[] } {
  const pages = uniquePages(checks).filter((check) => (check.result.wcag22?.help.length ?? 0) > 0);
  const reference = [...pages].sort((left, right) => (right.result.wcag22?.help.length ?? 0) - (left.result.wcag22?.help.length ?? 0))[0];
  if (!reference) return { where: [], checks: [] };
  const referenceKinds = (reference.result.wcag22?.help ?? []).map((entry) => entry.kind);
  const differing = pages.filter((check) => {
    if (check === reference) return false;
    const kinds = (check.result.wcag22?.help ?? []).map((entry) => entry.kind);
    const shared = referenceKinds.filter((kind) => kinds.includes(kind));
    return shared.length >= 2 && shared.join() !== kinds.filter((kind) => shared.includes(kind)).join();
  });
  return {
    where: differing.map((check) => ({
      page: check.result.name,
      address: check.address,
      places: 1,
      example: `${(check.result.wcag22?.help ?? []).map((entry) => entry.kind).join(', ')}; on ${reference.result.name}: ${referenceKinds.join(', ')}`,
    })),
    checks: [reference, ...differing],
  };
}

function byPage(checks: readonly PageCheck[], pick: (check: PageCheck) => { places: number; example: string } | undefined): { where: ClientIssue['where']; checks: PageCheck[] } {
  const where = new Map<string, ClientIssue['where'][number]>();
  const used: PageCheck[] = [];
  for (const check of checks) {
    const found = pick(check);
    if (!found) continue;
    used.push(check);
    const seen = where.get(check.result.name);
    if (!seen || found.places > seen.places) where.set(check.result.name, { page: check.result.name, address: check.address, places: found.places, example: found.example });
  }
  return { where: [...where.values()], checks: used };
}

function harnessIssue(
  check: 'focus-not-obscured' | 'paste-blocked' | 'consistent-help',
  key: string,
  severity: ClientIssue['severity'],
  reason: string,
  found: { where: ClientIssue['where']; checks: PageCheck[] },
  hasFile: (path: string) => boolean,
): DraftIssue {
  const plain = plainHarnessCheck(check);
  return {
    key,
    source: 'wcag22',
    severity,
    severity_reason: reason,
    title: plain.title,
    where: found.where,
    why_it_matters: plain.why,
    how_to_fix: plain.fix,
    criteria: plain.criteria,
    evidence: [...new Set(found.checks.map(accessibilityFileOf).filter(hasFile))],
  };
}

/** The first check of each page, by name. */
function uniquePages(checks: readonly PageCheck[]): PageCheck[] {
  const seen = new Map<string, PageCheck>();
  for (const check of checks) if (!seen.has(check.result.name)) seen.set(check.result.name, check);
  return [...seen.values()];
}

/** What a person must look at: checks that could not decide, and signs of a WCAG 2.2 problem the harness cannot confirm. */
export function reviewItems(checks: readonly PageCheck[], run: RunResult): ClientReviewItem[] {
  const items: ClientReviewItem[] = [];
  const undecided = new Map<string, { criteria: Set<string>; count: number; pages: Set<string> }>();
  for (const check of checks) {
    for (const rule of check.result.review_rules ?? []) {
      const entry = undecided.get(rule.rule) ?? { criteria: new Set<string>(), count: 0, pages: new Set<string>() };
      for (const id of rule.criteria) entry.criteria.add(id);
      entry.count = Math.max(entry.count, rule.count);
      entry.pages.add(check.result.name);
      undecided.set(rule.rule, entry);
    }
  }
  for (const [rule, entry] of undecided) {
    const plain = plainAxeRule(rule, rule);
    items.push({
      criterion: [...entry.criteria].sort(compareCriteria).join(', ') || 'unmapped',
      what: `The automated check could not decide ${entry.count} ${entry.count === 1 ? 'place' : 'places'} for "${plain.title}". A person should look at each one.`,
      where: [...entry.pages].join(', '),
    });
  }
  for (const check of uniquePages(checks)) {
    const signals = check.result.wcag22;
    if (!signals) continue;
    const first = signals.dragging[0];
    if (first) {
      items.push({
        criterion: '2.5.7',
        what: `${signals.dragging.length} ${signals.dragging.length === 1 ? 'element looks' : 'elements look'} like ${signals.dragging.length === 1 ? 'it is' : 'they are'} moved by dragging, such as ${first.target} (${first.reason}). Check each can also be used with single clicks or taps.`,
        where: check.result.name,
      });
    }
    if (signals.authentication.autocomplete_off.length > 0) {
      items.push({ criterion: '3.3.8', what: 'The password field turns autocomplete off, which can stop some password managers from filling it. Check that a password manager can still sign in.', where: check.result.name });
    }
    if (signals.authentication.puzzle) {
      items.push({ criterion: '3.3.8', what: 'A captcha or puzzle is on the page. Check that there is a way through that does not rely on solving a puzzle or remembering something.', where: check.result.name });
    }
  }
  for (const user of run.users) {
    for (const journey of user.journeys) {
      for (const step of journey.steps) {
        if (!step.redundant_entry) continue;
        items.push({
          criterion: '3.3.7',
          what: `Step ${step.index} typed a value that step ${step.redundant_entry.earlier_step} had already given on an earlier page, into an empty field (${step.redundant_entry.field}). Check whether the site could fill it in or offer it to choose.`,
          where: `${journey.id} (${user.label})`,
        });
      }
    }
  }
  return dedupeItems(items);
}

function dedupeItems(items: ClientReviewItem[]): ClientReviewItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.criterion}|${item.what}|${item.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function standardCovers(standard: string, criterion: WcagCriterion): boolean {
  const required = criterion.introduced === '2.2' ? 4 : criterion.introduced === '2.1' ? 3 : criterion.level === 'AA' ? 2 : 1;
  return (STANDARD_RANK[standard] ?? 0) >= required;
}

/** What the saved run says about one criterion, for its verdict. */
export function criterionEvidence(criterion: WcagCriterion, checks: readonly PageCheck[], issues: readonly DraftIssue[], items: readonly ClientReviewItem[]): CriterionEvidence {
  const covering = checks.filter((check) => standardCovers(check.result.standard, criterion));
  const tested = criterion.checks ? covering.some((check) => check.result.wcag22 !== undefined) : covering.length > 0;
  return {
    tested,
    issues: issues.filter((issue) => issue.criteria.includes(criterion.id)).length,
    needsReview: items.filter((item) => item.criterion.split(', ').includes(criterion.id)).length,
  };
}

export function compareCriteria(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}
