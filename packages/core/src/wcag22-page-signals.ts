import { z } from 'zod';

export const HELP_KINDS = ['contact', 'help', 'faq', 'phone', 'email', 'chat'] as const;
export type HelpKind = (typeof HELP_KINDS)[number];

/**
 * What the accessibility step saw on one page for the WCAG 2.2 criteria axe-core does not cover.
 * Each list holds element selectors, never what a customer typed.
 */
export const wcag22PageSignalsSchema = z
  .object({
    /** 2.4.11: focusable elements given focus one at a time, and those left entirely covered by other content. */
    focus_not_obscured: z
      .object({
        checked: z.number().int().nonnegative(),
        hidden: z.array(z.object({ target: z.string(), covered_by: z.string() }).strict()),
      })
      .strict(),
    /** 2.5.7: elements that are moved by dragging. A person checks each has a single-pointer alternative. */
    dragging: z.array(z.object({ target: z.string(), reason: z.string() }).strict()),
    /** 3.2.6: help mechanisms in page order. The report compares the order across pages. */
    help: z.array(z.object({ kind: z.enum(HELP_KINDS), label: z.string() }).strict()),
    /** 3.3.8: password fields, and anything that stops a password manager or pasting from filling them. */
    authentication: z
      .object({
        password_fields: z.number().int().nonnegative(),
        paste_blocked: z.array(z.string()),
        autocomplete_off: z.array(z.string()),
        puzzle: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type Wcag22PageSignals = z.infer<typeof wcag22PageSignalsSchema>;

/** 3.3.7: a field that had to be typed again with a value an earlier step of the journey already gave on another page. */
export const redundantEntrySchema = z.object({ earlier_step: z.number().int().nonnegative(), field: z.string() }).strict();

export type RedundantEntry = z.infer<typeof redundantEntrySchema>;
