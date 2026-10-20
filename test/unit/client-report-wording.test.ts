import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForbiddenClaimError, assertNoComplianceClaim, brandingSchema, clientJobSchema, forbiddenClaims, withoutQuotedEvidence } from '../../packages/core/src/index.ts';
import { BrandingError, IRON_ADAMANT_NAME, LOGO_MAX_BYTES, resolveBrand } from '../../packages/report/src/client-report-branding.ts';
import { renderClientReport } from '../../packages/report/src/client-report-render.ts';
import { diffClientReports, retestDiffMarkdown } from '../../packages/report/src/retest-diff.ts';
import { CONTRAST, IMAGE_ALT, TARGET_SIZE, fixtureAuthorisation, fixtureJob, fixtureReport } from '../support/client-report-fixture.ts';

const root = join(import.meta.dirname, '..', '..');

const CLAIMS = [
  'This site is WCAG 2.2 compliant.',
  'Full compliance with WCAG.',
  'The checkout is non-compliant.',
  'The site complies with WCAG 2.2 AA.',
  'Certified accessible by Iron Adamant.',
  'This report is an accessibility certificate.',
  'An accredited audit.',
  'Shows conformance to level AA.',
  'The shop conforms to WCAG 2.2.',
  'The site is fully accessible.',
  'The site meets WCAG 2.2 AA.',
  'It passes all of the WCAG criteria.',
  'WCAG 2.2 AA verified.',
];

const ALLOWED = [
  '7 issues found against WCAG 2.2 AA in tested pages, 1 of them high severity.',
  'ARIA attributes must conform to valid values',
  'Certainly, the checks found nothing on this page.',
  'No issues found by automated checks on the tested pages',
];

describe('the forbidden wording', () => {
  it('catches every way of saying a site is compliant, certified, or meets WCAG', () => {
    for (const claim of CLAIMS) expect(forbiddenClaims(claim), claim).not.toHaveLength(0);
    for (const claim of CLAIMS) expect(() => assertNoComplianceClaim(claim, 'The report says'), claim).toThrow(ForbiddenClaimError);
  });

  it('allows the wording a report uses', () => {
    for (const text of ALLOWED) expect(forbiddenClaims(text), text).toEqual([]);
  });

  it('lets a report quote the site\'s own words, but not say them itself', () => {
    expect(() => assertNoComplianceClaim('such as `<span class="badge">Certified organic</span>`', 'x')).not.toThrow();
    expect(() => assertNoComplianceClaim('the page should have said "Thanks" but said "Certified organic tea" instead', 'x')).not.toThrow();
    expect(() => assertNoComplianceClaim('<dd><code>&lt;span&gt;Certified organic&lt;/span&gt;</code></dd>', 'x')).not.toThrow();
    expect(() => assertNoComplianceClaim('The page said &quot;Certified organic&quot;.', 'x')).not.toThrow();
    expect(() => assertNoComplianceClaim('such as `<span>organic</span>`. This site is certified.', 'x')).toThrow(ForbiddenClaimError);
    expect(withoutQuotedEvidence('a "b" c')).toBe('a     c');
  });

  it('refuses a brand or a reason that would print a claim on every report', () => {
    expect(brandingSchema.safeParse({ agency: { name: 'Certified Access Co' } }).success).toBe(false);
    expect(brandingSchema.safeParse({ agency: { name: 'Harbour Lane Digital', logo_alt: 'WCAG compliant badge' } }).success).toBe(false);
    expect(() => fixtureJob({ client: { business_name: 'Compliance Shop', site_name: 'Shop', site_url: 'http://127.0.0.1:4173' } })).toThrow();
    expect(() => fixtureJob({ withdrawn_issues: [{ issue: 'a11y:image-alt', reason: 'The images are compliant.' }] })).toThrow();
    expect(() => fixtureJob({ severity_overrides: [{ issue: 'a11y:image-alt', severity: 'Low', reason: 'It meets WCAG anyway.' }] })).toThrow();
    expect(() => fixtureJob({ journeys: [{ id: 'pages' }], not_in_scope: [{ covers: 'sign_up', reason: 'Already certified.' }] })).toThrow();
  });
});

function scenarios() {
  const busy = [
    { name: 'home', path: '/', result: { violations: [IMAGE_ALT, CONTRAST], review_rules: [{ rule: 'color-contrast', criteria: ['1.4.3'], count: 2 }], needs_review: 2 } },
    { name: 'product', path: '/product/1', result: { violations: [TARGET_SIZE, { ...IMAGE_ALT, example: '<img alt="" src="certified-badge.png">' }] } },
  ];
  return {
    clean: fixtureReport(),
    busy: fixtureReport({ pages: busy }),
    failedJourneys: fixtureReport({ pages: busy, journeys: { checkout: 'fail', cart: 'blocked' }, signIn: 'fail' }),
    ironAdamant: fixtureReport({ brand: { prepared_by: 'iron_adamant', name: IRON_ADAMANT_NAME } }),
    publicPractice: fixtureReport({
      authorisation: fixtureAuthorisation({ basis: 'public_practice', authoriser: undefined, document: undefined, public_statement: { url: 'http://127.0.0.1:4173/', quote: 'This is a demo for test practice.' }, activities: ['signin_smoke', 'functional_e2e'] }),
    }),
  };
}

describe('a rendered client report', () => {
  it('never says compliant or certified, in any scenario, in either form', () => {
    for (const [name, report] of Object.entries(scenarios())) {
      const { markdown, html } = renderClientReport(report);
      for (const text of [markdown, html]) {
        expect(forbiddenClaims(withoutQuotedEvidence(text)), name).toEqual([]);
        expect(text, name).toContain('issues found against WCAG 2.2 AA in tested pages');
        expect(text, name).toContain('This is not a security test');
        expect(text, name).not.toMatch(/WCAG 2\.1/);
      }
    }
  });

  it('says the testing was done with the owner\'s written authorisation', () => {
    const { markdown } = renderClientReport(scenarios().busy);
    expect(markdown).toContain("Testing was done with the site owner's written authorisation, given by Pat Owner (Owner), record fixture-owner");
    expect(renderClientReport(scenarios().publicPractice).markdown).toContain('published permission');
  });

  it('marks every criterion that needs a person as needs manual review, and none as passed', () => {
    const report = scenarios().clean;
    for (const row of report.criteria) {
      if (row.automation !== 'automated') expect(['needs_manual_review', 'issues_found'], row.id).toContain(row.outcome);
      expect(row.outcome_words).not.toMatch(/pass/i);
    }
    expect(report.criteria.find((row) => row.id === '1.4.3')?.outcome).toBe('no_issues_found');
    expect(report.criteria.find((row) => row.id === '2.1.1')?.outcome).toBe('needs_manual_review');
    expect(renderClientReport(report).markdown).toContain('4.1.1 Parsing is not part of WCAG 2.2 and is not checked.');
  });

  it('refuses to render a report whose words were edited into a claim', () => {
    const report = structuredClone(scenarios().busy);
    report.executive_summary.headline = 'Your site is fully compliant with WCAG 2.2 AA';
    expect(() => renderClientReport(report)).toThrow(/claims or mentions compliance/);
    const relabelled = structuredClone(scenarios().clean);
    const row = relabelled.criteria.find((entry) => entry.id === '2.1.1');
    if (!row) throw new Error('2.1.1 row is missing');
    row.outcome_words = 'Passed';
    expect(() => renderClientReport(relabelled)).toThrow();
  });

  it('keeps the re-test comparison free of claims too', () => {
    const { busy, clean } = scenarios();
    const markdown = retestDiffMarkdown(diffClientReports(busy, { ...clean, run_id: 'run_20261101-000000_bbbbbb', tested_at: '2026-11-01T00:00:00.000Z' }), clean);
    expect(forbiddenClaims(withoutQuotedEvidence(markdown))).toEqual([]);
    expect(markdown).toContain('This is not a security test');
    expect(markdown).toContain("site owner's written authorisation");
  });
});

describe('the sample reports in docs', () => {
  const samples = ['docs/fixture-sample-client-report.md', 'docs/fixture-sample-client-report.html', 'docs/fixture-sample-retest-diff.md'];

  it('carry no claim and say WCAG 2.2 AA', () => {
    for (const path of samples) {
      const text = readFileSync(join(root, path), 'utf8');
      expect(forbiddenClaims(withoutQuotedEvidence(text)), path).toEqual([]);
      expect(text, path).toContain('WCAG 2.2 AA');
    }
  });

  it('match what the generator makes from the fixture runs', () => {
    expect(() => execFileSync(process.execPath, [join(root, 'scripts/generate-sample-report.mjs'), '--check'], { cwd: root, stdio: 'pipe' })).not.toThrow();
  });
});

describe('report branding', () => {
  const logo = (bytes: number) => () => Buffer.alloc(bytes, 1);
  const noLogo = () => {
    throw new Error('no logo expected');
  };

  it('uses the agency brand by default', () => {
    expect(resolveBrand({ agency: { name: 'Harbour Lane Digital' } }, undefined, noLogo)).toEqual({ prepared_by: 'agency', name: 'Harbour Lane Digital' });
    expect(resolveBrand(undefined, { agency: { name: 'Global Agency' } }, noLogo).name).toBe('Global Agency');
  });

  it('refuses to fall back to Iron Adamant when no agency is named', () => {
    expect(() => resolveBrand(undefined, undefined, noLogo)).toThrow(BrandingError);
    expect(() => resolveBrand({ use: 'agency' }, { iron_adamant: { contact_email: 'a@b.example' } }, noLogo)).toThrow(BrandingError);
  });

  it('uses Iron Adamant only when asked, and the job wins over the global config', () => {
    expect(resolveBrand({ use: 'iron_adamant' }, { agency: { name: 'Global Agency' } }, noLogo)).toEqual({ prepared_by: 'iron_adamant', name: IRON_ADAMANT_NAME });
    expect(resolveBrand({ agency: { name: 'Job Agency' } }, { use: 'iron_adamant', agency: { name: 'Global Agency' } }, noLogo).name).toBe('Job Agency');
    expect(resolveBrand({ use: 'agency' }, { use: 'iron_adamant', agency: { name: 'Global Agency' } }, noLogo).name).toBe('Global Agency');
  });

  it('embeds a small PNG, JPEG, or SVG logo and refuses anything else', () => {
    const brand = resolveBrand({ agency: { name: 'A', logo: 'logo.png' } }, undefined, logo(10));
    expect(brand.logo_data_uri).toMatch(/^data:image\/png;base64,/);
    expect(brand.logo_alt).toBe('A logo');
    expect(() => resolveBrand({ agency: { name: 'A', logo: 'logo.gif' } }, undefined, logo(10))).toThrow(/not a PNG, JPEG, or SVG/);
    expect(() => resolveBrand({ agency: { name: 'A', logo: 'logo.svg' } }, undefined, logo(LOGO_MAX_BYTES + 1))).toThrow(/over 512 KB/);
  });

  it('is read from a job file, with WCAG 2.2 AA as the only standard', () => {
    const job = clientJobSchema.parse(readJob());
    expect(job.standard).toBe('wcag22aa');
    expect(job.branding?.use).toBe('agency');
    expect(clientJobSchema.safeParse({ ...readJob(), standard: 'wcag21aa' }).success).toBe(false);
  });
});

function readJob(): Record<string, unknown> {
  return { version: 1, id: 'shop', project: 'fixture', client: { business_name: 'Shop', site_name: 'Shop', site_url: 'http://127.0.0.1:4173' }, branding: { use: 'agency', agency: { name: 'A' } }, journeys: [{ id: 'pages' }] };
}

