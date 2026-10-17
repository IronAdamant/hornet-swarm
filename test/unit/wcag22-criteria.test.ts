import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  CRITERION_OUTCOMES,
  CriterionVerdict,
  PARSING_CRITERION,
  WCAG22_AA_CRITERIA,
  WCAG22_NEW_CRITERIA,
  accessibilityTags,
  criteriaFromTags,
  decideAllCriteria,
  outcomeAllowed,
  savedOutcomeProblem,
  wcagCriterion,
  withoutObsoleteCriteria,
  type CriterionEvidence,
} from '../../packages/core/src/index.ts';
import { clientReportSchema } from '../../packages/report/src/client-report-model.ts';
import { fixtureReport } from '../support/client-report-fixture.ts';

type AxeRule = { ruleId: string; tags: string[] };
const axe = createRequire(import.meta.url)('../../packages/runner/node_modules/axe-core') as { getRules: (tags?: string[]) => AxeRule[] };

describe('the WCAG 2.2 A and AA criteria', () => {
  it('lists all 55 success criteria once, without 4.1.1 Parsing', () => {
    const ids = WCAG22_AA_CRITERIA.map((criterion) => criterion.id);
    expect(ids).toHaveLength(55);
    expect(new Set(ids).size).toBe(55);
    expect(ids).not.toContain('4.1.1');
    expect(WCAG22_AA_CRITERIA.every((criterion) => criterion.manualNote.length > 0)).toBe(true);
  });

  it('includes the six new 2.2 criteria at their levels', () => {
    expect(WCAG22_NEW_CRITERIA.map((criterion) => [criterion.id, criterion.level])).toEqual([
      ['2.4.11', 'AA'],
      ['2.5.7', 'AA'],
      ['2.5.8', 'AA'],
      ['3.2.6', 'A'],
      ['3.3.7', 'A'],
      ['3.3.8', 'AA'],
    ]);
  });

  it('treats 4.1.1 Parsing as obsolete', () => {
    expect(PARSING_CRITERION.obsolete).toBe(true);
    expect(wcagCriterion('4.1.1')).toBe(PARSING_CRITERION);
    expect(outcomeAllowed(PARSING_CRITERION, 'obsolete')).toBe(true);
    for (const outcome of CRITERION_OUTCOMES.filter((entry) => entry !== 'obsolete')) expect(outcomeAllowed(PARSING_CRITERION, outcome)).toBe(false);
    const findings = [{ rule: 'duplicate-id', criteria: ['4.1.1'] }, { rule: 'button-name', criteria: ['4.1.2'] }, { rule: 'mixed', criteria: ['4.1.1', '1.3.1'] }];
    expect(withoutObsoleteCriteria(findings, 'wcag22aa').map((entry) => entry.rule)).toEqual(['button-name', 'mixed']);
    expect(withoutObsoleteCriteria(findings, 'wcag21aa')).toHaveLength(3);
  });

  it('calls only criteria a check cannot miss automated', () => {
    expect(WCAG22_AA_CRITERIA.filter((criterion) => criterion.automation === 'automated').map((criterion) => criterion.id)).toEqual(['1.4.3', '2.5.8']);
  });

  it('marks every new 2.2 criterion as partly automated or automated, never untested', () => {
    expect(Object.fromEntries(WCAG22_NEW_CRITERIA.map((criterion) => [criterion.id, criterion.automation]))).toEqual({ '2.4.11': 'partial', '2.5.7': 'partial', '2.5.8': 'automated', '3.2.6': 'partial', '3.3.7': 'partial', '3.3.8': 'partial' });
    for (const criterion of WCAG22_NEW_CRITERIA.filter((entry) => entry.id !== '2.5.8')) expect(criterion.checks?.length).toBeGreaterThan(0);
  });
});

describe('the axe-core configuration', () => {
  // A tag-based run leaves out axe-core's experimental and deprecated rules unless asked for them.
  const selected = axe.getRules(accessibilityTags('wcag22aa')).filter((rule) => !rule.tags.includes('experimental') && !rule.tags.includes('deprecated'));

  it('runs the WCAG 2.2 AA rules, including target size', () => {
    expect(accessibilityTags()).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
    const target = selected.find((rule) => rule.ruleId === 'target-size');
    expect(target?.tags).toContain('wcag22aa');
    expect(criteriaFromTags(target?.tags ?? [])).toEqual(['2.5.8']);
  });

  it('does not run the rules that only test 4.1.1 Parsing', () => {
    const ids = selected.map((rule) => rule.ruleId);
    expect(ids).not.toContain('duplicate-id');
    expect(ids).not.toContain('duplicate-id-active');
  });

  it('maps every A and AA criterion a selected rule cites to the catalogue, as at least partly automated', () => {
    const cited = new Set(selected.flatMap((rule) => criteriaFromTags(rule.tags)));
    // 2.1.3 Keyboard (No Exception) is AAA. axe-core cites it beside 2.1.1, and the report leaves it off.
    const outside = [...cited].filter((id) => !wcagCriterion(id) || wcagCriterion(id)?.obsolete);
    expect(outside).toEqual(['2.1.3']);
    for (const id of cited) if (wcagCriterion(id)) expect(wcagCriterion(id)?.automation, id).not.toBe('manual');
  });
});

const NOTHING_FOUND: CriterionEvidence = { tested: true, issues: 0, needsReview: 0 };

describe('a criterion verdict', () => {
  it('never marks a partly automated or manual criterion as clear, whatever the evidence', () => {
    for (const criterion of WCAG22_AA_CRITERIA.filter((entry) => entry.automation !== 'automated')) {
      for (const evidence of [NOTHING_FOUND, { tested: false, issues: 0, needsReview: 0 }, { tested: true, issues: 0, needsReview: 4 }]) {
        expect(CriterionVerdict.decide(criterion, evidence).outcome, criterion.id).not.toBe('no_issues_found');
      }
    }
  });

  it('says a manual criterion needs a person even when it was not reached', () => {
    const manual = WCAG22_AA_CRITERIA.find((criterion) => criterion.automation === 'manual');
    expect(manual && CriterionVerdict.decide(manual, { tested: false, issues: 0, needsReview: 0 }).outcome).toBe('needs_manual_review');
  });

  it('lets an automated criterion read as no issues found only when nothing was left undecided', () => {
    const contrast = wcagCriterion('1.4.3');
    if (!contrast) throw new Error('1.4.3 is missing');
    expect(CriterionVerdict.decide(contrast, NOTHING_FOUND).outcome).toBe('no_issues_found');
    expect(CriterionVerdict.decide(contrast, NOTHING_FOUND).words).toBe('No issues found by automated checks on the tested pages');
    expect(CriterionVerdict.decide(contrast, { tested: true, issues: 0, needsReview: 2 }).outcome).toBe('needs_manual_review');
    expect(CriterionVerdict.decide(contrast, { tested: true, issues: 1, needsReview: 0 }).outcome).toBe('issues_found');
    expect(CriterionVerdict.decide(contrast, { tested: false, issues: 0, needsReview: 0 }).outcome).toBe('not_tested');
  });

  it('cannot be made except by deciding it', () => {
    const forged = { criterion: wcagCriterion('2.1.1'), outcome: 'no_issues_found', evidence: NOTHING_FOUND, words: 'x' };
    expect(CriterionVerdict.isDecided(forged)).toBe(false);
    const Construct = CriterionVerdict as unknown as new (...args: unknown[]) => CriterionVerdict;
    expect(() => new Construct(wcagCriterion('2.1.1'), 'no_issues_found', NOTHING_FOUND)).toThrow(/cannot be reported as no_issues_found/);
    expect(decideAllCriteria(() => NOTHING_FOUND).every((verdict) => CriterionVerdict.isDecided(verdict))).toBe(true);
  });

  it('refuses a saved report whose rows were edited to mark a manual criterion clear', () => {
    expect(savedOutcomeProblem('2.1.1', 'no_issues_found')).toMatch(/cannot be reported/);
    expect(savedOutcomeProblem('2.5.8', 'no_issues_found')).toBeUndefined();
    expect(savedOutcomeProblem('9.9.9', 'issues_found')).toMatch(/not a WCAG 2.2/);
    const report = fixtureReport();
    const tampered = structuredClone(report);
    const keyboard = tampered.criteria.find((row) => row.id === '2.1.1');
    if (!keyboard) throw new Error('2.1.1 row is missing');
    keyboard.outcome = 'no_issues_found';
    expect(clientReportSchema.safeParse(report).success).toBe(true);
    expect(clientReportSchema.safeParse(tampered).success).toBe(false);
  });
});
