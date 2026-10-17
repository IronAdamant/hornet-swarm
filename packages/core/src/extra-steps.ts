import { z } from 'zod';

/** Shopify's storefront password page: one password field in a form that posts to /password. */
export const storefrontPasswordStep = z
  .object({
    storefront_password: z.object({ credential: z.string() }).strict(),
  })
  .strict();

/**
 * Reads a code from the test inbox and types it. A journey that omits this step never opens the
 * inbox. It does not solve a captcha, and it does not read the owner's own mail.
 */
export const inboxStep = z
  .object({
    inbox: z
      .object({
        mailbox: z.string().regex(/^[a-z0-9-]+$/),
        selector: z.string(),
        frame: z.string().optional(),
      })
      .strict(),
  })
  .strict();
