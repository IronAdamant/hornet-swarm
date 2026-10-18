// Fixture runs for the sample client report and re-test comparison in docs/. They are not real
// runs: they are shaped exactly like saved runs so the real report code reads them. The target-size
// finding and the month-two changes (the filter lists fixed, checkout failing) are illustrative.
// `scripts/generate-sample-report.mjs` writes them to a private temporary home and builds the reports.

const SITE = 'http://127.0.0.1:4173';
const STANDARD = 'wcag22aa';

const CRITERIA = {
  'image-alt': ['1.1.1'],
  'color-contrast': ['1.4.3'],
  'button-name': ['4.1.2'],
  label: ['4.1.2'],
  'select-name': ['4.1.2'],
  list: ['1.3.1'],
  'target-size': ['2.5.8'],
};

const HELP = {
  'image-alt': 'Images must have alternative text',
  'color-contrast': 'Elements must meet minimum color contrast ratio thresholds',
  'button-name': 'Buttons must have discernible text',
  label: 'Form elements must have labels',
  'select-name': 'Select element must have an accessible name',
  list: 'Lists must only directly contain <li>, <script> or <template> elements',
  'target-size': 'All touch targets must be 24px large, or leave sufficient space',
};

const IMPACT = { 'image-alt': 'critical', 'color-contrast': 'serious', 'button-name': 'critical', label: 'critical', 'select-name': 'critical', list: 'serious', 'target-size': 'serious' };

function violation(rule, count, example) {
  return { rule, impact: IMPACT[rule], help: HELP[rule], count, example, criteria: CRITERIA[rule] };
}

const CONTACT_HELP = [{ kind: 'contact', label: 'Contact' }];

function signals({ focusable, dragging = [], passwordFields = 0 }) {
  return {
    focus_not_obscured: { checked: focusable, hidden: [] },
    dragging,
    help: CONTACT_HELP,
    authentication: { password_fields: passwordFields, paste_blocked: [], autocomplete_off: [], puzzle: false },
  };
}

const LOGO = violation('image-alt', 1, '<img src="assets/img/logo.png" class="site-logo">');

/** Each page as a visitor or customer sees it in month one. */
function monthOnePages() {
  return {
    catalogue: {
      path: '/',
      violations: [
        violation('image-alt', 11, '<img class="card-img-top" src="assets/img/products/widget-01.png">'),
        violation('color-contrast', 4, '<span data-test="out-of-stock" class="text-danger">Out of stock</span>'),
        violation('label', 1, '<input data-test="search-query" class="form-control">'),
        violation('select-name', 1, '<select data-test="sort" class="form-select">'),
        violation('list', 2, '<ul class="list-unstyled">'),
      ],
      review: [{ rule: 'color-contrast', criteria: ['1.4.3'], count: 1 }],
      wcag22: signals({ focusable: 38, dragging: [{ target: '.price-range-min', reason: 'a custom slider (role="slider")' }, { target: '.price-range-max', reason: 'a custom slider (role="slider")' }] }),
    },
    'product-page': {
      path: '/product/1',
      violations: [
        LOGO,
        violation('color-contrast', 2, '<span class="badge">Hardware</span>'),
        violation('button-name', 2, '<button id="decrease-quantity" class="btn btn-link">-</button>'),
        violation('label', 1, '<input data-test="quantity" type="number" value="1">'),
        violation('target-size', 2, '<button id="increase-quantity" class="btn btn-link">+</button>'),
      ],
      review: [{ rule: 'color-contrast', criteria: ['1.4.3'], count: 1 }],
      wcag22: signals({ focusable: 21 }),
    },
    'sign-in': {
      path: '/login',
      violations: [LOGO, violation('color-contrast', 1, '<a class="footer-link">Privacy Policy</a>'), violation('button-name', 1, '<button class="btn btn-outline-secondary"></button>')],
      review: [],
      wcag22: signals({ focusable: 12, passwordFields: 1 }),
    },
    'sign-up': {
      path: '/register',
      violations: [LOGO, violation('color-contrast', 1, '<a class="footer-link">Privacy Policy</a>'), violation('button-name', 1, '<button class="btn btn-outline-secondary"></button>')],
      review: [],
      wcag22: signals({ focusable: 19, passwordFields: 1 }),
    },
    contact: {
      path: '/contact',
      violations: [LOGO, violation('color-contrast', 1, '<a class="footer-link">Privacy Policy</a>')],
      review: [],
      wcag22: signals({ focusable: 14 }),
    },
    'my-account': {
      path: '/account',
      violations: [LOGO, violation('color-contrast', 1, '<a class="footer-link">Privacy Policy</a>')],
      review: [],
      wcag22: signals({ focusable: 16 }),
    },
    profile: {
      path: '/account/profile',
      violations: [LOGO, violation('color-contrast', 1, '<a class="footer-link">Privacy Policy</a>')],
      review: [],
      wcag22: signals({ focusable: 22, passwordFields: 3 }),
    },
    cart: {
      path: '/checkout',
      violations: [LOGO, violation('color-contrast', 2, '<li class="current"><a><span class="label">Cart</span></a></li>'), violation('label', 1, '<input data-test="product-quantity" type="number">')],
      review: [{ rule: 'color-contrast', criteria: ['1.4.3'], count: 1 }],
      wcag22: signals({ focusable: 17 }),
    },
    'checkout-signed-in': {
      path: '/checkout',
      violations: [LOGO, violation('color-contrast', 2, '<li class="current"><a><span class="label">Sign in</span></a></li>')],
      review: [],
      wcag22: signals({ focusable: 15 }),
    },
  };
}

/** Month two: the filter lists on the catalogue were rebuilt. Everything else is as before. */
function monthTwoPages() {
  const pages = monthOnePages();
  pages.catalogue.violations = pages.catalogue.violations.filter((entry) => entry.rule !== 'list');
  return pages;
}

const JOURNEY_PAGES = {
  'accessibility-visitor': ['catalogue', 'product-page', 'sign-in', 'sign-up', 'contact'],
  'accessibility-customer': ['my-account', 'profile', 'cart', 'checkout-signed-in'],
};

export const JOURNEY_NAMES = {
  'accessibility-visitor': 'Pages a visitor sees, checked against WCAG 2.2 AA',
  'accessibility-customer': 'Pages a signed-in customer sees, checked against WCAG 2.2 AA',
  cart: 'A product goes into the cart',
  checkout: 'A signed-in customer pays by bank transfer and gets an invoice',
};

function clock(startIso) {
  let at = Date.parse(startIso);
  return (durationMs) => {
    const started = new Date(at).toISOString();
    at += durationMs;
    return { started_at: started, finished_at: new Date(at).toISOString(), duration_ms: durationMs };
  };
}

function step(tick, index, type, extra = {}, durationMs = 900) {
  return { index, type, status: 'pass', ...tick(durationMs), ...extra };
}

function accessibilityJourney(tick, id, pages) {
  const steps = [];
  for (const name of JOURNEY_PAGES[id]) {
    const page = pages[name];
    steps.push(step(tick, steps.length, 'navigate', {}, 2400));
    steps.push(
      step(
        tick,
        steps.length,
        'accessibility',
        { accessibility: { name, url: `${SITE}${page.path}`, standard: STANDARD, violations: page.violations, needs_review: page.review.reduce((sum, entry) => sum + entry.count, 0), review_rules: page.review, wcag22: page.wcag22 } },
        3100,
      ),
    );
  }
  return journey(id, steps);
}

function journey(id, steps) {
  const failed = steps.some((entry) => entry.status === 'fail');
  return { id, name: JOURNEY_NAMES[id], status: failed ? 'fail' : 'pass', duration_ms: steps.reduce((sum, entry) => sum + entry.duration_ms, 0), steps };
}

function cartJourney(tick) {
  const types = ['navigate', 'fill', 'fill', 'click', 'wait', 'assert', 'navigate', 'wait', 'click', 'assert', 'click', 'assert'];
  return journey('cart', types.map((type, index) => step(tick, index, type)));
}

function checkoutJourney(tick, orderConfirmed) {
  const types = ['navigate', 'fill', 'fill', 'click', 'wait', 'assert', 'navigate', 'wait', 'click', 'assert', 'click', 'click', 'assert', 'click', 'wait', 'screenshot', 'fill', 'fill', 'click', 'select', 'fill', 'fill', 'click', 'assert', 'click', 'assert', 'screenshot'];
  const steps = types.map((type, index) => step(tick, index, type));
  if (!orderConfirmed) {
    const last = steps.length - 2;
    steps[last] = {
      ...steps[last],
      status: 'fail',
      assertion: 'text_visible Thanks for your order!',
      error: 'text was not visible (closest text on the page: "Payment was successful")',
      screenshot: 'failed-step-25.png',
      network_errors: [{ method: 'POST', url: 'http://127.0.0.1:4173/api/orders', status: 500 }],
    };
    steps.length = last + 1;
  }
  return journey('checkout', steps);
}

function buildUsers(startIso, pages, orderConfirmed) {
  const tick = clock(startIso);
  const customer = { label: 'qa-user-1', phase1: { status: 'pass', ...pick(tick(3600)) }, journeys: [] };
  const visitor = { label: 'qa-user-2', phase1: { status: 'pass', ...pick(tick(3400)) }, journeys: [] };
  visitor.journeys.push(accessibilityJourney(tick, 'accessibility-visitor', pages));
  customer.journeys.push(accessibilityJourney(tick, 'accessibility-customer', pages));
  customer.journeys.push(cartJourney(tick));
  customer.journeys.push(checkoutJourney(tick, orderConfirmed));
  return { users: [customer, visitor], finishedAt: tick(0).started_at };
}

function pick(timing) {
  return { duration_ms: timing.duration_ms };
}

/** The two saved runs, oldest first, in the shape `runSuite` saves. */
export function sampleRuns() {
  return [
    { runId: 'run_20261014-231000_s4mp1e', startedAt: '2026-10-14T23:10:00.000Z', ...buildUsers('2026-10-14T23:10:00.000Z', monthOnePages(), true) },
    { runId: 'run_20261016-232000_s4mp2e', startedAt: '2026-10-16T23:20:00.000Z', ...buildUsers('2026-10-16T23:20:00.000Z', monthTwoPages(), false) },
  ].map(({ runId, startedAt, users, finishedAt }) => ({ runId, startedAt, finishedAt, users }));
}

/** What the runner saves beside an accessibility step: `accessibility-<name>.json`. */
export function accessibilityFile(result) {
  return `${JSON.stringify({ name: result.name, standard: result.standard, url: result.url, violations: result.violations, incomplete: result.review_rules.length, review_rules: result.review_rules, wcag22: result.wcag22 }, null, 2)}\n`;
}

/** The page words the runner saves for a failed step. */
export const CHECKOUT_FAILURE_TEXT = ['Payment was successful', '', 'Form fields:', '#payment-method: Bank Transfer', '#account-name: Ada Tester', '', 'Disabled buttons:', ''].join('\n');
