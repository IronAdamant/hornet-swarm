import { z } from 'zod';
import { forbiddenClaims } from './report-wording-guard.js';

const SLUG = z.string().regex(/^[a-z0-9-]+$/, 'use lower-case letters, digits, and hyphens');

/** Names the brand on a report. Checked for claim words here so a bad name fails when the config is read, not at the end of a run. */
const brandText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => forbiddenClaims(text).length === 0, 'a brand field may not say compliant, certified, or similar, because it is printed on every report');

export const brandDetailsSchema = z
  .object({
    name: brandText(80),
    /** A PNG, JPEG, or SVG. A relative path is read from beside the file that names it. */
    logo: z.string().min(1).optional(),
    logo_alt: brandText(120).optional(),
    website: z.string().url().optional(),
    contact_email: z.string().email().optional(),
    contact_phone: z.string().min(3).max(40).optional(),
  })
  .strict();

export type BrandDetails = z.infer<typeof brandDetailsSchema>;

/**
 * Who a report is from. The default is `agency`: an agency resells the service under its own name,
 * so a report never shows Iron Adamant unless the job or the global config asks for it.
 */
export const brandingSchema = z
  .object({
    use: z.enum(['agency', 'iron_adamant']).optional(),
    agency: brandDetailsSchema.optional(),
    /** Logo and contact details for Iron Adamant's own reports. The name is always Iron Adamant. */
    iron_adamant: brandDetailsSchema.omit({ name: true }).strict().optional(),
  })
  .strict();

export type BrandingConfig = z.infer<typeof brandingSchema>;

export const JOURNEY_KINDS = ['sign_up', 'login', 'cart', 'checkout'] as const;
export type JourneyKind = (typeof JOURNEY_KINDS)[number];

export const RETEST_CADENCES = ['weekly', 'fortnightly', 'monthly'] as const;
export const SEVERITY_LEVELS = ['High', 'Medium', 'Low'] as const;

/**
 * A saved job: which project and journeys to run for one client, how the report is branded, and
 * how often the re-test is due. `hornet-swarm retest --job <file>` runs it again and compares.
 */
export const clientJobSchema = z
  .object({
    version: z.literal(1),
    id: SLUG,
    project: SLUG,
    client: z
      .object({
        business_name: brandText(120),
        site_name: brandText(120),
        site_url: z.string().url(),
      })
      .strict(),
    standard: z.literal('wcag22aa').default('wcag22aa'),
    branding: brandingSchema.optional(),
    /** Journey ids in the project. `covers` says which of the four reported journeys each one is. */
    journeys: z.array(z.object({ id: SLUG, covers: z.enum(JOURNEY_KINDS).optional() }).strict()).min(1),
    /** Labels to run. All of the project's labels when left out. */
    users: z.array(z.string().regex(/^qa-user-\d+$/)).optional(),
    /** A reported journey left out on purpose, and why, such as sign-up on a shared site. */
    not_in_scope: z.array(z.object({ covers: z.enum(JOURNEY_KINDS), reason: z.string().min(1) }).strict()).default([]),
    /** A reviewer's grade for one issue, by the key shown beside it in the report, with the reason. */
    severity_overrides: z.array(z.object({ issue: z.string().min(1), severity: z.enum(SEVERITY_LEVELS), reason: z.string().min(1) }).strict()).default([]),
    /** An automated finding a reviewer checked and found to be wrong. It is listed as withdrawn, with the reason, never dropped silently. */
    withdrawn_issues: z.array(z.object({ issue: z.string().min(1), reason: z.string().min(1) }).strict()).default([]),
    schedule: z.object({ cadence: z.enum(RETEST_CADENCES).default('monthly') }).strict().default({ cadence: 'monthly' }),
  })
  .strict()
  .superRefine((job, context) => {
    for (const [index, entry] of job.not_in_scope.entries()) {
      if (job.journeys.some((journey) => journey.covers === entry.covers)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['not_in_scope', index, 'covers'], message: `${entry.covers} is covered by a journey in this job, so it cannot also be out of scope` });
      }
    }
  });

export type ClientJob = z.infer<typeof clientJobSchema>;

export const RETEST_INTERVAL_DAYS: Readonly<Record<(typeof RETEST_CADENCES)[number], number>> = Object.freeze({ weekly: 7, fortnightly: 14, monthly: 28 });
