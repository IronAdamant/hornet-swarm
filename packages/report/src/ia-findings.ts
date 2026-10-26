/**
 * Internal findings file, schema ia-findings/0.1. One JSON file per checking run; the human
 * report is rendered from that file. This is groundwork for Iron Adamant. It is not a client
 * report, and a normal run marks the file internal.
 *
 * The structural check follows the schema. The house rules match the reference validator:
 * ASCII everywhere, banned words in prose, an issue needs a severity and a confidence of at
 * least 0.5, and client_ready is allowed only for a reviewed WCAG 2.2 AA file whose issues are
 * verified in evidence.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccessibilityImpact } from '@hornet-swarm/core';

type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  const?: unknown;
  enum?: unknown[];
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  pattern?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
};

const SCHEMA = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ia-findings.schema.json'), 'utf8')) as JsonSchema;

/** RFC 3339 date-time, the shape the schema's format asks for. */
export const IA_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const IA_FINDINGS_SCHEMA_VERSION = 'ia-findings/0.1' as const;

/**
 * The only method wording a client_ready file may use. A normal run does not use this sentence,
 * so a normal run cannot be marked client_ready.
 */
export const CLIENT_READY_METHOD = 'automated checks against WCAG 2.2 AA plus a manual pass';

/** What a hornet-swarm run records. It is not the client_ready sentence. */
export const RUN_METHOD = 'Automated checks (axe-core) plus a scripted journey run';

/**
 * axe-core impact to finding severity. This scale belongs to the findings file.
 * Client reports still use the High / Medium / Low grades in docs/severity.md.
 */
export const AXE_IMPACT_TO_SEVERITY = {
  critical: 'critical',
  serious: 'high',
  moderate: 'medium',
  minor: 'low',
} as const satisfies Record<AccessibilityImpact, 'critical' | 'high' | 'medium' | 'low'>;

/**
 * Default confidence. Add `reviewerConfirms` once an independent reviewer confirms a finding.
 * 0.6 and 0.3 are for a manual pass; the run converter does not invent those.
 */
export const CONFIDENCE_RUBRIC = {
  recordedFact: 0.9,
  automatedRule: 0.8,
  manualWithScreenshot: 0.6,
  toolUndecided: 0.4,
  testerImpression: 0.3,
  reviewerConfirms: 0.1,
} as const;

/**
 * Banned in prose. The reference list, plus the words named for this build (pen test, red team,
 * attacker, authorise, authorize, hack). Matched on word boundaries, so "authorised" is not "authorise".
 */
export const BANNED_PROSE_WORDS = [
  'secure',
  'security',
  'compliant',
  'compliance',
  'certified',
  'certification',
  'guaranteed',
  'guarantee',
  'pentest',
  'pen test',
  'penetration',
  'red team',
  'attacker',
  'audit',
  'authorise',
  'authorize',
  'hack',
  'woocommerce testing',
  'woo builds',
] as const;

const BANNED_PATTERNS = BANNED_PROSE_WORDS.map((word) => ({
  word,
  pattern: new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
}));

/** Keys whose text is our prose. Quotes, selectors, and snippets are the site's own words and stay unchecked. */
const PROSE_KEYS = new Set([
  'title',
  'method',
  'how',
  'who',
  'basis',
  'expected',
  'actual',
  'recommendation',
  'data_note',
  'description',
  'page',
  'steps_to_reproduce',
  'disagreements',
]);

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

export type IaSeverity = 'critical' | 'high' | 'medium' | 'low' | 'none';
export type IaKind = 'issue' | 'needs_review' | 'observation' | 'what_worked';
export type IaStatus = 'draft' | 'internal' | 'client_ready';
export type IaSubjectKind = 'client' | 'fictional_demo' | 'own_site';

export type IaFinding = {
  id: string;
  kind: IaKind;
  title: string;
  severity: IaSeverity;
  location: {
    page: string;
    url: string;
    journey_step?: number;
    element?: { selector?: string; snippet?: string; description?: string };
    also_on?: string[];
  };
  affects: { who: string; how: string }[];
  wcag?: { sc: string; name: string; level: 'A' | 'AA' | 'AAA' }[];
  confidence: { score: number; basis: string; evidence_state: 'verified_in_evidence' | 'tester_note_only' };
  steps_to_reproduce?: string[];
  expected?: string;
  actual?: string;
  recommendation?: string;
  source?: { method?: 'automated' | 'manual' | 'journey'; tool?: string; rule_id?: string };
  occurrences?: number;
  evidence: { type: 'screenshot' | 'tool_output' | 'log' | 'quote' | 'http'; ref: string; quote?: string; captured_at?: string }[];
};

export type IaFindingsFile = {
  schema_version: typeof IA_FINDINGS_SCHEMA_VERSION;
  report: {
    id: string;
    title: string;
    subject: { name: string; base_url: string; kind: IaSubjectKind };
    standard: { name: 'WCAG'; version: string; level: 'A' | 'AA'; tool_tags?: string[] };
    method: string;
    run: {
      started_at: string;
      finished_at?: string;
      timezone: string;
      viewport?: string;
      tools: { name: string; version: string }[];
    };
    scope: { in: string[]; out: string[]; data_note?: string };
    status: IaStatus;
    review?: { reviewed_by: string[]; reviewed_at: string; disagreements?: string[] };
  };
  findings: IaFinding[];
};

export type IaValidation = { errors: string[]; warnings: string[] };

export class IaFindingsError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('\n'));
    this.name = 'IaFindingsError';
  }
}

export function applyReviewerBump(score: number, confirmed: boolean): number {
  if (!confirmed) return score;
  return Math.min(1, Math.round((score + CONFIDENCE_RUBRIC.reviewerConfirms) * 10) / 10);
}

export function nonAsciiCharacters(text: string): string[] {
  return [...text].filter((char) => (char.codePointAt(0) ?? 0) > 127);
}

/** ASCII-escape markup and quotes so a saved snippet cannot fail the ASCII gate. */
export function asciiEscape(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 128) out += char;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += `\\u{${code.toString(16)}}`;
  }
  return out;
}

export function clippedEscape(value: string, max = 300): string {
  const escaped = asciiEscape(value);
  if (escaped.length <= max) return escaped;
  const cut = escaped.slice(0, max);
  const tail = /\\u(?:[0-9a-f]{0,3}|\{[0-9a-f]*)$/i.exec(cut);
  return tail?.index === undefined ? cut : cut.slice(0, tail.index);
}

export function bannedWordsIn(text: string): string[] {
  return BANNED_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ word }) => word);
}

/** Keep a prose string, or the fallback when it is empty, non-ASCII, or uses a banned word. */
export function safeProse(text: string, fallback: string): string {
  const ascii = [...text].filter((char) => (char.codePointAt(0) ?? 0) < 128).join('').replace(/\s+/g, ' ').trim();
  if (!ascii || bannedWordsIn(ascii).length > 0) return fallback;
  return ascii;
}

export function assertRenderedAscii(name: string, text: string): void {
  if (nonAsciiCharacters(text).length > 0) throw new IaFindingsError([`rendered ${name} has non-ASCII characters`]);
}

function resolveSchema(schema: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split('/').at(-1) ?? '';
  return SCHEMA.$defs?.[name] ?? schema;
}

function check(node: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  const sch = resolveSchema(schema);
  if ('const' in sch && node !== sch.const) errors.push(`${path}: must be ${JSON.stringify(sch.const)}`);
  if (sch.enum && !sch.enum.includes(node)) errors.push(`${path}: ${JSON.stringify(node)} not one of ${JSON.stringify(sch.enum)}`);
  if (sch.type === 'object') {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of sch.required ?? []) if (!(key in record)) errors.push(`${path}: missing ${key}`);
    const props = sch.properties ?? {};
    for (const [key, value] of Object.entries(record)) {
      const child = props[key];
      if (child) check(value, child, `${path}.${key}`, errors);
      else if (sch.additionalProperties === false) errors.push(`${path}: unknown field ${key}`);
    }
    return;
  }
  if (sch.type === 'array') {
    if (!Array.isArray(node)) {
      errors.push(`${path}: must be a list`);
      return;
    }
    if (node.length < (sch.minItems ?? 0)) errors.push(`${path}: needs at least ${sch.minItems} item(s)`);
    node.forEach((value, index) => check(value, sch.items ?? {}, `${path}[${index}]`, errors));
    return;
  }
  if (sch.type === 'string') {
    if (typeof node !== 'string') {
      errors.push(`${path}: must be text`);
      return;
    }
    if (sch.pattern && !new RegExp(sch.pattern).test(node)) errors.push(`${path}: ${JSON.stringify(node)} does not match ${sch.pattern}`);
    if (node.length > (sch.maxLength ?? 1_000_000_000)) errors.push(`${path}: longer than ${sch.maxLength}`);
    if (sch.format === 'date-time' && !IA_DATE_TIME.test(node)) errors.push(`${path}: must be a date-time`);
    return;
  }
  if (sch.type === 'number' || sch.type === 'integer') {
    if (typeof node !== 'number' || (sch.type === 'integer' && !Number.isInteger(node))) {
      errors.push(`${path}: must be a ${sch.type}`);
      return;
    }
    if (node < (sch.minimum ?? -1e18) || node > (sch.maximum ?? 1e18)) errors.push(`${path}: out of range`);
  }
}

function isProsePath(path: string): boolean {
  const key = path.replace(/\[\d+\]/g, '').split('.').at(-1) ?? '';
  return PROSE_KEYS.has(key) || path.endsWith('.in') || path.endsWith('.out') || path.includes('.scope.');
}

function walk(node: unknown, path = ''): Array<[string, unknown]> {
  if (Array.isArray(node)) return node.flatMap((value, index) => walk(value, `${path}[${index}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => walk(value, `${path}.${key}`));
  }
  return [[path, node]];
}

type LooseFinding = { id?: unknown; kind?: unknown; severity?: unknown; confidence?: { score?: unknown; evidence_state?: unknown } };

function houseRules(doc: Record<string, unknown>): IaValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [path, value] of walk(doc)) {
    if (typeof value !== 'string') continue;
    if (nonAsciiCharacters(value).length > 0) errors.push(`${path}: non-ASCII character (escape it or reword)`);
    if (!isProsePath(path)) continue;
    for (const word of bannedWordsIn(value)) errors.push(`${path}: banned word "${word}"`);
  }
  const report = doc.report as { status?: unknown; method?: unknown; standard?: { version?: unknown; level?: unknown }; review?: { reviewed_by?: unknown } };
  const standard = report.standard ?? {};
  const findings = Array.isArray(doc.findings) ? (doc.findings as LooseFinding[]) : [];
  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) errors.push('findings: duplicate ids');
  for (const finding of findings) {
    const id = typeof finding.id === 'string' ? finding.id : 'finding';
    if (finding.kind === 'issue' && finding.severity === 'none') errors.push(`${id}: an issue needs a severity`);
    if ((finding.kind === 'needs_review' || finding.kind === 'what_worked') && finding.severity !== 'none') {
      errors.push(`${id}: ${String(finding.kind)} must have severity none`);
    }
    const score = finding.confidence?.score;
    if (finding.kind === 'issue' && typeof score === 'number' && score < 0.5) {
      errors.push(`${id}: confidence under 0.5 belongs in needs_review, not issue`);
    }
  }
  const version = standard.version;
  const level = standard.level;
  if (report.status === 'client_ready') {
    if (version !== '2.2' || level !== 'AA') errors.push(`report.standard: client reports must be WCAG 2.2 AA (this run is ${String(version)} ${String(level)})`);
    if (report.method !== CLIENT_READY_METHOD) errors.push(`report.method: client wording must be exactly "${CLIENT_READY_METHOD}"`);
    const reviewers = report.review?.reviewed_by;
    if (!Array.isArray(reviewers) || reviewers.length < 1) errors.push('report.review: a client report needs at least one independent reviewer recorded');
    for (const finding of findings) {
      if (finding.kind === 'issue' && finding.confidence?.evidence_state !== 'verified_in_evidence') {
        errors.push(`${String(finding.id)}: client issues must be verified in evidence`);
      }
    }
  } else if (version !== '2.2' || level !== 'AA') {
    warnings.push(`standard is WCAG ${String(version)} ${String(level)}, so this file can never be marked client_ready`);
  }
  return { errors, warnings };
}

export function validateIaFindings(input: unknown): IaValidation {
  const errors: string[] = [];
  check(input, SCHEMA, '$', errors);
  if (errors.length > 0 || !input || typeof input !== 'object') return { errors, warnings: [] };
  const house = houseRules(input as Record<string, unknown>);
  return { errors: [...errors, ...house.errors], warnings: house.warnings };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** "18 October 2026, 5:09 PM Sydney time". Built from numeric parts so the locale cannot insert a non-ASCII space. */
export function formatFindingsWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const month = MONTHS[Number(get('month')) - 1] ?? get('month');
  const minute = get('minute').padStart(2, '0');
  const period = get('dayPeriod').replace(/[^A-Za-z]/g, '').toUpperCase();
  return `${Number(get('day'))} ${month} ${get('year')}, ${Number(get('hour'))}:${minute} ${period} Sydney time`;
}

function renderMarkdown(doc: IaFindingsFile): string {
  const report = doc.report;
  const findings = doc.findings;
  const issues = findings.filter((finding) => finding.kind === 'issue').sort((left, right) => SEVERITY_ORDER.indexOf(left.severity as (typeof SEVERITY_ORDER)[number]) - SEVERITY_ORDER.indexOf(right.severity as (typeof SEVERITY_ORDER)[number]));
  const observations = findings.filter((finding) => finding.kind === 'observation');
  const review = findings.filter((finding) => finding.kind === 'needs_review');
  const worked = findings.filter((finding) => finding.kind === 'what_worked');
  const lines: string[] = [];
  if (report.status !== 'client_ready') lines.push(`> ${report.status.toUpperCase()}: not for clients. Rendered from ${doc.schema_version}.`, '');
  lines.push(
    `# ${report.title}`,
    '',
    `Run: ${formatFindingsWhen(report.run.started_at)}. Standard: WCAG ${report.standard.version} ${report.standard.level}. Method: ${report.method}.`,
    '',
    '## Summary',
    '',
    '| Severity | Count | Findings |',
    '|---|---|---|',
  );
  for (const severity of SEVERITY_ORDER) {
    const hit = issues.filter((finding) => finding.severity === severity).map((finding) => finding.id);
    lines.push(`| ${severity.charAt(0).toUpperCase()}${severity.slice(1)} | ${hit.length} | ${hit.join(', ') || '-'} |`);
  }
  lines.push('', `Also: ${observations.length} observation(s), ${review.length} item(s) that need a human look, ${worked.length} thing(s) that worked.`, '');
  if (worked.length > 0) lines.push('## What worked', '', ...worked.map((finding) => `- ${finding.title}`), '');
  const block = (finding: IaFinding): string[] => {
    const location = finding.location;
    const out = [`### ${finding.id}. ${finding.title}`, ''];
    const percent = Math.round(finding.confidence.score * 100);
    if (finding.severity !== 'none') out.push(`Severity: ${finding.severity.charAt(0).toUpperCase()}${finding.severity.slice(1)}. Confidence: ${percent}% (${finding.confidence.basis}).`);
    else out.push(`Confidence: ${percent}% (${finding.confidence.basis}).`);
    out.push('', `Where: ${location.page}, ${location.url}`);
    const element = location.element ?? {};
    if (element.description) out.push(`Element: ${element.description}`);
    if (element.selector) out.push(`Selector: \`${element.selector}\``);
    if (location.also_on && location.also_on.length > 0) out.push(`Also on: ${location.also_on.join('; ')}`);
    out.push('', 'Who it affects:', ...finding.affects.map((affects) => `- ${affects.who}: ${affects.how}`));
    if (finding.wcag && finding.wcag.length > 0) {
      out.push('', `WCAG: ${finding.wcag.map((item) => `${item.sc} ${item.name} (Level ${item.level})`).join('; ')}`);
    }
    for (const [key, label] of [
      ['expected', 'Expected'],
      ['actual', 'Actual'],
      ['recommendation', 'Suggested fix'],
    ] as const) {
      const text = finding[key];
      if (text) out.push('', `${label}: ${text}`);
    }
    const shown = finding.evidence.slice(0, 4).map((item) => `\`${item.ref}\``).join('; ');
    const more = finding.evidence.length > 4 ? ` and ${finding.evidence.length - 4} more` : '';
    out.push('', `Evidence: ${shown}${more}`, '');
    return out;
  };
  for (const [title, group] of [
    ['Findings', issues],
    ['Observations', observations],
    ['Needs a human look (not scored)', review],
  ] as const) {
    if (group.length === 0) continue;
    lines.push(`## ${title}`, '');
    for (const finding of group) lines.push(...block(finding));
  }
  const scope = report.scope;
  lines.push('## Scope and limits', '', `Checked: ${scope.in.join('; ')}.`, '', `Not checked: ${scope.out.join('; ')}.`, '');
  if (scope.data_note) lines.push(scope.data_note, '');
  lines.push(
    'Automated tools catch only some accessibility issues. This report does not say the site meets any standard in full.',
    '',
    `Tools: ${report.run.tools.map((tool) => `${tool.name} ${tool.version}`).join(', ')}.`,
    '',
  );
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function inline(value: string): string {
  return escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function markdownToHtml(markdown: string, title: string): string {
  const out: string[] = [];
  let inList = false;
  let inTable = false;
  const closeList = () => {
    if (!inList) return;
    out.push('</ul>');
    inList = false;
  };
  const closeTable = () => {
    if (!inTable) return;
    out.push('</tbody></table>');
    inTable = false;
  };
  for (const line of markdown.split('\n')) {
    if (inList && !line.startsWith('- ')) closeList();
    if (inTable && !line.startsWith('|')) closeTable();
    if (line.startsWith('> ')) out.push(`<p class="banner"><strong>${inline(line.slice(2))}</strong></p>`);
    else if (line.startsWith('### ')) out.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.startsWith('## ')) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith('# ')) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith('- ')) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.startsWith('|---')) continue;
    else if (line.startsWith('|')) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      if (!inTable) {
        out.push(`<table><thead><tr>${cells.map((cell) => `<th scope="col">${inline(cell)}</th>`).join('')}</tr></thead><tbody>`);
        inTable = true;
      } else out.push(`<tr>${cells.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`);
    } else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  closeTable();
  const css = 'body{font-family:sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}h1,h2,h3{color:#1b3a5c}table{border-collapse:collapse}td,th{border:1px solid #767676;padding:.25rem .5rem;text-align:left}code{font-size:.9em;overflow-wrap:anywhere}.banner{background:#fff4d6;border:1px solid #8a6d00;padding:.5rem}';
  return `<!DOCTYPE html>\n<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><main>\n${out.join('\n')}\n</main></body></html>\n`;
}

export function renderIaFindings(input: unknown): { markdown: string; html: string } {
  const result = validateIaFindings(input);
  if (result.errors.length > 0) throw new IaFindingsError(result.errors);
  const doc = input as IaFindingsFile;
  const markdown = renderMarkdown(doc);
  const html = markdownToHtml(markdown, doc.report.title);
  assertRenderedAscii('report.md', markdown);
  assertRenderedAscii('report.html', html);
  return { markdown, html };
}
