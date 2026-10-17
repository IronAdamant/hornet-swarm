import { createHash } from 'node:crypto';
import type { RedundantEntry } from '@hornet-swarm/core';

/** Shorter values, such as a quantity of 1 or a two-letter state, repeat for reasons that are not re-entry. */
const MIN_TRACKED_LENGTH = 3;

/**
 * WCAG 2.2 3.3.7: a process should not ask for something the customer already gave in it. The
 * tracker remembers, for one journey, a hash of each value typed and the page it was typed on. A
 * later fill of the same value on another page, into a field that was empty, is a re-entry a
 * person should check, for example a billing address with no "same as delivery" option.
 *
 * Only hashes are kept, so a typed value never sits in the tracker. Logins and one-time codes are
 * never passed in: a password typed twice to confirm it is allowed by the criterion.
 */
export class RedundantEntryTracker {
  readonly #typed = new Map<string, { step: number; page: string }>();

  /** Call before the fill. `before` is what the field held, so a field the site pre-filled is not counted. */
  observe(input: { step: number; page: string; field: string; value: string; before: string }): RedundantEntry | undefined {
    if (input.value.length < MIN_TRACKED_LENGTH) return undefined;
    const key = createHash('sha256').update(input.value).digest('hex');
    const earlier = this.#typed.get(key);
    if (!earlier) {
      this.#typed.set(key, { step: input.step, page: input.page });
      return undefined;
    }
    if (earlier.page === input.page || input.before === input.value) return undefined;
    return { earlier_step: earlier.step, field: input.field };
  }
}

/** The page a field sits on: path and hash, so single-page app routes such as /#/checkout count as pages. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.hash}`;
  } catch {
    return url;
  }
}
