import type { StepResult } from './schemas.js';
import { onlyObsoleteCriteria } from './wcag22-criteria.js';

export type AccessibilityImpact = 'critical' | 'serious' | 'moderate' | 'minor';
export type AccessibilityStandard = 'wcag2a' | 'wcag2aa' | 'wcag21aa' | 'wcag22aa';
export type AccessibilityResult = NonNullable<StepResult['accessibility']>;

/**
 * WCAG 2.2 AA, the current W3C recommendation. Australian government buyers and the Disability
 * Discrimination Act guidance point at the current version.
 */
export const DEFAULT_ACCESSIBILITY_STANDARD: AccessibilityStandard = 'wcag22aa';

export const STANDARD_NAMES: Readonly<Record<string, string>> = Object.freeze({ wcag2a: 'WCAG 2.0 A', wcag2aa: 'WCAG 2.0 AA', wcag21aa: 'WCAG 2.1 AA', wcag22aa: 'WCAG 2.2 AA' });

const IMPACT_RANK: Record<AccessibilityImpact, number> = { critical: 4, serious: 3, moderate: 2, minor: 1 };

/**
 * The axe-core rule tags for a standard. Each level includes the ones below it. The 4.1.1 Parsing
 * rules carry `wcag2a-obsolete`, not `wcag2a`, so no standard here runs them.
 */
export function accessibilityTags(standard: AccessibilityStandard = DEFAULT_ACCESSIBILITY_STANDARD): string[] {
  const tags: Record<AccessibilityStandard, string[]> = {
    wcag2a: ['wcag2a'],
    wcag2aa: ['wcag2a', 'wcag2aa'],
    wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  };
  return tags[standard];
}

/** True when the standard includes the WCAG 2.2 criteria. */
export function coversWcag22(standard: string): boolean {
  return standard === 'wcag22aa';
}

export function atLeast(impact: AccessibilityImpact, threshold: AccessibilityImpact): boolean {
  return IMPACT_RANK[impact] >= IMPACT_RANK[threshold];
}

/** Worst first, then the most places on the page. */
export function sortViolations(violations: AccessibilityResult['violations']): AccessibilityResult['violations'] {
  return [...violations].sort((left, right) => IMPACT_RANK[right.impact] - IMPACT_RANK[left.impact] || right.count - left.count);
}

/**
 * Drops a finding whose only criterion is 4.1.1 Parsing, which WCAG 2.2 removed. A finding with no
 * recorded criteria, from an older run, is kept.
 */
export function withoutObsoleteCriteria<T extends { criteria?: string[] }>(findings: readonly T[], standard: string): T[] {
  if (!coversWcag22(standard)) return [...findings];
  return findings.filter((finding) => !onlyObsoleteCriteria(finding.criteria ?? []));
}

/**
 * The starting grade on the shared scale in docs/severity.md. A reviewer raises it when the
 * problem sits on something the site exists for, such as an unlabelled payment field.
 */
export function accessibilitySeverity(impact: AccessibilityImpact): 'High' | 'Medium' | 'Low' {
  if (impact === 'critical') return 'High';
  if (impact === 'serious') return 'Medium';
  return 'Low';
}
