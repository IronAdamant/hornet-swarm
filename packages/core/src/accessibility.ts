import type { StepResult } from './schemas.js';

export type AccessibilityImpact = 'critical' | 'serious' | 'moderate' | 'minor';
export type AccessibilityStandard = 'wcag2a' | 'wcag2aa' | 'wcag21aa' | 'wcag22aa';
export type AccessibilityResult = NonNullable<StepResult['accessibility']>;

/** WCAG 2.1 AA is what Australian clients and the Disability Discrimination Act guidance usually name. */
export const DEFAULT_ACCESSIBILITY_STANDARD: AccessibilityStandard = 'wcag21aa';

const IMPACT_RANK: Record<AccessibilityImpact, number> = { critical: 4, serious: 3, moderate: 2, minor: 1 };

/** The axe-core rule tags for a standard. Each level includes the ones below it. */
export function accessibilityTags(standard: AccessibilityStandard = DEFAULT_ACCESSIBILITY_STANDARD): string[] {
  const tags: Record<AccessibilityStandard, string[]> = {
    wcag2a: ['wcag2a'],
    wcag2aa: ['wcag2a', 'wcag2aa'],
    wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  };
  return tags[standard];
}

export function atLeast(impact: AccessibilityImpact, threshold: AccessibilityImpact): boolean {
  return IMPACT_RANK[impact] >= IMPACT_RANK[threshold];
}

/** Worst first, then the most places on the page. */
export function sortViolations(violations: AccessibilityResult['violations']): AccessibilityResult['violations'] {
  return [...violations].sort((left, right) => IMPACT_RANK[right.impact] - IMPACT_RANK[left.impact] || right.count - left.count);
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
