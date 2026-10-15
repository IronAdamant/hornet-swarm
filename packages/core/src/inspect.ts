/**
 * What the `inspect` step saves: a map of one page for drafting a journey. Every selector is one a
 * journey step accepts. `checked` means the selector matched exactly one element when the page
 * was read. A role selector is not checked, because only Playwright can resolve it.
 */
export type PageMap = {
  url: string;
  title: string;
  headings: string[];
  links: { text: string; href: string; selector: string; checked: boolean }[];
  buttons: { text: string; selector: string; checked: boolean; disabled: boolean }[];
  fields: {
    kind: string;
    label: string;
    selector: string;
    checked: boolean;
    required: boolean;
    /** A dropdown's choices, as a person sees them, for a `select` step's `label`. */
    options?: string[];
  }[];
  /** The page's visible words, without dropdown options, cut to 3,000 characters. */
  text: string;
  /** How many of each kind were left out to keep the map short. */
  left_out: { links: number; buttons: number; fields: number };
};

export const PAGE_MAP_LIMITS = { headings: 20, links: 60, buttons: 40, fields: 40, options: 15, text: 3_000 };
