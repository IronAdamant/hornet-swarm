import { WCAG22_AA_CRITERIA, wcagCriterion, type WcagCriterion } from './wcag22-criteria.js';

/**
 * What a report may say about one criterion. There is no "pass": the most an automated check can
 * say is that it found nothing on the pages it tested.
 */
export const CRITERION_OUTCOMES = ['issues_found', 'no_issues_found', 'needs_manual_review', 'not_tested', 'obsolete'] as const;
export type CriterionOutcome = (typeof CRITERION_OUTCOMES)[number];

export const CRITERION_OUTCOME_WORDS: Readonly<Record<CriterionOutcome, string>> = Object.freeze({
  issues_found: 'Issues found',
  no_issues_found: 'No issues found by automated checks on the tested pages',
  needs_manual_review: 'Needs manual review',
  not_tested: 'Not tested',
  obsolete: 'Not part of WCAG 2.2',
});

export type CriterionEvidence = {
  /** At least one page was checked by a standard that covers this criterion. */
  tested: boolean;
  issues: number;
  /** Checks that could not decide, and supplemental flags a person has to confirm. */
  needsReview: number;
};

/**
 * The rule every report row follows. Only an automated criterion can come out as no issues found,
 * and only with nothing left to review. A partial or manual criterion with no issue found still
 * needs a person.
 */
export function outcomeAllowed(criterion: WcagCriterion, outcome: CriterionOutcome): boolean {
  if (criterion.obsolete) return outcome === 'obsolete';
  if (outcome === 'obsolete') return false;
  if (outcome === 'no_issues_found') return criterion.automation === 'automated';
  if (outcome === 'not_tested') return criterion.automation !== 'manual';
  return true;
}

/**
 * A decided criterion row. The private field makes the type nominal, so `decide` is the only way to
 * get one, and a report renderer that takes these cannot be handed a row that claims a manual
 * criterion is clear.
 */
export class CriterionVerdict {
  readonly #decided = true;

  private constructor(
    readonly criterion: WcagCriterion,
    readonly outcome: CriterionOutcome,
    readonly evidence: Readonly<CriterionEvidence>,
  ) {
    if (!outcomeAllowed(criterion, outcome)) throw new Error(`${criterion.id} ${criterion.title} cannot be reported as ${outcome}.`);
  }

  static decide(criterion: WcagCriterion, evidence: CriterionEvidence): CriterionVerdict {
    return new CriterionVerdict(criterion, decideOutcome(criterion, evidence), Object.freeze({ ...evidence }));
  }

  static isDecided(value: unknown): value is CriterionVerdict {
    return typeof value === 'object' && value !== null && #decided in value;
  }

  get words(): string {
    return CRITERION_OUTCOME_WORDS[this.outcome];
  }
}

function decideOutcome(criterion: WcagCriterion, evidence: CriterionEvidence): CriterionOutcome {
  if (criterion.obsolete) return 'obsolete';
  if (criterion.automation === 'manual') return 'needs_manual_review';
  if (!evidence.tested) return 'not_tested';
  if (evidence.issues > 0) return 'issues_found';
  if (criterion.automation === 'automated' && evidence.needsReview === 0) return 'no_issues_found';
  return 'needs_manual_review';
}

/** One verdict per WCAG 2.2 A and AA criterion, in the standard's order. */
export function decideAllCriteria(evidenceFor: (criterion: WcagCriterion) => CriterionEvidence): CriterionVerdict[] {
  return WCAG22_AA_CRITERIA.map((criterion) => CriterionVerdict.decide(criterion, evidenceFor(criterion)));
}

/** For a saved row read back from disk: refuses an outcome the criterion can never have. */
export function savedOutcomeProblem(id: string, outcome: CriterionOutcome): string | undefined {
  const criterion = wcagCriterion(id);
  if (!criterion) return `${id} is not a WCAG 2.2 A or AA criterion.`;
  return outcomeAllowed(criterion, outcome) ? undefined : `${id} ${criterion.title} cannot be reported as ${outcome}.`;
}
