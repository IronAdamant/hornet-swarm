import { CRITERION_OUTCOME_WORDS, CRITERION_OUTCOMES, JOURNEY_KINDS, SEVERITY_LEVELS, savedOutcomeProblem, wcagCriterion } from '@hornet-swarm/core';
import { z } from 'zod';

export const CLIENT_REPORT_SCHEMA_VERSION = 1;

const RELATIVE_PATH = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'evidence is named by its path inside the run folder');

export const resolvedBrandSchema = z
  .object({
    prepared_by: z.enum(['agency', 'iron_adamant']),
    name: z.string().min(1),
    /** The logo, embedded so the report opens on its own. */
    logo_data_uri: z.string().regex(/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/).optional(),
    logo_alt: z.string().optional(),
    website: z.string().optional(),
    contact_email: z.string().optional(),
    contact_phone: z.string().optional(),
  })
  .strict();

export type ResolvedBrand = z.infer<typeof resolvedBrandSchema>;

export const issueSchema = z
  .object({
    /** Stable across runs, so a re-test can say whether it is new, fixed, or still open. */
    key: z.string().min(1),
    id: z.string().regex(/^[A-Z]-\d{2,}$/),
    source: z.enum(['accessibility', 'wcag22', 'journey']),
    severity: z.enum(SEVERITY_LEVELS),
    severity_reason: z.string().min(1),
    title: z.string().min(1),
    where: z.array(z.object({ page: z.string(), address: z.string(), places: z.number().int().nonnegative(), example: z.string().optional() }).strict()).min(1),
    why_it_matters: z.string().min(1),
    how_to_fix: z.string().min(1),
    criteria: z.array(z.string()),
    evidence: z.array(RELATIVE_PATH),
  })
  .strict();

export type ClientIssue = z.infer<typeof issueSchema>;

export const JOURNEY_RESULTS = ['worked', 'failed', 'blocked', 'not_tested', 'out_of_scope'] as const;
export type JourneyResultStatus = (typeof JOURNEY_RESULTS)[number];

export const journeyResultSchema = z
  .object({
    kind: z.enum([...JOURNEY_KINDS, 'other']),
    title: z.string().min(1),
    status: z.enum(JOURNEY_RESULTS),
    summary: z.string().min(1),
    journeys: z.array(z.string()),
    evidence: z.array(RELATIVE_PATH),
  })
  .strict();

export type ClientJourneyResult = z.infer<typeof journeyResultSchema>;

export const criterionRowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    level: z.enum(['A', 'AA']),
    introduced: z.enum(['2.0', '2.1', '2.2']),
    automation: z.enum(['automated', 'partial', 'manual']),
    outcome: z.enum(CRITERION_OUTCOMES),
    outcome_words: z.string(),
    issues: z.number().int().nonnegative(),
    needs_review: z.number().int().nonnegative(),
    note: z.string(),
  })
  .strict()
  .superRefine((row, context) => {
    const problem = savedOutcomeProblem(row.id, row.outcome);
    if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ['outcome'], message: problem });
    if (row.outcome_words !== CRITERION_OUTCOME_WORDS[row.outcome]) context.addIssue({ code: z.ZodIssueCode.custom, path: ['outcome_words'], message: `must read "${CRITERION_OUTCOME_WORDS[row.outcome]}" for ${row.outcome}` });
    const criterion = wcagCriterion(row.id);
    if (criterion && (criterion.automation !== row.automation || criterion.level !== row.level)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['automation'], message: `${row.id} is ${criterion.automation}, level ${criterion.level}` });
  });

export type ClientCriterionRow = z.infer<typeof criterionRowSchema>;

export const reviewItemSchema = z.object({ criterion: z.string(), what: z.string().min(1), where: z.string() }).strict();
export type ClientReviewItem = z.infer<typeof reviewItemSchema>;

export const clientReportSchema = z
  .object({
    schema_version: z.literal(CLIENT_REPORT_SCHEMA_VERSION),
    job_id: z.string(),
    project: z.string(),
    run_id: z.string().regex(/^run_[A-Za-z0-9_-]+$/),
    tested_at: z.string(),
    standard: z.literal('wcag22aa'),
    client: z.object({ business_name: z.string(), site_name: z.string(), site_url: z.string() }).strict(),
    brand: resolvedBrandSchema,
    authorisation: z
      .object({
        id: z.string(),
        basis: z.enum(['owner', 'contract', 'public_practice']),
        authoriser: z.string().optional(),
        valid_until: z.string(),
        public_statement_url: z.string().optional(),
      })
      .strict(),
    executive_summary: z.object({ headline: z.string().min(1), paragraphs: z.array(z.string().min(1)).min(1) }).strict(),
    pages_tested: z.array(z.object({ name: z.string(), address: z.string(), accounts: z.array(z.string()) }).strict()),
    accounts: z.number().int().nonnegative(),
    journeys: z.array(journeyResultSchema),
    issues: z.array(issueSchema),
    withdrawn: z.array(z.object({ key: z.string(), title: z.string(), reason: z.string() }).strict()),
    review_items: z.array(reviewItemSchema),
    criteria: z.array(criterionRowSchema),
    scope_and_limits: z.array(z.string().min(1)).min(1),
    evidence_appendix: z.array(z.object({ path: RELATIVE_PATH, what: z.string() }).strict()),
  })
  .strict();

export type ClientReport = z.infer<typeof clientReportSchema>;

export const JOURNEY_TITLES: Readonly<Record<ClientJourneyResult['kind'], string>> = Object.freeze({
  sign_up: 'Sign-up',
  login: 'Log in',
  cart: 'Add to cart',
  checkout: 'Checkout',
  other: 'Other journey',
});
