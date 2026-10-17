/**
 * The WCAG 2.2 success criteria at levels A and AA, which together make up a 2.2 AA check, and how
 * far this harness can check each one.
 *
 * - `automated`: the checks cannot miss a failure on the elements they evaluate, and an element
 *   they cannot evaluate comes back as needing review. The criterion's exceptions only ever excuse
 *   a failure, so a reviewer may withdraw a flagged issue but no unflagged failure hides behind one.
 * - `partial`: some failures are caught, but others need a person. A partial criterion is never
 *   reported as free of issues.
 * - `manual`: only a person can judge it.
 *
 * 4.1.1 Parsing was removed in WCAG 2.2. It is kept here, marked obsolete, so a result that cites
 * it is recognised and left out instead of counted.
 */
export type WcagLevel = 'A' | 'AA';
export type WcagVersion = '2.0' | '2.1' | '2.2';
export type CriterionAutomation = 'automated' | 'partial' | 'manual';

/** A harness check, beyond axe-core, that runs inside the accessibility step on a WCAG 2.2 AA check. */
export type SupplementalCheck = 'focus-not-obscured' | 'dragging-movements' | 'consistent-help' | 'redundant-entry' | 'accessible-authentication';

export type WcagCriterion = {
  readonly id: string;
  readonly title: string;
  readonly level: WcagLevel;
  readonly introduced: WcagVersion;
  readonly automation: CriterionAutomation;
  /** Harness checks that look for this criterion's failures, beyond the axe-core rules tagged with it. */
  readonly checks?: readonly SupplementalCheck[];
  /** What a person still has to look at. Shown beside the criterion in a client report. */
  readonly manualNote: string;
  readonly obsolete?: true;
};

type Row = [id: string, title: string, level: WcagLevel, introduced: WcagVersion, automation: CriterionAutomation, manualNote: string, checks?: SupplementalCheck[]];

const ROWS: Row[] = [
  ['1.1.1', 'Non-text Content', 'A', '2.0', 'partial', 'Whether each image description says what the image is for.'],
  ['1.2.1', 'Audio-only and Video-only (Prerecorded)', 'A', '2.0', 'manual', 'A transcript or description for any audio-only or video-only media.'],
  ['1.2.2', 'Captions (Prerecorded)', 'A', '2.0', 'partial', 'Whether captions are present, accurate, and in sync.'],
  ['1.2.3', 'Audio Description or Media Alternative (Prerecorded)', 'A', '2.0', 'manual', 'An audio description or text alternative for video.'],
  ['1.2.4', 'Captions (Live)', 'AA', '2.0', 'manual', 'Captions on any live video.'],
  ['1.2.5', 'Audio Description (Prerecorded)', 'AA', '2.0', 'manual', 'An audio description track for video.'],
  ['1.3.1', 'Info and Relationships', 'A', '2.0', 'partial', 'Whether headings, lists, tables, and form groups are marked up as what they look like.'],
  ['1.3.2', 'Meaningful Sequence', 'A', '2.0', 'manual', 'Whether the reading order makes sense with styles turned off.'],
  ['1.3.3', 'Sensory Characteristics', 'A', '2.0', 'manual', 'Instructions that rely only on shape, colour, size, or position.'],
  ['1.3.4', 'Orientation', 'AA', '2.1', 'manual', 'Whether the site works in both portrait and landscape.'],
  ['1.3.5', 'Identify Input Purpose', 'AA', '2.1', 'partial', 'Whether fields asking for the customer\'s own details say what they are for, so a browser can fill them in.'],
  ['1.4.1', 'Use of Color', 'A', '2.0', 'partial', 'Information shown only by colour, such as a red field with no message.'],
  ['1.4.2', 'Audio Control', 'A', '2.0', 'partial', 'A way to stop sound that plays by itself.'],
  ['1.4.3', 'Contrast (Minimum)', 'AA', '2.0', 'automated', 'Text over images or gradients, which the automated check hands to a person.'],
  ['1.4.4', 'Resize Text', 'AA', '2.0', 'partial', 'Whether the page still works zoomed to 200%.'],
  ['1.4.5', 'Images of Text', 'AA', '2.0', 'manual', 'Text shown as a picture instead of real text.'],
  ['1.4.10', 'Reflow', 'AA', '2.1', 'manual', 'Whether the page works at 320 pixels wide without scrolling sideways.'],
  ['1.4.11', 'Non-text Contrast', 'AA', '2.1', 'manual', 'The contrast of field borders, icons, and focus outlines.'],
  ['1.4.12', 'Text Spacing', 'AA', '2.1', 'partial', 'Whether text still fits when a reader widens the spacing.'],
  ['1.4.13', 'Content on Hover or Focus', 'AA', '2.1', 'manual', 'Tooltips and pop-ups that can be dismissed and stay while read.'],
  ['2.1.1', 'Keyboard', 'A', '2.0', 'partial', 'Whether every control works with the keyboard alone.'],
  ['2.1.2', 'No Keyboard Trap', 'A', '2.0', 'manual', 'Whether keyboard focus can always leave a widget.'],
  ['2.1.4', 'Character Key Shortcuts', 'A', '2.1', 'manual', 'Single-key shortcuts that can be turned off or changed.'],
  ['2.2.1', 'Timing Adjustable', 'A', '2.0', 'partial', 'Time limits, such as a checkout session, that can be extended.'],
  ['2.2.2', 'Pause, Stop, Hide', 'A', '2.0', 'partial', 'Moving content, such as a carousel, that can be paused.'],
  ['2.3.1', 'Three Flashes or Below Threshold', 'A', '2.0', 'manual', 'Content that flashes more than three times a second.'],
  ['2.4.1', 'Bypass Blocks', 'A', '2.0', 'partial', 'A working skip link or landmarks to jump past the menu.'],
  ['2.4.2', 'Page Titled', 'A', '2.0', 'partial', 'Whether each page title says what the page is.'],
  ['2.4.3', 'Focus Order', 'A', '2.0', 'manual', 'Whether keyboard focus moves in an order that makes sense.'],
  ['2.4.4', 'Link Purpose (In Context)', 'A', '2.0', 'partial', 'Whether each link says where it goes, such as no lone "click here".'],
  ['2.4.5', 'Multiple Ways', 'AA', '2.0', 'manual', 'More than one way to find a page, such as a menu and a search.'],
  ['2.4.6', 'Headings and Labels', 'AA', '2.0', 'manual', 'Whether headings and labels describe what follows them.'],
  ['2.4.7', 'Focus Visible', 'AA', '2.0', 'manual', 'A visible outline on whatever has keyboard focus.'],
  ['2.4.11', 'Focus Not Obscured (Minimum)', 'AA', '2.2', 'partial', 'Focus hidden by a banner or chat window that only appears after interaction.', ['focus-not-obscured']],
  ['2.5.1', 'Pointer Gestures', 'A', '2.1', 'manual', 'Pinch, swipe, or multi-finger gestures with a single-tap alternative.'],
  ['2.5.2', 'Pointer Cancellation', 'A', '2.1', 'manual', 'Actions that happen on release, so a slip can be cancelled.'],
  ['2.5.3', 'Label in Name', 'A', '2.1', 'manual', 'Whether a control\'s spoken name includes the words shown on it.'],
  ['2.5.4', 'Motion Actuation', 'A', '2.1', 'manual', 'Shake or tilt actions with an on-screen alternative.'],
  ['2.5.7', 'Dragging Movements', 'AA', '2.2', 'partial', 'Whether everything done by dragging, such as a slider or a sortable list, can also be done with single clicks or taps.', ['dragging-movements']],
  ['2.5.8', 'Target Size (Minimum)', 'AA', '2.2', 'automated', 'Small targets the automated check could not measure, and targets the reviewer judges essential or duplicated elsewhere.'],
  ['3.1.1', 'Language of Page', 'A', '2.0', 'partial', 'Whether the declared language is the one the page is written in.'],
  ['3.1.2', 'Language of Parts', 'AA', '2.0', 'partial', 'Passages in another language marked as such.'],
  ['3.2.1', 'On Focus', 'A', '2.0', 'manual', 'Whether focusing a control changes the page by surprise.'],
  ['3.2.2', 'On Input', 'A', '2.0', 'manual', 'Whether changing a field changes the page by surprise.'],
  ['3.2.3', 'Consistent Navigation', 'AA', '2.0', 'manual', 'Menus in the same order on every page.'],
  ['3.2.4', 'Consistent Identification', 'AA', '2.0', 'manual', 'The same thing named the same way on every page.'],
  ['3.2.6', 'Consistent Help', 'A', '2.2', 'partial', 'Help such as a phone number, contact page, or chat in the same place on every page that has it.', ['consistent-help']],
  ['3.3.1', 'Error Identification', 'A', '2.0', 'manual', 'Whether a form says which field is wrong, in words.'],
  ['3.3.2', 'Labels or Instructions', 'A', '2.0', 'partial', 'Whether fields explain the format they expect.'],
  ['3.3.3', 'Error Suggestion', 'AA', '2.0', 'manual', 'Whether an error message says how to fix it.'],
  ['3.3.4', 'Error Prevention (Legal, Financial, Data)', 'AA', '2.0', 'manual', 'A chance to review, correct, or cancel an order before it is placed.'],
  ['3.3.7', 'Redundant Entry', 'A', '2.2', 'partial', 'Details asked for twice in one process, such as a delivery address typed again for billing with no "same as" option.', ['redundant-entry']],
  ['3.3.8', 'Accessible Authentication (Minimum)', 'AA', '2.2', 'partial', 'Puzzles or memory tests at sign-in, and whether a password manager or pasting can fill the password.', ['accessible-authentication']],
  ['4.1.2', 'Name, Role, Value', 'A', '2.0', 'partial', 'Custom controls, such as dropdowns built from divs, that a screen reader cannot use.'],
  ['4.1.3', 'Status Messages', 'AA', '2.1', 'manual', 'Messages such as "Added to cart" announced without moving focus.'],
];

export const WCAG22_AA_CRITERIA: readonly WcagCriterion[] = Object.freeze(
  ROWS.map(([id, title, level, introduced, automation, manualNote, checks]) => Object.freeze({ id, title, level, introduced, automation, manualNote, ...(checks ? { checks } : {}) })),
);

export const PARSING_CRITERION: WcagCriterion = Object.freeze({
  id: '4.1.1',
  title: 'Parsing',
  level: 'A',
  introduced: '2.0',
  automation: 'manual',
  manualNote: 'Removed in WCAG 2.2. Problems it used to cover are checked under 1.3.1 and 4.1.2.',
  obsolete: true,
});

const BY_ID = new Map<string, WcagCriterion>([...WCAG22_AA_CRITERIA, PARSING_CRITERION].map((criterion) => [criterion.id, criterion]));

export function wcagCriterion(id: string): WcagCriterion | undefined {
  return BY_ID.get(id);
}

/** The new success criteria in WCAG 2.2 at levels A and AA. */
export const WCAG22_NEW_CRITERIA: readonly WcagCriterion[] = WCAG22_AA_CRITERIA.filter((criterion) => criterion.introduced === '2.2');

/** The criteria a supplemental check looks at. */
export function criteriaForCheck(check: SupplementalCheck): string[] {
  return WCAG22_AA_CRITERIA.filter((criterion) => criterion.checks?.includes(check)).map((criterion) => criterion.id);
}

/** axe-core tags a criterion as `wcag` and its digits, so `wcag2411` is 2.4.11 and `wcag258` is 2.5.8. */
export function criteriaFromTags(tags: readonly string[]): string[] {
  const ids = tags.flatMap((tag) => {
    const match = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
    return match ? [`${match[1]}.${match[2]}.${match[3]}`] : [];
  });
  return [...new Set(ids)];
}

/** True when every criterion cited is 4.1.1 Parsing, which WCAG 2.2 no longer has. */
export function onlyObsoleteCriteria(criteria: readonly string[]): boolean {
  return criteria.length > 0 && criteria.every((id) => wcagCriterion(id)?.obsolete === true);
}
