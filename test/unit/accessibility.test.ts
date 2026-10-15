import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { accessibilitySeverity, accessibilityTags, atLeast, projectSchema, sortViolations, stepResultSchema, validateJourneyDocument } from '../../packages/core/src/index.ts';
import { accessibilityFindings, summaryMarkdown } from '../../packages/report/src/render.ts';

type Users = Parameters<typeof summaryMarkdown>[0];

const root = join(import.meta.dirname, '..', '..');
const project = projectSchema.parse(parse(readFileSync(join(root, 'examples/projects/example-app/project.yaml'), 'utf8')));

function journey(steps: unknown[]): unknown {
  return { version: 1, id: 'a11y', name: 'A11y', users: ['qa-user-1'], requires_phase1: false, steps };
}

const contrast = { rule: 'color-contrast', impact: 'serious', help: 'Elements must meet minimum color contrast ratio thresholds', count: 3, example: '.faint' } as const;
const alt = { rule: 'image-alt', impact: 'critical', help: 'Images must have alternative text', count: 1, example: 'img' } as const;
const label = { rule: 'label', impact: 'critical', help: 'Form elements must have labels', count: 2, example: '#nameless' } as const;

function checked(label: string, violations: unknown[], url = 'http://localhost:8080/a11y', needs_review = 0): Users[number] {
  return {
    label,
    phase1: { status: 'pass', duration_ms: 1 },
    journeys: [
      {
        id: 'a11y',
        name: 'A11y',
        status: 'pass',
        duration_ms: 1,
        steps: [{ index: 1, type: 'accessibility', status: 'pass', duration_ms: 1, started_at: '', finished_at: '', accessibility: { name: 'shop-page', url, standard: 'wcag21aa', violations, needs_review } }],
      },
    ],
  } as unknown as Users[number];
}

describe('the accessibility step', () => {
  it('validates the step, its name, and its standard', () => {
    expect(validateJourneyDocument(journey([{ navigate: { url: '/a11y' } }, { accessibility: { name: 'shop-page' } }]), project).valid).toBe(true);
    expect(validateJourneyDocument(journey([{ accessibility: { name: 'shop-page', standard: 'wcag22aa', fail_on: 'serious', exclude: ['#chat-widget'] } }]), project).valid).toBe(true);
    expect(validateJourneyDocument(journey([{ accessibility: { name: 'Shop Page' } }]), project).valid).toBe(false);
    expect(validateJourneyDocument(journey([{ accessibility: { name: 'shop-page', standard: 'wcag3' } }]), project).valid).toBe(false);
    expect(validateJourneyDocument(journey([{ accessibility: { name: 'shop-page', fail_on: 'all' } }]), project).valid).toBe(false);
  });

  it('includes the lower levels in each standard', () => {
    expect(accessibilityTags('wcag2a')).toEqual(['wcag2a']);
    expect(accessibilityTags()).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
    expect(accessibilityTags('wcag22aa')).toContain('wcag22aa');
  });

  it('ranks impacts, sorts worst first, and starts each on the shared scale', () => {
    expect(atLeast('critical', 'serious')).toBe(true);
    expect(atLeast('moderate', 'serious')).toBe(false);
    expect(sortViolations([contrast, alt, label]).map((violation) => violation.rule)).toEqual(['label', 'image-alt', 'color-contrast']);
    expect(accessibilitySeverity('critical')).toBe('High');
    expect(accessibilitySeverity('serious')).toBe('Medium');
    expect(accessibilitySeverity('minor')).toBe('Low');
  });

  it('keeps its findings in a step result', () => {
    const step = { index: 0, type: 'accessibility', status: 'pass', duration_ms: 1, started_at: '', finished_at: '', accessibility: { name: 'p', url: 'u', standard: 'wcag21aa', violations: [alt], needs_review: 0 } };
    expect(stepResultSchema.parse(step).accessibility?.violations[0]?.rule).toBe('image-alt');
  });
});

describe('accessibility in the summary', () => {
  it('merges one page checked by several accounts, worst first, keeping the most places', () => {
    const lines = accessibilityFindings([checked('qa-user-1', [contrast]), checked('qa-user-2', [{ ...contrast, count: 5 }, alt], 'http://localhost:8080/a11y', 2)]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Accessibility · shop-page (/a11y): 2 problems against WCAG 2.1 AA, the worst critical (High to start).');
    expect(lines[0]).toContain('Images must have alternative text (critical, 1 place');
    expect(lines[0]).toContain('(serious, 5 places, such as `.faint`)');
    expect(lines[0]?.indexOf('alternative text')).toBeLessThan(lines[0]?.indexOf('contrast') ?? 0);
    expect(lines[0]).toContain('2 checks need a person to look.');
  });

  it('says a passing run with accessibility problems still has something to fix', () => {
    const text = summaryMarkdown([checked('qa-user-1', [label])], 'passed');
    expect(text.split('\n')[0]).toContain('but the accessibility check found problems');
    expect(text).toContain('- Accessibility · shop-page (/a11y): 1 problem');
    expect(text).not.toContain('Nothing needs a change.');
  });

  it('reports a clean page and keeps the passing wording', () => {
    const text = summaryMarkdown([checked('qa-user-1', [])], 'passed');
    expect(text).toContain('Accessibility · shop-page (/a11y): no problems found against WCAG 2.1 AA.');
    expect(text).toContain('Nothing needs a change.');
  });

  it('keeps a single-page app route in the page address', () => {
    expect(accessibilityFindings([checked('qa-user-1', [], 'http://localhost:4300/#/checkout')])[0]).toContain('shop-page (/#/checkout)');
  });

  it('points to the full file when a page has more than four problems', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((rule) => ({ rule, impact: 'minor', help: `Rule ${rule}`, count: 1, example: rule }));
    expect(accessibilityFindings([checked('qa-user-1', many)])[0]).toContain("and 2 more in the page's accessibility file");
  });
});
