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

/** A phone-sized viewport is 390 by 844, about the size of a current phone. */
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

export const viewportStep = z
  .object({
    viewport: z
      .object({
        preset: z.literal('phone').optional(),
        width: z.number().int().positive().max(4000).optional(),
        height: z.number().int().positive().max(4000).optional(),
      })
      .strict()
      .refine((value) => value.preset === 'phone' || (value.width !== undefined && value.height !== undefined), 'a viewport step needs a phone preset or a width and a height'),
  })
  .strict();

const NAV_KEYS = ['Tab', 'Shift+Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'] as const;

/** Keyboard-only navigation. It presses one of the navigation keys. It does not type text. */
export const keyboardStep = z
  .object({
    keyboard: z
      .object({
        key: z.enum(NAV_KEYS),
        times: z.number().int().positive().max(30).optional(),
      })
      .strict(),
  })
  .strict();

