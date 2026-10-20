import { describe, expect, it } from 'vitest';
import { renderClientReport } from '../../packages/report/src/client-report-render.ts';
import { diffClientReports, retestDiffMarkdown } from '../../packages/report/src/retest-diff.ts';
import { CONTRAST, IMAGE_ALT, TARGET_SIZE, cleanSignals, fixtureJob, fixtureReport, fixtureRun, type FixturePage } from '../support/client-report-fixture.ts';
import { buildClientReport } from '../../packages/report/src/client-report-builder.ts';
import { AGENCY_BRAND, fixtureAuthorisation } from '../support/client-report-fixture.ts';

const signals = (patch: Partial<ReturnType<typeof cleanSignals>>) => ({ ...cleanSignals(), ...patch });

describe('building a client report', () => {
  it('refuses a run of another project, or one that failed its redaction check', () => {
    const run = { ...fixtureRun(), project: 'other' };
    const input = { job: fixtureJob(), brand: AGENCY_BRAND, authorisation: fixtureAuthorisation(), journeyNames: new Map(), hasFile: () => false };
    expect(() => buildClientReport({ ...input, run })).toThrow(/not of fixture/);
    expect(() => fixtureReport({ status: 'redaction_failure' })).toThrow(/must not be shared/);
    expect(() => fixtureReport({ redaction: 'fail' })).toThrow(/must not be shared/);
  });

  it('reports sign-up, log in, cart, and checkout in that order, then the other journeys', () => {
    const report = fixtureReport();
    expect(report.journeys.map((journey) => [journey.kind, journey.status])).toEqual([
      ['sign_up', 'worked'],
      ['login', 'worked'],
      ['cart', 'worked'],
      ['checkout', 'worked'],
      ['other', 'worked'],
    ]);
    expect(report.journeys[1]?.summary).toContain('checked by the sign-in that starts every run');
    expect(report.issues).toEqual([]);
    expect(report.executive_summary.headline).toMatch(/^No issues found against WCAG 2\.2 AA in tested pages by the automated checks/);
  });

  it('turns a failed journey into a high issue in plain words, and keeps a blocked one apart', () => {
    const report = fixtureReport({ journeys: { checkout: 'fail', cart: 'blocked' }, files: ['qa-user-1/checkout/failed-step-2.txt'] });
    const checkout = report.journeys.find((journey) => journey.kind === 'checkout');
    expect(checkout?.status).toBe('failed');
    expect(report.journeys.find((journey) => journey.kind === 'cart')?.status).toBe('blocked');
    const issue = report.issues.find((entry) => entry.key === 'journey:checkout');
    expect(issue).toMatchObject({ id: 'J-01', severity: 'High', evidence: ['qa-user-1/checkout/failed-step-2.txt'] });
    expect(issue?.why_it_matters).toContain('cannot pay');
    expect(report.issues.some((entry) => entry.key === 'journey:cart')).toBe(false);
    expect(report.executive_summary.paragraphs.join(' ')).toContain('could not be finished, for a reason outside the site');
  });

  it('reports a failed sign-in as log in not working', () => {
    const report = fixtureReport({ signIn: 'fail' });
    expect(report.journeys.find((journey) => journey.kind === 'login')?.status).toBe('failed');
    expect(report.issues[0]).toMatchObject({ key: 'journey:login', severity: 'High', title: 'Customers could not log in' });
  });

  it('says a journey left out on purpose, or not covered, was not tested', () => {
    const job = fixtureJob({ journeys: [{ id: 'pages' }, { id: 'checkout', covers: 'checkout' }], not_in_scope: [{ covers: 'sign_up', reason: 'Shared site.' }] });
    const report = fixtureReport({ job });
    expect(report.journeys.find((journey) => journey.kind === 'sign_up')).toMatchObject({ status: 'out_of_scope', summary: 'Left out of this round on purpose: Shared site.' });
    expect(report.journeys.find((journey) => journey.kind === 'cart')?.status).toBe('not_tested');
    expect(report.scope_and_limits.join(' ')).toContain('Left out on purpose: sign-up (Shared site.)');
  });

  it('groups accessibility problems by rule across pages, worst first, citing only files that exist', () => {
    const pages: FixturePage[] = [
      { name: 'home', path: '/', result: { violations: [CONTRAST, IMAGE_ALT] } },
      { name: 'product', path: '/product/1', result: { violations: [{ ...IMAGE_ALT, count: 5 }, TARGET_SIZE] } },
    ];
    const report = fixtureReport({ pages, files: ['qa-user-1/pages/accessibility-home.json'] });
    expect(report.issues.map((issue) => [issue.id, issue.key, issue.severity])).toEqual([
      ['A-01', 'a11y:image-alt', 'High'],
      ['A-02', 'a11y:color-contrast', 'Medium'],
      ['A-03', 'a11y:target-size', 'Medium'],
    ]);
    const images = report.issues[0];
    expect(images?.where.map((entry) => [entry.page, entry.places])).toEqual([
      ['home', 2],
      ['product', 5],
    ]);
    expect(images?.evidence).toEqual(['qa-user-1/pages/accessibility-home.json']);
    expect(report.evidence_appendix.map((entry) => entry.path)).toEqual(['qa-user-1/pages/accessibility-home.json']);
    expect(report.criteria.find((row) => row.id === '2.5.8')).toMatchObject({ outcome: 'issues_found', issues: 1 });
    expect(report.criteria.find((row) => row.id === '1.1.1')?.outcome).toBe('issues_found');
  });

  it('finds the new 2.2 problems the harness checks for', () => {
    const pages: FixturePage[] = [
      {
        name: 'sign-in',
        path: '/login',
        result: {
          wcag22: signals({
            focus_not_obscured: { checked: 8, hidden: [{ target: '#email', covered_by: '.cookie-banner' }] },
            help: [{ kind: 'contact', label: 'Contact' }, { kind: 'faq', label: 'FAQ' }],
            authentication: { password_fields: 1, paste_blocked: ['#password'], autocomplete_off: ['#password'], puzzle: true },
          }),
        },
      },
      { name: 'products', path: '/products', result: { wcag22: signals({ dragging: [{ target: '.price-slider', reason: 'a custom slider (role="slider")' }], help: [{ kind: 'faq', label: 'FAQ' }, { kind: 'contact', label: 'Contact' }] }) } },
    ];
    const redundant = { index: 2, type: 'fill', status: 'pass', duration_ms: 1, started_at: '2026-10-01T00:00:00.000Z', finished_at: '2026-10-01T00:00:00.000Z', redundant_entry: { earlier_step: 0, field: '#billing-postcode' } };
    const report = fixtureReport({ pages, extraSteps: [redundant] });
    const keys = Object.fromEntries(report.issues.map((issue) => [issue.key, issue.criteria]));
    expect(keys['wcag22:focus-not-obscured']).toEqual(['2.4.11']);
    expect(keys['wcag22:paste-blocked']).toEqual(['3.3.8']);
    expect(keys['wcag22:consistent-help']).toEqual(['3.2.6']);
    const review = report.review_items.map((item) => item.criterion);
    expect(review).toEqual(expect.arrayContaining(['2.5.7', '3.3.8', '3.3.7']));
    expect(report.review_items.find((item) => item.criterion === '3.3.7')?.what).toContain('Step 3 typed a value that step 1 had already given');
    const outcome = (id: string) => report.criteria.find((row) => row.id === id)?.outcome;
    expect(outcome('2.4.11')).toBe('issues_found');
    expect(outcome('3.3.8')).toBe('issues_found');
    expect(outcome('3.2.6')).toBe('issues_found');
    expect(outcome('2.5.7')).toBe('needs_manual_review');
    expect(outcome('3.3.7')).toBe('needs_manual_review');
  });

  it('applies a reviewer\'s grade and withdrawal, and lists the withdrawal', () => {
    const job = fixtureJob({
      severity_overrides: [{ issue: 'a11y:image-alt', severity: 'Low', reason: 'Every image is decorative.' }],
      withdrawn_issues: [{ issue: 'a11y:color-contrast', reason: 'The text sits on a solid colour the check misread.' }],
    });
    const report = fixtureReport({ job, pages: [{ name: 'home', result: { violations: [CONTRAST, IMAGE_ALT] } }] });
    expect(report.issues.map((issue) => [issue.key, issue.severity])).toEqual([['a11y:image-alt', 'Low']]);
    expect(report.issues[0]?.severity_reason).toBe('Graded by the reviewer: Every image is decorative.');
    expect(report.withdrawn).toEqual([{ key: 'a11y:color-contrast', title: 'Text is too faint to read easily', reason: 'The text sits on a solid colour the check misread.' }]);
    expect(renderClientReport(report).markdown).toContain('Withdrawn after review');
  });

  it('keeps contrast it could not decide as needs manual review', () => {
    const report = fixtureReport({ pages: [{ name: 'home', result: { review_rules: [{ rule: 'color-contrast', criteria: ['1.4.3'], count: 2 }], needs_review: 2 } }] });
    expect(report.criteria.find((row) => row.id === '1.4.3')?.outcome).toBe('needs_manual_review');
    expect(report.review_items[0]?.what).toContain('could not decide 2 places');
  });
});

describe('the re-test comparison', () => {
  const month = (day: string, options: Parameters<typeof fixtureReport>[0]) => fixtureReport({ runId: `run_202611${day}-000000_aaaaaa`, finishedAt: `2026-11-${day}T00:00:00.000Z`, ...options });

  it('lists new, fixed, and still-open issues, and journey regressions', () => {
    const before = month('01', { pages: [{ name: 'home', result: { violations: [CONTRAST, IMAGE_ALT] } }], journeys: { cart: 'fail' } });
    const after = month('29', { pages: [{ name: 'home', result: { violations: [CONTRAST, TARGET_SIZE] } }], journeys: { checkout: 'fail' } });
    const diff = diffClientReports(before, after);
    expect(diff.new_issues.map((issue) => issue.key).sort()).toEqual(['a11y:target-size', 'journey:checkout']);
    expect(diff.fixed.map((issue) => issue.key).sort()).toEqual(['a11y:image-alt', 'journey:cart']);
    expect(diff.still_open.map((issue) => issue.key)).toEqual(['a11y:color-contrast']);
    expect(diff.journey_regressions.map((change) => change.kind)).toEqual(['checkout']);
    expect(diff.journey_fixes.map((change) => change.kind)).toEqual(['cart']);
    const markdown = retestDiffMarkdown(diff, after);
    expect(markdown).toContain('## Journeys that stopped working');
    expect(markdown).toContain('**Checkout:** worked last time, did not work this time.');
  });

  it('does not call an issue fixed when its pages were not all checked again', () => {
    const before = month('01', { pages: [{ name: 'home', result: { violations: [IMAGE_ALT] } }, { name: 'account', result: { violations: [IMAGE_ALT] } }] });
    const after = month('29', { pages: [{ name: 'home' }] });
    const diff = diffClientReports(before, after);
    expect(diff.fixed).toEqual([]);
    expect(diff.not_rechecked.map((issue) => issue.key)).toEqual(['a11y:image-alt']);
  });

  it('does not call a journey fixed or broken when it could not be finished this time', () => {
    const before = month('01', { journeys: { checkout: 'fail' } });
    const after = month('29', { journeys: { checkout: 'blocked' } });
    const diff = diffClientReports(before, after);
    expect(diff.fixed).toEqual([]);
    expect(diff.not_rechecked.map((issue) => issue.key)).toEqual(['journey:checkout']);
    expect(diff.journey_not_rechecked.map((change) => change.kind)).toEqual(['checkout']);
  });

  it('refuses to compare two different jobs', () => {
    const other = fixtureReport({ job: fixtureJob({ id: 'other-job' }) });
    expect(() => diffClientReports(fixtureReport(), other)).toThrow(/Cannot compare/);
  });
});
