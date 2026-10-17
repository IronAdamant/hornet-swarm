import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import {
  DEFAULT_ACCESSIBILITY_STANDARD,
  accessibilityTags,
  atLeast,
  coversWcag22,
  sortViolations,
  withoutObsoleteCriteria,
  type AccessibilityImpact,
  type AccessibilityResult,
  type AccessibilityStandard,
  type Redactor,
  type Wcag22PageSignals,
} from '@hornet-swarm/core';
import { checkWcag22Page } from './wcag22-page-checks.js';

export type AxeFinding = {
  id: string;
  impact: AccessibilityImpact;
  help: string;
  helpUrl: string;
  /** The WCAG success criteria axe-core tags the rule with. */
  criteria: string[];
  /** Every element with the problem. `nodes` keeps the first 20. */
  count: number;
  nodes: { target: string; html: string; summary: string }[];
};

export type AxeReviewRule = { rule: string; criteria: string[]; count: number };

export type AxeOutcome = { url: string; violations: AxeFinding[]; incomplete: number; review_rules: AxeReviewRule[] };

let axeSource: string | undefined;

/** axe-core from the runner's own files. The page never loads it from the network. */
function axeScript(): string {
  axeSource ??= readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
  return axeSource;
}

export async function checkAccessibility(page: Page, tags: string[], exclude: string[]): Promise<AxeOutcome> {
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
  await page.evaluate(axeScript());
  return page.evaluate(
    async ({ tags, exclude }) => {
      type AxeNode = { target: unknown[]; html: string; failureSummary?: string };
      type AxeRule = { id: string; impact?: string | null; help: string; helpUrl: string; tags: string[]; nodes: AxeNode[] };
      const axe = (globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: AxeRule[]; incomplete: AxeRule[] }> } }).axe;
      const context = exclude.length > 0 ? { exclude: exclude.map((selector) => [selector]) } : document;
      const results = await axe.run(context, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] });
      const criteriaOf = (ruleTags: string[]) => [
        ...new Set(
          ruleTags.flatMap((tag) => {
            const match = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
            return match ? [`${match[1]}.${match[2]}.${match[3]}`] : [];
          }),
        ),
      ];
      return {
        url: location.href,
        incomplete: results.incomplete.length,
        review_rules: results.incomplete.map((rule) => ({ rule: rule.id, criteria: criteriaOf(rule.tags), count: rule.nodes.length })),
        violations: results.violations.map((rule) => ({
          id: rule.id,
          impact: (rule.impact ?? 'minor') as AccessibilityImpact,
          help: rule.help,
          helpUrl: rule.helpUrl,
          criteria: criteriaOf(rule.tags),
          count: rule.nodes.length,
          nodes: rule.nodes.slice(0, 20).map((node) => ({
            target: node.target.map(String).join(' '),
            html: node.html.slice(0, 300),
            summary: (node.failureSummary ?? '').slice(0, 500),
          })),
        })),
      };
    },
    { tags, exclude },
  );
}

export type AccessibilityCheck = { name: string; standard?: AccessibilityStandard; fail_on?: AccessibilityImpact; exclude?: string[] };

/**
 * Runs one accessibility step: axe-core, then the WCAG 2.2 checks when the standard is 2.2 AA.
 * `save` writes the full findings beside the screenshots, sealed like every other saved file.
 * `failure` is set only when `fail_on` is set and an axe-core problem is at least that serious.
 */
export async function runAccessibilityCheck(
  page: Page,
  check: AccessibilityCheck,
  exclude: string[],
  redactor: Redactor,
  save: (fileName: string, text: string) => void,
): Promise<{ result: AccessibilityResult; failure?: string }> {
  const standard = check.standard ?? DEFAULT_ACCESSIBILITY_STANDARD;
  const raw = await checkAccessibility(page, accessibilityTags(standard), exclude);
  const violations = withoutObsoleteCriteria(raw.violations, standard);
  const reviewRules = withoutObsoleteCriteria(raw.review_rules, standard);
  const wcag22 = coversWcag22(standard) ? sealSignals(await checkWcag22Page(page, exclude), redactor) : undefined;
  // The markup can hold what a customer typed, so the file is masked like every other saved file.
  save(`accessibility-${check.name}.json`, JSON.stringify({ name: check.name, standard, url: raw.url, violations, incomplete: reviewRules.length, review_rules: reviewRules, ...(wcag22 ? { wcag22 } : {}) }, null, 2));
  const result: AccessibilityResult = {
    name: check.name,
    url: redactor.redact(raw.url),
    standard,
    violations: sortViolations(
      violations.map((violation) => ({
        rule: violation.id,
        impact: violation.impact,
        help: violation.help,
        count: violation.count,
        example: redactor.redact(violation.nodes[0]?.target ?? ''),
        criteria: violation.criteria,
      })),
    ),
    needs_review: reviewRules.length,
    review_rules: reviewRules,
    ...(wcag22 ? { wcag22 } : {}),
  };
  const failOn = check.fail_on;
  const serious = failOn ? result.violations.filter((violation) => atLeast(violation.impact, failOn)) : [];
  if (serious.length === 0) return { result };
  return {
    result,
    failure: `accessibility: ${serious.length} ${serious.length === 1 ? 'problem' : 'problems'} at or above ${failOn} (${serious.map((violation) => `${violation.rule}: ${violation.help}`).slice(0, 3).join('; ')})`,
  };
}

function sealSignals(signals: Wcag22PageSignals, redactor: Redactor): Wcag22PageSignals {
  const mask = (text: string) => redactor.redact(text);
  return {
    focus_not_obscured: { checked: signals.focus_not_obscured.checked, hidden: signals.focus_not_obscured.hidden.map((entry) => ({ target: mask(entry.target), covered_by: mask(entry.covered_by) })) },
    dragging: signals.dragging.map((entry) => ({ target: mask(entry.target), reason: mask(entry.reason) })),
    help: signals.help.map((entry) => ({ kind: entry.kind, label: mask(entry.label) })),
    authentication: {
      password_fields: signals.authentication.password_fields,
      paste_blocked: signals.authentication.paste_blocked.map(mask),
      autocomplete_off: signals.authentication.autocomplete_off.map(mask),
      puzzle: signals.authentication.puzzle,
    },
  };
}
