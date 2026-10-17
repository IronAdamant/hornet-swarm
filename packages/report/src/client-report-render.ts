import { assertNoComplianceClaim } from '@hornet-swarm/core';
import { reportDate } from './client-report-builder.js';
import { clientReportSchema, type ClientIssue, type ClientJourneyResult, type ClientReport } from './client-report-model.js';

const JOURNEY_WORDS: Readonly<Record<ClientJourneyResult['status'], string>> = {
  worked: 'Worked',
  failed: 'Did not work',
  blocked: 'Could not finish',
  not_tested: 'Not tested',
  out_of_scope: 'Left out on purpose',
};

const AUTOMATION_WORDS = { automated: 'Automated', partial: 'Partly automated', manual: 'Manual' } as const;

/**
 * Both forms of the client report. The model is checked again first, so a report read back from
 * disk cannot carry a criterion row it should not, and the finished text is refused if it would
 * claim the site is compliant or certified.
 */
export function renderClientReport(input: ClientReport): { markdown: string; html: string } {
  const report = clientReportSchema.parse(input);
  const markdown = clientReportMarkdown(report);
  const html = clientReportHtml(report);
  assertNoComplianceClaim(markdown, 'The Markdown report says');
  assertNoComplianceClaim(html, 'The HTML report says');
  return { markdown, html };
}

function title(report: ClientReport): string {
  return `Accessibility and journey test: ${report.client.site_name}`;
}

function preparedLine(report: ClientReport): string {
  return `Prepared by ${report.brand.name} for ${report.client.business_name} · Tested ${reportDate(report.tested_at)} · Run ${report.run_id}`;
}

function contactLine(report: ClientReport): string {
  const parts = [report.brand.website, report.brand.contact_email, report.brand.contact_phone].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `${report.brand.name} · ${parts.join(' · ')}` : report.brand.name;
}

function whereWords(issue: ClientIssue): string[] {
  return issue.where.map((entry) => {
    const page = entry.address ? `${entry.page} (${entry.address})` : entry.page;
    const places = issue.source === 'journey' ? '' : `, ${entry.places} ${entry.places === 1 ? 'place' : 'places'}`;
    return `${page}${places}${entry.example ? `, such as \`${entry.example}\`` : ''}`;
  });
}

function criteriaWords(issue: ClientIssue): string {
  return issue.criteria.length > 0 ? issue.criteria.join(', ') : 'None. This is a journey that did not work, not an accessibility criterion.';
}

export function clientReportMarkdown(report: ClientReport): string {
  const lines: string[] = [];
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  if (report.brand.logo_data_uri) lines.push(`![${report.brand.logo_alt ?? report.brand.name}](${report.brand.logo_data_uri})`, '');
  lines.push(`# ${title(report)}`, '', preparedLine(report), '');
  lines.push('## Summary', '', `**${report.executive_summary.headline}.**`, '', ...report.executive_summary.paragraphs.flatMap((paragraph) => [paragraph, '']));

  lines.push('## Journey results', '', '| Journey | Result | What happened |', '|---|---|---|');
  for (const journey of report.journeys) lines.push(`| ${cell(journey.title)} | ${JOURNEY_WORDS[journey.status]} | ${cell(journey.summary)} |`);
  lines.push('');

  lines.push('## Issues, most important first', '');
  if (report.issues.length === 0) lines.push('The automated checks found no issues on the tested pages. The criteria that need a person are listed further down.', '');
  for (const issue of report.issues) {
    lines.push(`### ${issue.id} · ${issue.severity} · ${issue.title}`, '');
    const where = whereWords(issue);
    lines.push(where.length === 1 ? `- **Where:** ${where[0]}` : '- **Where:**', ...(where.length === 1 ? [] : where.map((entry) => `  - ${entry}`)));
    lines.push(
      `- **Why it matters to your customers:** ${issue.why_it_matters}`,
      `- **How to fix it:** ${issue.how_to_fix}`,
      `- **Severity:** ${issue.severity}. ${issue.severity_reason}`,
      `- **WCAG 2.2 criteria:** ${criteriaWords(issue)}`,
      `- **Evidence:** ${issue.evidence.length > 0 ? issue.evidence.map((path) => `\`${path}\``).join(', ') : 'the run\'s results in run.json'}`,
      `- **Re-test key:** \`${issue.key}\``,
      '',
    );
  }
  if (report.withdrawn.length > 0) {
    lines.push('### Withdrawn after review', '', 'A reviewer checked these automated findings and found them to be wrong on this site.', '');
    for (const entry of report.withdrawn) lines.push(`- ${entry.title} (\`${entry.key}\`): ${entry.reason}`);
    lines.push('');
  }

  lines.push('## Needs a person to review', '');
  if (report.review_items.length === 0) lines.push('The automated checks flagged nothing extra on these pages. The criteria marked "Needs manual review" below still need a person.', '');
  else {
    lines.push('| WCAG 2.2 criterion | What to check | Where |', '|---|---|---|');
    for (const item of report.review_items) lines.push(`| ${cell(item.criterion)} | ${cell(item.what)} | ${cell(item.where)} |`);
    lines.push('');
  }

  lines.push('## What was tested', '', `- **Site:** ${report.client.site_url}`, `- **Standard:** WCAG 2.2 level AA`, `- **Test accounts:** ${report.accounts}`, '- **Pages checked for accessibility:**');
  if (report.pages_tested.length === 0) lines.push('  - None. No journey in this run checked a page for accessibility.');
  for (const page of report.pages_tested) lines.push(`  - ${page.name} (${page.address || '/'})`);
  lines.push('');

  lines.push('## WCAG 2.2 A and AA criteria', '', 'How each criterion was checked, and what was found. "Partly automated" and "Manual" criteria are never marked as clear.', '');
  lines.push('| Criterion | Level | How it was checked | Result | What a person checks |', '|---|---|---|---|---|');
  for (const row of report.criteria) {
    const result = row.outcome === 'issues_found' ? `${row.outcome_words} (${row.issues})` : row.outcome_words;
    lines.push(`| ${row.id} ${cell(row.title)}${row.introduced === '2.2' ? ' (new in 2.2)' : ''} | ${row.level} | ${AUTOMATION_WORDS[row.automation]} | ${result} | ${cell(row.note)} |`);
  }
  lines.push('', '4.1.1 Parsing is not part of WCAG 2.2 and is not checked.', '');

  lines.push('## Scope and limits', '', ...report.scope_and_limits.map((line) => `- ${line}`), '');

  lines.push('## Evidence appendix', '', `Every file is inside the run folder \`${report.run_id}\`, kept by ${report.brand.name}. Ask for any of them.`, '', '| File | What it holds |', '|---|---|');
  for (const entry of report.evidence_appendix) lines.push(`| \`${cell(entry.path)}\` | ${cell(entry.what)} |`);
  lines.push('', '---', '', contactLine(report), '');
  return `${lines.join('\n')}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STYLE = `body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1b1b1b;max-width:60rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
header{display:flex;gap:1rem;align-items:center;border-bottom:2px solid #1b1b1b;padding-bottom:1rem}header img{max-height:4rem;max-width:12rem}
h1{font-size:1.6rem;margin:0}h2{margin-top:2.5rem;border-bottom:1px solid #ccc}h3{margin-bottom:.25rem}.meta{color:#444}
.headline{font-size:1.2rem;font-weight:600;background:#f3f3f3;padding:.75rem 1rem;border-left:6px solid #1b1b1b}
table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #bbb;padding:.4rem .6rem;text-align:left;vertical-align:top}th{background:#eee}
.sev-High{color:#8a0000}.sev-Medium{color:#7a4a00}.sev-Low{color:#24476b}code{background:#f3f3f3;padding:0 .2rem;word-break:break-all}
footer{margin-top:3rem;border-top:1px solid #ccc;padding-top:1rem;color:#444}@media print{body{margin:0}h2{break-after:avoid}}`;

export function clientReportHtml(report: ClientReport): string {
  const e = escapeHtml;
  const parts: string[] = [];
  parts.push(`<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title(report))}</title><style>${STYLE}</style></head><body>`);
  parts.push('<header>');
  if (report.brand.logo_data_uri) parts.push(`<img src="${e(report.brand.logo_data_uri)}" alt="${e(report.brand.logo_alt ?? report.brand.name)}">`);
  parts.push(`<div><h1>${e(title(report))}</h1><p class="meta">${e(preparedLine(report))}</p></div></header><main>`);
  parts.push(`<h2>Summary</h2><p class="headline">${e(report.executive_summary.headline)}.</p>${report.executive_summary.paragraphs.map((paragraph) => `<p>${e(paragraph)}</p>`).join('')}`);
  parts.push(`<h2>Journey results</h2><table><thead><tr><th scope="col">Journey</th><th scope="col">Result</th><th scope="col">What happened</th></tr></thead><tbody>${report.journeys
    .map((journey) => `<tr><th scope="row">${e(journey.title)}</th><td>${e(JOURNEY_WORDS[journey.status])}</td><td>${e(journey.summary)}</td></tr>`)
    .join('')}</tbody></table>`);
  parts.push('<h2>Issues, most important first</h2>');
  if (report.issues.length === 0) parts.push('<p>The automated checks found no issues on the tested pages. The criteria that need a person are listed further down.</p>');
  for (const issue of report.issues) {
    parts.push(
      `<section><h3><span class="sev-${issue.severity}">${e(issue.id)} · ${e(issue.severity)}</span> · ${e(issue.title)}</h3><dl>`,
      `<dt>Where</dt><dd><ul>${whereWords(issue).map((entry) => `<li>${e(entry.replace(/`/g, ''))}</li>`).join('')}</ul></dd>`,
      `<dt>Why it matters to your customers</dt><dd>${e(issue.why_it_matters)}</dd>`,
      `<dt>How to fix it</dt><dd>${e(issue.how_to_fix)}</dd>`,
      `<dt>Severity</dt><dd>${e(`${issue.severity}. ${issue.severity_reason}`)}</dd>`,
      `<dt>WCAG 2.2 criteria</dt><dd>${e(criteriaWords(issue))}</dd>`,
      `<dt>Evidence</dt><dd>${issue.evidence.length > 0 ? issue.evidence.map((path) => `<code>${e(path)}</code>`).join(', ') : 'the run&#39;s results in run.json'}</dd>`,
      `<dt>Re-test key</dt><dd><code>${e(issue.key)}</code></dd></dl></section>`,
    );
  }
  if (report.withdrawn.length > 0) {
    parts.push(`<h3>Withdrawn after review</h3><p>A reviewer checked these automated findings and found them to be wrong on this site.</p><ul>${report.withdrawn.map((entry) => `<li>${e(entry.title)} (<code>${e(entry.key)}</code>): ${e(entry.reason)}</li>`).join('')}</ul>`);
  }
  parts.push('<h2>Needs a person to review</h2>');
  parts.push(
    report.review_items.length === 0
      ? '<p>The automated checks flagged nothing extra on these pages. The criteria marked &quot;Needs manual review&quot; below still need a person.</p>'
      : `<table><thead><tr><th scope="col">WCAG 2.2 criterion</th><th scope="col">What to check</th><th scope="col">Where</th></tr></thead><tbody>${report.review_items.map((item) => `<tr><td>${e(item.criterion)}</td><td>${e(item.what)}</td><td>${e(item.where)}</td></tr>`).join('')}</tbody></table>`,
  );
  parts.push(
    `<h2>What was tested</h2><ul><li>Site: ${e(report.client.site_url)}</li><li>Standard: WCAG 2.2 level AA</li><li>Test accounts: ${report.accounts}</li><li>Pages checked for accessibility:<ul>${
      report.pages_tested.length === 0 ? '<li>None. No journey in this run checked a page for accessibility.</li>' : report.pages_tested.map((page) => `<li>${e(page.name)} (${e(page.address || '/')})</li>`).join('')
    }</ul></li></ul>`,
  );
  parts.push(
    `<h2>WCAG 2.2 A and AA criteria</h2><p>How each criterion was checked, and what was found. &quot;Partly automated&quot; and &quot;Manual&quot; criteria are never marked as clear.</p><table><thead><tr><th scope="col">Criterion</th><th scope="col">Level</th><th scope="col">How it was checked</th><th scope="col">Result</th><th scope="col">What a person checks</th></tr></thead><tbody>${report.criteria
      .map(
        (row) =>
          `<tr><th scope="row">${e(`${row.id} ${row.title}${row.introduced === '2.2' ? ' (new in 2.2)' : ''}`)}</th><td>${row.level}</td><td>${AUTOMATION_WORDS[row.automation]}</td><td>${e(row.outcome === 'issues_found' ? `${row.outcome_words} (${row.issues})` : row.outcome_words)}</td><td>${e(row.note)}</td></tr>`,
      )
      .join('')}</tbody></table><p>4.1.1 Parsing is not part of WCAG 2.2 and is not checked.</p>`,
  );
  parts.push(`<h2>Scope and limits</h2><ul>${report.scope_and_limits.map((line) => `<li>${e(line)}</li>`).join('')}</ul>`);
  parts.push(
    `<h2>Evidence appendix</h2><p>Every file is inside the run folder <code>${e(report.run_id)}</code>, kept by ${e(report.brand.name)}. Ask for any of them.</p><table><thead><tr><th scope="col">File</th><th scope="col">What it holds</th></tr></thead><tbody>${report.evidence_appendix
      .map((entry) => `<tr><td><code>${e(entry.path)}</code></td><td>${e(entry.what)}</td></tr>`)
      .join('')}</tbody></table>`,
  );
  parts.push(`</main><footer>${e(contactLine(report))}</footer></body></html>\n`);
  return parts.join('');
}
