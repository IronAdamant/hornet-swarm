import { authorisationSchema, clientJobSchema, runResultSchema, type AccessibilityResult, type Authorisation, type ClientJob, type RunResult } from '../../packages/core/src/index.ts';
import { buildClientReport } from '../../packages/report/src/client-report-builder.ts';
import type { ClientReport, ResolvedBrand } from '../../packages/report/src/client-report-model.ts';

/** Saved-run fixtures for the client report, on the offline test app's address only. */
export const FIXTURE_SITE = 'http://127.0.0.1:4173';

export const AGENCY_BRAND: ResolvedBrand = { prepared_by: 'agency', name: 'Test Agency Pty Ltd', contact_email: 'hello@agency.example' };

export function fixtureAuthorisation(overrides: Record<string, unknown> = {}): Authorisation {
  return authorisationSchema.parse({
    id: 'fixture-owner',
    basis: 'owner',
    client: 'Fixture Shop',
    authoriser: { name: 'Pat Owner', role: 'Owner', email: 'pat@shop.example' },
    granted_to: 'Iron Adamant',
    scope: { domains: ['127.0.0.1'], environments: ['test'] },
    activities: ['signin_smoke', 'functional_e2e'],
    exclusions: [],
    valid_from: '2026-01-01',
    valid_until: '2027-12-31',
    document: { path: 'fixture-owner.txt', sha256: 'a'.repeat(64) },
    ...overrides,
  });
}

export function fixtureJob(overrides: Record<string, unknown> = {}): ClientJob {
  return clientJobSchema.parse({
    version: 1,
    id: 'fixture-monthly',
    project: 'fixture',
    client: { business_name: 'Fixture Shop Pty Ltd', site_name: 'Fixture Shop', site_url: FIXTURE_SITE },
    branding: { agency: { name: 'Test Agency Pty Ltd' } },
    journeys: [{ id: 'pages' }, { id: 'sign-up', covers: 'sign_up' }, { id: 'cart', covers: 'cart' }, { id: 'checkout', covers: 'checkout' }],
    ...overrides,
  });
}

export type FixturePage = { name: string; path?: string; result?: Partial<AccessibilityResult> };

export const CONTRAST = { rule: 'color-contrast', impact: 'serious', help: 'Elements must meet minimum color contrast ratio thresholds', count: 3, example: '<p class="faint">', criteria: ['1.4.3'] } as const;
export const IMAGE_ALT = { rule: 'image-alt', impact: 'critical', help: 'Images must have alternative text', count: 2, example: '<img src="a.png">', criteria: ['1.1.1'] } as const;
export const TARGET_SIZE = { rule: 'target-size', impact: 'serious', help: 'All touch targets must be 24px large, or leave sufficient space', count: 1, example: '<button class="tiny">', criteria: ['2.5.8'] } as const;

export function cleanSignals(): NonNullable<AccessibilityResult['wcag22']> {
  return {
    focus_not_obscured: { checked: 10, hidden: [] },
    dragging: [],
    help: [{ kind: 'contact', label: 'Contact us' }],
    authentication: { password_fields: 0, paste_blocked: [], autocomplete_off: [], puzzle: false },
  };
}

function accessibilityStep(index: number, page: FixturePage) {
  const result: AccessibilityResult = {
    name: page.name,
    url: `${FIXTURE_SITE}${page.path ?? `/${page.name}`}`,
    standard: 'wcag22aa',
    violations: [],
    needs_review: 0,
    review_rules: [],
    wcag22: cleanSignals(),
    ...page.result,
  };
  return { index, type: 'accessibility', status: 'pass', duration_ms: 10, started_at: '2026-10-01T00:00:00.000Z', finished_at: '2026-10-01T00:00:01.000Z', accessibility: result };
}

type JourneyStatus = 'pass' | 'fail' | 'flaky' | 'blocked';

function plainJourney(id: string, status: JourneyStatus, failure?: { error: string; assertion?: string }) {
  const steps = [0, 1, 2].map((index) => ({ index, type: 'click', status: 'pass', duration_ms: 10, started_at: '2026-10-01T00:00:00.000Z', finished_at: '2026-10-01T00:00:01.000Z' }));
  if (status === 'fail') steps[2] = { ...steps[2], status: 'fail', error: failure?.error ?? 'text was not visible (closest text on the page: "Something went wrong")', ...(failure?.assertion ? { assertion: failure.assertion } : {}) } as (typeof steps)[number];
  if (status === 'blocked') steps[2] = { ...steps[2], status: 'blocked', blocked_reason: 'captcha' } as (typeof steps)[number];
  return { id, status, duration_ms: 30, steps };
}

export type FixtureRunOptions = {
  runId?: string;
  finishedAt?: string;
  pages?: FixturePage[];
  journeys?: Partial<Record<'sign-up' | 'cart' | 'checkout', JourneyStatus>>;
  signIn?: 'pass' | 'fail';
  status?: RunResult['status'];
  redaction?: 'pass' | 'fail';
  extraSteps?: Record<string, unknown>[];
};

export function fixtureRun(options: FixtureRunOptions = {}): RunResult {
  const pages = options.pages ?? [{ name: 'home', path: '/' }];
  const journeys = { 'sign-up': 'pass', cart: 'pass', checkout: 'pass', ...options.journeys } as const;
  const pagesJourney = { id: 'pages', status: 'pass', duration_ms: 10, steps: [...pages.map((page, index) => accessibilityStep(index, page)), ...(options.extraSteps ?? [])] };
  return runResultSchema.parse({
    schema_version: '1',
    run_id: options.runId ?? 'run_20261001-000000_aaaaaa',
    project: 'fixture',
    started_at: '2026-10-01T00:00:00.000Z',
    finished_at: options.finishedAt ?? '2026-10-01T00:05:00.000Z',
    status: options.status ?? 'passed',
    gate: 'all',
    gate_passed: true,
    totals: { users: 1, journeys: 4, steps: 10, passed: 10, failed: 0, skipped: 0 },
    users: [
      {
        label: 'qa-user-1',
        phase1: { status: options.signIn ?? 'pass', duration_ms: 10, ...(options.signIn === 'fail' ? { error: 'The site did not sign the account in' } : {}) },
        journeys: [pagesJourney, ...Object.entries(journeys).map(([id, status]) => plainJourney(id, status))],
      },
    ],
    environment: 'test',
    authorisation_id: 'fixture-owner',
    redaction: options.redaction ?? 'pass',
  });
}

export function fixtureReport(options: FixtureRunOptions & { job?: ClientJob; brand?: ResolvedBrand; authorisation?: Authorisation; files?: string[] } = {}): ClientReport {
  const files = new Set(options.files ?? []);
  return buildClientReport({
    job: options.job ?? fixtureJob(),
    brand: options.brand ?? AGENCY_BRAND,
    authorisation: options.authorisation ?? fixtureAuthorisation(),
    run: fixtureRun(options),
    journeyNames: new Map([
      ['pages', 'Key pages, checked against WCAG 2.2 AA'],
      ['sign-up', 'A new customer signs up'],
      ['cart', 'A product goes into the cart'],
      ['checkout', 'A customer checks out'],
    ]),
    hasFile: (path) => files.has(path),
  });
}
