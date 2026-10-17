/**
 * Plain words for each problem a client report can name: a title an owner understands, why it
 * matters to their customers, and how to fix it. The fix is written for whoever builds the site,
 * so an owner can forward it. `criteria` is used when an older run did not record axe-core's tags.
 */
export type PlainProblem = { title: string; why: string; fix: string; criteria: string[] };

const AXE_RULES: Readonly<Record<string, PlainProblem>> = {
  'image-alt': {
    title: 'Images have no description',
    why: 'Customers who use a screen reader hear nothing, or a file name, where a product photo or a button image is.',
    fix: 'Give each meaningful image an alt text that says what it shows or does. Give decorative images an empty alt (alt="").',
    criteria: ['1.1.1'],
  },
  'input-image-alt': {
    title: 'Image buttons have no description',
    why: 'A screen reader cannot say what an image used as a button does, so customers cannot tell whether to press it.',
    fix: 'Add alt text to each image button that says what it does, such as "Search".',
    criteria: ['1.1.1', '4.1.2'],
  },
  'svg-img-alt': {
    title: 'Icons have no description',
    why: 'Screen reader users miss what an icon means, such as a rating or a status.',
    fix: 'Give each meaningful SVG icon a title or aria-label, or hide decorative icons with aria-hidden="true".',
    criteria: ['1.1.1'],
  },
  'role-img-alt': {
    title: 'Picture elements have no description',
    why: 'An element marked as an image has no text, so screen reader users do not know what it shows.',
    fix: 'Add an aria-label or aria-labelledby that describes the image.',
    criteria: ['1.1.1'],
  },
  label: {
    title: 'Form fields have no label',
    why: 'Screen reader users hear "edit text" with no idea what to type, so forms such as checkout or sign-up become guesswork.',
    fix: 'Connect a visible label to each field with <label for="...">, or give the field an aria-label.',
    criteria: ['4.1.2', '1.3.1'],
  },
  'select-name': {
    title: 'Dropdowns have no label',
    why: 'Customers using a screen reader cannot tell what a dropdown chooses, such as sort order or country.',
    fix: 'Connect a visible label to each dropdown, or give it an aria-label.',
    criteria: ['4.1.2'],
  },
  'button-name': {
    title: 'Buttons have no name',
    why: 'A screen reader announces only "button", so customers cannot tell which one adds to cart, removes an item, or shows a password.',
    fix: 'Give each button visible text, or an aria-label for icon-only buttons, such as aria-label="Increase quantity".',
    criteria: ['4.1.2'],
  },
  'input-button-name': {
    title: 'Input buttons have no name',
    why: 'A screen reader cannot say what the button does.',
    fix: 'Set a value or aria-label on each input button.',
    criteria: ['4.1.2'],
  },
  'link-name': {
    title: 'Links have no name',
    why: 'A screen reader reads the link address or nothing at all, so customers cannot tell where it goes.',
    fix: 'Put text in every link, or an aria-label for icon links such as social media icons.',
    criteria: ['2.4.4', '4.1.2'],
  },
  'color-contrast': {
    title: 'Text is too faint to read easily',
    why: 'Customers with low vision, older customers, and anyone on a phone in sunlight struggle to read pale text, including prices and stock levels.',
    fix: 'Darken the text or lighten the background until the contrast is at least 4.5 to 1 (3 to 1 for large text). The saved results give each ratio.',
    criteria: ['1.4.3'],
  },
  'target-size': {
    title: 'Buttons or links are too small to tap',
    why: 'Customers with shaky hands, and anyone on a phone, miss small targets or press the one next to it.',
    fix: 'Make each target at least 24 by 24 CSS pixels, or leave enough space around it that a 24-pixel circle does not overlap a neighbour.',
    criteria: ['2.5.8'],
  },
  'html-has-lang': {
    title: 'The page does not say what language it is in',
    why: 'Screen readers may read English text with the wrong accent and pronunciation.',
    fix: 'Add lang="en-AU" (or the right language) to the <html> element.',
    criteria: ['3.1.1'],
  },
  'html-lang-valid': {
    title: 'The page names a language that does not exist',
    why: 'Screen readers cannot pick the right voice.',
    fix: 'Use a valid language code on the <html> element, such as en-AU.',
    criteria: ['3.1.1'],
  },
  'valid-lang': {
    title: 'A part of the page names a language that does not exist',
    why: 'Screen readers cannot pick the right voice for that passage.',
    fix: 'Use a valid language code on that element, such as lang="fr".',
    criteria: ['3.1.2'],
  },
  'document-title': {
    title: 'The page has no title',
    why: 'Customers with several tabs open, and screen reader users, cannot tell which page they are on.',
    fix: 'Give each page a <title> that names the page and the shop, such as "Checkout - Example Store".',
    criteria: ['2.4.2'],
  },
  bypass: {
    title: 'There is no way to skip the menu',
    why: 'Keyboard users must tab through the whole menu on every page before reaching the content.',
    fix: 'Add a "Skip to main content" link at the top, or mark the main content with a <main> landmark.',
    criteria: ['2.4.1'],
  },
  list: {
    title: 'Lists are built incorrectly',
    why: 'A screen reader cannot say how many items a list has, such as filter options, so customers lose their place.',
    fix: 'Put only <li> elements directly inside <ul> or <ol>.',
    criteria: ['1.3.1'],
  },
  listitem: {
    title: 'List items sit outside a list',
    why: 'A screen reader cannot group them, so the structure is lost.',
    fix: 'Put each <li> inside a <ul> or <ol>.',
    criteria: ['1.3.1'],
  },
  'aria-required-children': {
    title: 'A widget is missing the parts it needs',
    why: 'A screen reader announces a table, list, or menu that has nothing inside it, which is confusing.',
    fix: 'Give the element the child roles its role requires, or use the native HTML element instead.',
    criteria: ['1.3.1'],
  },
  'aria-required-parent': {
    title: 'A widget part sits outside its container',
    why: 'A screen reader cannot tell what the part belongs to.',
    fix: 'Place the element inside the container role it requires.',
    criteria: ['1.3.1'],
  },
  'aria-hidden-focus': {
    title: 'Hidden content can still be reached with the keyboard',
    why: 'Keyboard and screen reader users land on controls they cannot see or hear.',
    fix: 'Remove aria-hidden from content that can be focused, or make its controls unfocusable while hidden.',
    criteria: ['4.1.2'],
  },
  'aria-valid-attr-value': {
    title: 'Accessibility attributes have invalid values',
    why: 'Screen readers may ignore or misread the control.',
    fix: 'Correct each aria- attribute to a valid value, such as an id that exists on the page.',
    criteria: ['4.1.2'],
  },
  'aria-allowed-attr': {
    title: 'Accessibility attributes are used where they do not belong',
    why: 'Screen readers may announce the control wrongly.',
    fix: 'Remove aria- attributes the element\'s role does not support.',
    criteria: ['4.1.2'],
  },
  'aria-input-field-name': {
    title: 'Custom fields have no name',
    why: 'Screen reader users cannot tell what a custom search box or combobox is for.',
    fix: 'Give each custom field an aria-label or aria-labelledby.',
    criteria: ['4.1.2'],
  },
  'aria-toggle-field-name': {
    title: 'Custom switches or checkboxes have no name',
    why: 'Screen reader users cannot tell what a toggle turns on or off.',
    fix: 'Give each custom toggle an accessible name.',
    criteria: ['4.1.2'],
  },
  'frame-title': {
    title: 'Embedded frames have no title',
    why: 'Screen reader users cannot tell what an embedded map, video, or payment frame is.',
    fix: 'Add a title attribute to each <iframe> that says what it holds.',
    criteria: ['4.1.2'],
  },
  'nested-interactive': {
    title: 'Controls are nested inside other controls',
    why: 'Screen readers may skip the inner control, so customers cannot reach it.',
    fix: 'Do not put buttons or links inside other buttons or links.',
    criteria: ['4.1.2'],
  },
  'autocomplete-valid': {
    title: 'Address and contact fields use invalid autofill names',
    why: 'Browsers cannot fill in the customer\'s details, so customers with memory or motor difficulties must type everything.',
    fix: 'Use the standard autocomplete values, such as autocomplete="postal-code".',
    criteria: ['1.3.5'],
  },
  'meta-viewport': {
    title: 'Zooming is turned off',
    why: 'Customers with low vision cannot pinch to zoom on a phone.',
    fix: 'Remove user-scalable=no and maximum-scale from the viewport meta tag.',
    criteria: ['1.4.4'],
  },
  'link-in-text-block': {
    title: 'Links in text stand out only by colour',
    why: 'Customers who cannot tell colours apart cannot find the links.',
    fix: 'Underline links inside paragraphs, or give them another visible difference.',
    criteria: ['1.4.1'],
  },
  'scrollable-region-focusable': {
    title: 'A scrolling area cannot be scrolled with the keyboard',
    why: 'Keyboard users cannot reach the content inside it.',
    fix: 'Make the scrolling area focusable with tabindex="0", or include a focusable element inside it.',
    criteria: ['2.1.1'],
  },
  'form-field-multiple-labels': {
    title: 'A field has more than one label',
    why: 'Screen readers may read the wrong label.',
    fix: 'Keep one label per field.',
    criteria: ['3.3.2'],
  },
  'video-caption': {
    title: 'Videos have no captions',
    why: 'Deaf and hard-of-hearing customers miss what is said.',
    fix: 'Add a captions track to each video.',
    criteria: ['1.2.2'],
  },
  'meta-refresh': {
    title: 'The page reloads or moves on by itself',
    why: 'Customers who read slowly lose their place or their typing.',
    fix: 'Remove the timed refresh, or let the customer control it.',
    criteria: ['2.2.1'],
  },
};

const HARNESS_CHECKS: Readonly<Record<string, PlainProblem>> = {
  'focus-not-obscured': {
    title: 'Keyboard focus disappears behind other content',
    why: 'Keyboard users cannot see where they are when a sticky header, cookie banner, or chat window covers the control they have reached.',
    fix: 'Leave room for sticky content with scroll-padding (for example scroll-padding-top equal to the header height), or move the banner so it does not cover focused controls.',
    criteria: ['2.4.11'],
  },
  'paste-blocked': {
    title: 'The password field blocks pasting',
    why: 'Customers who rely on a password manager, or who copy a password because they cannot remember it, cannot sign in easily.',
    fix: 'Remove the code that stops pasting into password fields, and let password managers fill them.',
    criteria: ['3.3.8'],
  },
  'consistent-help': {
    title: 'Help links move around between pages',
    why: 'Customers who need help look for it where they found it last time. If the contact or help link moves, they may give up.',
    fix: 'Put the help links, such as Contact and the phone number, in the same order on every page that has them, for example always in the header or always in the footer.',
    criteria: ['3.2.6'],
  },
};

export function plainAxeRule(rule: string, help: string, criteria: string[] = []): PlainProblem {
  return (
    AXE_RULES[rule] ?? {
      title: help.replace(/\.$/, ''),
      why: 'Some customers, such as those using a screen reader, a keyboard, or magnification, may find this part of the page hard to use.',
      fix: `Fix each place listed in the saved results. The automated rule is "${rule}".`,
      criteria,
    }
  );
}

export function plainHarnessCheck(check: keyof typeof HARNESS_CHECKS): PlainProblem {
  return HARNESS_CHECKS[check] as PlainProblem;
}
