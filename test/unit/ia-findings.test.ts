import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Redactor, type Analysis } from '../../packages/core/src/index.ts';
import { writeRunReports } from '../../packages/controller/src/suite-publish.ts';
import {
  AXE_IMPACT_TO_SEVERITY,
  CLIENT_READY_METHOD,
  CONFIDENCE_RUBRIC,
  assertRenderedAscii,
  formatFindingsWhen,
  nonAsciiCharacters,
  renderIaFindings,
  validateIaFindings,
  type IaFindingsFile,
} from '../../packages/report/src/ia-findings.ts';
import { iaFindingsFromRun } from '../../packages/report/src/ia-findings-from-run.ts';
import { cleanSignals, fixtureRun } from '../support/client-report-fixture.ts';

const example = JSON.parse(readFileSync(new URL('../fixtures/ia-findings.example.json', import.meta.url), 'utf8')) as IaFindingsFile;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function errorsOf(mutate: (doc: IaFindingsFile) => void): string[] {
  const doc = structuredClone(example);
  mutate(doc);
  return validateIaFindings(doc).errors;
}

describe('ia-findings gates', () => {
  it('accepts the example file and warns that WCAG 2.1 can never be marked ready for a client', () => {
    const result = validateIaFindings(example);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join(' ')).toContain('WCAG 2.1 AA');
    expect(result.warnings.join(' ')).toContain('client_ready');
  });

  it('blocks a client_ready mark on a 2.1 run', () => {
    expect(errorsOf((doc) => {
      doc.report.status = 'client_ready';
    }).join('\n')).toMatch(/WCAG 2\.2 AA/);
  });

  it('blocks banned words, including the words added for this build', () => {
    expect(errorsOf((doc) => {
      doc.findings[0]!.recommendation = 'Makes the site compliant.';
    }).join('\n')).toMatch(/banned word "compliant"/);
    for (const word of ['security', 'pentest', 'pen test', 'red team', 'attacker', 'audit', 'authorise', 'authorize', 'hack', 'guaranteed', 'certification']) {
      expect(errorsOf((doc) => {
        doc.findings[0]!.recommendation = `This is a ${word} note.`;
      }).join('\n'), word).toMatch(new RegExp(`banned word "${word}"`));
    }
  });

  it('blocks an em dash and an en dash', () => {
    expect(errorsOf((doc) => {
      doc.findings[0]!.title = 'Menu list \u2014 nested';
    }).join('\n')).toMatch(/non-ASCII/);
    expect(errorsOf((doc) => {
      doc.findings[0]!.title = 'Menu list \u2013 nested';
    }).join('\n')).toMatch(/non-ASCII/);
  });

  it('blocks a finding with nobody it affects', () => {
    expect(errorsOf((doc) => {
      delete (doc.findings[0] as { affects?: unknown }).affects;
    }).length).toBeGreaterThan(0);
  });

  it('blocks an issue whose confidence is under 0.5, and allows 0.5', () => {
    expect(errorsOf((doc) => {
      doc.findings[0]!.confidence.score = 0.3;
    }).join('\n')).toMatch(/needs_review/);
    expect(errorsOf((doc) => {
      doc.findings[0]!.confidence.score = 0.49;
    }).length).toBeGreaterThan(0);
    expect(errorsOf((doc) => {
      doc.findings[0]!.confidence.score = 0.5;
    })).toEqual([]);
  });

  it('blocks the wrong severity for an issue, a needs_review row, and a what_worked row', () => {
    expect(errorsOf((doc) => {
      doc.findings[0]!.severity = 'none';
    }).join('\n')).toMatch(/needs a severity/);
    expect(errorsOf((doc) => {
      doc.findings[1]!.severity = 'high';
    }).join('\n')).toMatch(/severity none/);
    expect(errorsOf((doc) => {
      doc.findings[5]!.severity = 'low';
    }).join('\n')).toMatch(/severity none/);
  });

  it('blocks duplicate ids and an unknown field', () => {
    expect(errorsOf((doc) => {
      doc.findings[1]!.id = doc.findings[0]!.id;
    }).join('\n')).toMatch(/duplicate ids/);
    const extra = { ...example, extra: true };
    expect(validateIaFindings(extra).errors.join('\n')).toMatch(/unknown field/);
  });

  it('allows client_ready only for WCAG 2.2 AA, the exact method, a reviewer, and verified issues', () => {
    const ready = (doc: IaFindingsFile) => {
      doc.report.status = 'client_ready';
      doc.report.method = CLIENT_READY_METHOD;
      doc.report.standard.version = '2.2';
      doc.report.review = { reviewed_by: ['Lead Verifier'], reviewed_at: '2026-10-27' };
    };
    expect(errorsOf(ready)).toEqual([]);
    expect(errorsOf((doc) => {
      ready(doc);
      doc.report.method = 'automated checks against WCAG 2.2 AA';
    }).join('\n')).toMatch(/client wording/);
    expect(errorsOf((doc) => {
      ready(doc);
      delete doc.report.review;
    }).join('\n')).toMatch(/reviewer/);
    expect(errorsOf((doc) => {
      ready(doc);
      doc.findings[0]!.confidence.evidence_state = 'tester_note_only';
    }).join('\n')).toMatch(/verified in evidence/);
  });
});

describe('ia-findings render', () => {
  it('renders the example in the reference section order, in ASCII, as accessible HTML', () => {
    const { markdown, html } = renderIaFindings(example);
    expect(formatFindingsWhen(example.report.run.started_at)).toBe('18 October 2026, 5:09 PM Sydney time');
    expect(markdown).toContain('18 October 2026, 5:09 PM Sydney time');
    expect(markdown).toContain('> INTERNAL: not for clients. Rendered from ia-findings/0.1.');
    const headings = ['## Summary', '## What worked', '## Findings', '## Observations', '## Needs a human look (not scored)', '## Scope and limits'];
    let at = -1;
    for (const heading of headings) {
      const next = markdown.indexOf(heading);
      expect(next, heading).toBeGreaterThan(at);
      at = next;
    }
    expect(markdown).toContain('| Critical | 0 | - |');
    expect(markdown).toContain('| Medium | 1 | F-001 |');
    expect(markdown).toContain('| Low | 0 | - |');
    expect(markdown).toContain('Also: 2 observation(s), 2 item(s) that need a human look, 1 thing(s) that worked.');
    expect(markdown).toContain('Severity: Medium. Confidence: 80% (axe-core rule violation on a named element, same result on 8 page(s)).');
    expect(markdown).toContain('Also on: My account: login and sign-up forms (signed out)');
    expect(markdown).toContain('WCAG: 1.3.1 Info and Relationships (Level A)');
    expect(markdown).toContain('Automated tools catch only some accessibility issues. This report does not say the site meets any standard in full.');
    expect(markdown).toContain('### F-002. ARIA reference may point at a missing element');
    expect(nonAsciiCharacters(markdown)).toEqual([]);
    expect(nonAsciiCharacters(html)).toEqual([]);
    expect(html).toContain('<html lang="en-AU">');
    expect(html).toContain('<main>');
    expect(html).toContain('<th scope="col">Severity</th>');
    expect(html).toContain('class="banner"');
    expect(html).toContain('<h1>');
    expect(() => assertRenderedAscii('report.md', 'Menu \u2014 list')).toThrow(/non-ASCII/);
  });

  it('leaves the internal banner off a file that passed the client_ready gates', () => {
    const doc = structuredClone(example);
    doc.report.status = 'client_ready';
    doc.report.method = CLIENT_READY_METHOD;
    doc.report.standard.version = '2.2';
    doc.report.review = { reviewed_by: ['Lead Verifier'], reviewed_at: '2026-10-27' };
    const { markdown } = renderIaFindings(doc);
    expect(markdown).not.toContain('not for clients');
    expect(markdown).toContain('does not say the site meets any standard in full');
  });
});

describe('ia-findings from a hornet run', () => {
  it('maps axe impact to critical, high, medium, and low, and groups one rule across pages', () => {
    expect(AXE_IMPACT_TO_SEVERITY).toEqual({ critical: 'critical', serious: 'high', moderate: 'medium', minor: 'low' });
    const run = fixtureRun({
      pages: [
        {
          name: 'home',
          path: '/',
          result: {
            violations: [
              { rule: 'image-alt', impact: 'critical', help: 'Images must have alternative text', count: 2, example: '#photo', criteria: ['1.1.1'] },
              { rule: 'color-contrast', impact: 'serious', help: 'Elements must meet minimum color contrast ratio thresholds', count: 1, example: '.faint', criteria: ['1.4.3'] },
            ],
            review_rules: [{ rule: 'aria-valid-attr-value', criteria: ['4.1.2'], count: 2 }],
            needs_review: 1,
          },
        },
        {
          name: 'product',
          path: '/product',
          result: {
            violations: [
              { rule: 'image-alt', impact: 'minor', help: 'Images must have alternative text', count: 3, example: '#other', criteria: ['1.1.1'] },
              { rule: 'label', impact: 'moderate', help: 'Form elements must have labels', count: 1, example: '#email', criteria: ['4.1.2', '1.3.1'] },
              { rule: 'link-name', impact: 'minor', help: 'Links must have discernible text', count: 1, example: 'a.icon', criteria: ['2.4.4'] },
            ],
          },
        },
      ],
    });
    const doc = iaFindingsFromRun(run, {
      axeVersion: '4.10.2',
      axeFiles: [
        {
          path: 'qa-user-1/pages/accessibility-home.json',
          body: {
            violations: [
              {
                id: 'image-alt',
                nodes: [{ target: '#photo', html: '<button>\u2212</button>', summary: 'Element does not have an alt attribute' }],
              },
            ],
          },
        },
      ],
    });
    expect(doc.report.status).toBe('internal');
    expect(doc.report.method).toBe('Automated checks (axe-core) plus a scripted journey run');
    expect(doc.report.subject.kind).toBe('fictional_demo');
    expect(doc.report.standard).toMatchObject({ version: '2.2', level: 'AA' });
    const byRule = Object.fromEntries(doc.findings.map((finding) => [finding.source?.rule_id, finding]));
    expect(byRule['image-alt']).toMatchObject({
      kind: 'issue',
      severity: 'critical',
      occurrences: 5,
      confidence: { score: CONFIDENCE_RUBRIC.automatedRule, evidence_state: 'verified_in_evidence' },
    });
    expect(byRule['image-alt']?.location.also_on).toEqual(['product']);
    expect(byRule['image-alt']?.location.element?.snippet).toContain('\\u2212');
    expect(byRule['image-alt']?.evidence[0]?.ref).toBe('qa-user-1/pages/accessibility-home.json#/violations');
    expect(byRule['color-contrast']?.severity).toBe('high');
    expect(byRule.label?.severity).toBe('medium');
    expect(byRule['link-name']?.severity).toBe('low');
    expect(byRule['aria-valid-attr-value']).toMatchObject({ kind: 'needs_review', severity: 'none', confidence: { score: CONFIDENCE_RUBRIC.toolUndecided } });
    expect(byRule['image-alt']?.wcag?.[0]).toEqual({ sc: '1.1.1', name: 'Non-text Content', level: 'A' });
    expect(validateIaFindings(doc).errors).toEqual([]);
    const rendered = renderIaFindings(doc);
    expect(nonAsciiCharacters(rendered.markdown)).toEqual([]);
    expect(nonAsciiCharacters(rendered.html)).toEqual([]);
  });

  it('keeps a harness failure as an issue and an undecided signal as needs_review', () => {
    const signals = cleanSignals();
    const run = fixtureRun({
      pages: [
        {
          name: 'sign-in',
          path: '/login',
          result: {
            wcag22: {
              ...signals,
              focus_not_obscured: { checked: 4, hidden: [{ target: '#email', covered_by: '.banner' }] },
              dragging: [{ target: '.slider', reason: 'a custom slider' }],
            },
          },
        },
      ],
    });
    const doc = iaFindingsFromRun(run);
    const focus = doc.findings.find((finding) => finding.source?.rule_id === 'wcag22:focus-not-obscured');
    const dragging = doc.findings.find((finding) => finding.title.startsWith('A control looks like it is moved only by dragging'));
    expect(focus).toMatchObject({ kind: 'issue', severity: 'medium', confidence: { score: CONFIDENCE_RUBRIC.automatedRule } });
    expect(focus?.wcag?.[0]?.sc).toBe('2.4.11');
    expect(dragging).toMatchObject({ kind: 'needs_review', severity: 'none', confidence: { score: CONFIDENCE_RUBRIC.toolUndecided } });
  });

  it('records an HTTP fact at 0.9 and bumps a confirmed finding by 0.1 without marking the file ready for a client', () => {
    const run = fixtureRun({
      pages: [{ name: 'home', path: '/', result: { violations: [{ rule: 'image-alt', impact: 'critical', help: 'Images must have alternative text', count: 1, example: '#photo', criteria: ['1.1.1'] }] } }],
    });
    const doc = iaFindingsFromRun(run, {
      reviewedBy: ['Lead Verifier'],
      facts: [
        {
          title: 'Privacy policy link returns 404',
          page: 'My account',
          url: 'http://127.0.0.1:4173/my-account/',
          who: 'All shoppers',
          how: 'They cannot read the privacy policy before signing up or paying.',
          basis: 'http',
          expected: 'The link opens the privacy policy.',
          actual: 'HTTP 404',
          recommendation: 'Publish the privacy policy page, or point the link at the right page.',
          description: 'Privacy policy link',
          selector: 'a[href="/privacy"]',
          evidenceRef: 'run.json#/facts/privacy',
          evidenceType: 'http',
        },
      ],
    });
    expect(doc.report.status).toBe('internal');
    expect(doc.report.review?.reviewed_by).toEqual(['Lead Verifier']);
    const issue = doc.findings.find((finding) => finding.kind === 'issue');
    expect(issue?.confidence.score).toBe(0.9);
    expect(issue?.confidence.basis).toContain('independent reviewer confirmed it');
    const privacy = doc.findings.find((finding) => finding.title === 'Privacy policy link returns 404');
    expect(privacy).toMatchObject({ kind: 'observation', severity: 'low', confidence: { score: 1, basis: 'HTTP status recorded by the test run; an independent reviewer confirmed it' } });
    expect(validateIaFindings(doc).errors).toEqual([]);
  });
});

describe('writing findings beside the existing reports', () => {
  const analysis = {
    status: 'passed',
    redaction: 'pass',
    gate: 'all',
    gate_passed: true,
    confidence: 1,
    suspected_cause: 'none',
    chaos: null,
    users: [],
    repro_steps: [],
    related_regressions: [],
    suggested_next_actions: [],
  } as Analysis;

  it('writes ia-findings.json, ia-report.md, and ia-report.html, and leaves report.html alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-ia-findings-'));
    dirs.push(dir);
    const run = fixtureRun({
      pages: [{ name: 'home', path: '/', result: { violations: [{ rule: 'image-alt', impact: 'critical', help: 'Images must have alternative text', count: 1, example: '#photo', criteria: ['1.1.1'] }] } }],
    });
    writeRunReports(dir, run, analysis, 'Summary line', new Redactor(), undefined, { baseUrl: 'http://127.0.0.1:4173', subjectName: 'Fixture Shop' });
    const findings = JSON.parse(readFileSync(join(dir, 'ia-findings.json'), 'utf8')) as IaFindingsFile;
    expect(validateIaFindings(findings).errors).toEqual([]);
    expect(findings.report.status).toBe('internal');
    expect(findings.report.subject).toMatchObject({ name: 'Fixture Shop', kind: 'fictional_demo' });
    expect(findings.findings.some((finding) => finding.severity === 'critical' && finding.kind === 'issue')).toBe(true);
    const html = readFileSync(join(dir, 'ia-report.html'), 'utf8');
    expect(html).toContain('ia-findings/0.1');
    expect(html).toContain('lang="en-AU"');
    expect(readFileSync(join(dir, 'ia-report.md'), 'utf8')).toContain('## Findings');
    const existing = readFileSync(join(dir, 'report.html'), 'utf8');
    expect(existing).toContain('Redaction: PASS');
    expect(existing).not.toContain('ia-findings/0.1');
  });

  it('writes no findings file when the run failed its redaction check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornet-ia-redaction-'));
    dirs.push(dir);
    writeRunReports(dir, fixtureRun({ redaction: 'fail', status: 'redaction_failure' }), { ...analysis, redaction: 'fail', status: 'redaction_failure' }, 'Summary', new Redactor());
    expect(existsSync(join(dir, 'ia-findings.json'))).toBe(false);
    expect(existsSync(join(dir, 'ia-report.md'))).toBe(false);
    expect(existsSync(join(dir, 'report.html'))).toBe(true);
  });
});
