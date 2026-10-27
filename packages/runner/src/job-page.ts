import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { PAGE_MAP_LIMITS, UnredactableError, fixedText, renderTemplate, writeRedactedFile, type AccessibilityResult, type PageMap, type PassiveSecurityResult, type RedundantEntry, type Redactor, type Step, type StepResult, type TemplateContext } from '@hornet-swarm/core';
import type { JobReport, JobRequest, SecretMap } from './job-types.js';
import { locate, maskSecrets } from './job-net.js';

/**
 * A map of the page for drafting a journey. It reads only what a person can see, never a field's
 * value, so nothing a customer typed is saved. Each selector prefers a test id, then a stable id,
 * then a name attribute, then the element's role and accessible name.
 */
export async function inspectPage(page: Page): Promise<PageMap> {
  const words = await visibleWords(page);
  const map = await page.evaluate((limits) => {
    const visible = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const unique = (selector: string): boolean => {
      try {
        return document.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    };
    const quote = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const nameOf = (element: Element): string => {
      const labelled = element.getAttribute('aria-labelledby');
      if (labelled) {
        const text = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        if (clean(text)) return clean(text);
      }
      const aria = element.getAttribute('aria-label');
      if (clean(aria)) return clean(aria);
      if (element.id) {
        const forLabel = document.querySelector(`label[for="${quote(element.id)}"]`);
        if (forLabel && clean(forLabel.textContent)) return clean(forLabel.textContent);
      }
      const wrapping = element.closest('label');
      if (wrapping && clean(wrapping.textContent)) return clean(wrapping.textContent);
      const input = element as HTMLInputElement;
      if (['submit', 'button', 'reset'].includes(input.type) && clean(input.value)) return clean(input.value);
      const described = clean(element.getAttribute('placeholder')) || clean(element.getAttribute('title')) || clean(element.getAttribute('alt'));
      if (described) return described;
      // A field's own text is its options or its value, never its name.
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) return '';
      return clean((element as HTMLElement).innerText);
    };
    // Generated ids, such as "mat-input-12" or a hash, change between builds, so they are not offered.
    const stableId = (id: string): boolean => Boolean(id) && !/\d{2,}|^[a-f0-9-]{8,}$|^(ember|react|mui|radix|headlessui|ng-)/i.test(id);
    const suggest = (element: Element, role: string, name: string): { selector: string; checked: boolean } => {
      for (const attribute of ['data-test', 'data-testid', 'data-test-id', 'data-cy', 'data-qa']) {
        const value = element.getAttribute(attribute);
        if (value) {
          const selector = `[${attribute}="${quote(value)}"]`;
          if (unique(selector)) return { selector, checked: true };
        }
      }
      if (stableId(element.id)) {
        const selector = `#${CSS.escape(element.id)}`;
        if (unique(selector)) return { selector, checked: true };
      }
      const tag = element.tagName.toLowerCase();
      const named = element.getAttribute('name');
      if (named) {
        const selector = `${tag}[name="${quote(named)}"]`;
        if (unique(selector)) return { selector, checked: true };
      }
      if (name) return { selector: `role=${role}[name="${quote(name)}"]`, checked: false };
      return { selector: tag, checked: unique(tag) };
    };
    const all = (selector: string): Element[] => [...document.querySelectorAll(selector)].filter(visible);

    const headings = all('h1, h2, h3').map((element) => clean(element.textContent)).filter(Boolean).slice(0, limits.headings);

    const linkElements = all('a[href]');
    const seenLinks = new Set<string>();
    const links: PageMap['links'] = [];
    for (const element of linkElements) {
      const anchor = element as HTMLAnchorElement;
      let href = anchor.getAttribute('href') ?? '';
      try {
        const target = new URL(anchor.href);
        href = target.origin === location.origin ? `${target.pathname}${target.search}${target.hash}` : target.href;
      } catch {
        // Keep it as written.
      }
      const text = nameOf(element);
      const key = `${text}|${href}`;
      if (seenLinks.has(key) || href.startsWith('javascript:')) continue;
      seenLinks.add(key);
      links.push({ text, href, ...suggest(element, 'link', text) });
    }

    const buttonElements = all('button, input[type="submit"], input[type="button"], input[type="reset"], [role="button"]');
    const buttons = buttonElements.map((element) => {
      const text = nameOf(element);
      return { text, ...suggest(element, 'button', text), disabled: (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true' };
    });

    const fieldElements = all('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea');
    const roleOf = (element: Element): string => {
      const type = (element as HTMLInputElement).type;
      if (element.tagName === 'SELECT') return 'combobox';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    };
    const fields = fieldElements.map((element) => {
      // With no label a person can see, the field's own name says what it is for.
      const accessible = nameOf(element);
      const label =
        accessible ||
        clean(element.getAttribute('name')) ||
        clean(element.getAttribute('data-test') ?? element.getAttribute('data-testid')) ||
        clean(element.id);
      const kind = element.tagName === 'SELECT' ? 'select' : element.tagName === 'TEXTAREA' ? 'textarea' : (element as HTMLInputElement).type || 'text';
      const options =
        element.tagName === 'SELECT'
          ? [...(element as HTMLSelectElement).options].map((option) => clean(option.textContent)).filter(Boolean).slice(0, limits.options)
          : undefined;
      return {
        kind,
        label,
        // A role selector needs the accessible name, so a fallback name is never used for one.
        ...suggest(element, roleOf(element), accessible),
        required: (element as HTMLInputElement).required === true || element.getAttribute('aria-required') === 'true',
        ...(options ? { options } : {}),
      };
    });

    return {
      url: location.href,
      title: document.title,
      headings,
      links: links.slice(0, limits.links),
      buttons: buttons.slice(0, limits.buttons),
      fields: fields.slice(0, limits.fields),
      left_out: {
        links: Math.max(0, links.length - limits.links),
        buttons: Math.max(0, buttons.length - limits.buttons),
        fields: Math.max(0, fields.length - limits.fields),
      },
    };
  }, PAGE_MAP_LIMITS);
  return { ...map, text: words.slice(0, PAGE_MAP_LIMITS.text) };
}

/** What a step found besides pass or fail, carried into its result. */
export type StepFindings = { accessibility?: AccessibilityResult; passiveSecurity?: PassiveSecurityResult; redundantEntry?: RedundantEntry };

export function finishStep(
  index: number,
  type: string,
  status: StepResult['status'],
  started: number,
  selectors: string[],
  assertions: string[],
  screenshots: string[],
  consoleLogs: string[],
  network: { method: string; url: string; status: number }[],
  redactor: Redactor,
  blocked?: JobReport['blocked_reason'],
  httpStatus?: number,
  error?: string,
  found: StepFindings = {},
): JobReport['steps'][number] {
  const finished = Date.now();
  return {
    index,
    type,
    status,
    duration_ms: finished - started,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(finished).toISOString(),
    ...(selectors[0] ? { selector: redactor.redact(selectors[0]) } : {}),
    ...(assertions[0] ? { assertion: redactor.redact(assertions.join('; ')) } : {}),
    ...(error ? { error: redactor.redact(error) } : {}),
    ...(screenshots[0] ? { screenshot: screenshots[0] } : {}),
    ...(blocked ? { blocked_reason: blocked } : {}),
    console_error_count: consoleLogs.length,
    ...(network.length > 0 ? { network_errors: network.map((entry) => ({ ...entry, url: redactor.redact(entry.url) })) } : {}),
    ...(httpStatus ? { http_status: httpStatus } : {}),
    ...(found.accessibility ? { accessibility: found.accessibility } : {}),
    ...(found.passiveSecurity ? { passive_security: found.passiveSecurity } : {}),
    ...(found.redundantEntry ? { redundant_entry: found.redundantEntry } : {}),
    console_logs: consoleLogs.map((line) => redactor.redact(line)),
    selectors: selectors.map((selector) => redactor.redact(selector)),
    assertions: assertions.map((assertion) => redactor.redact(assertion)),
    screenshot_paths: screenshots,
  };
}

const MESSAGE_SELECTORS =
  '[role="alert"], [data-test="error"], [aria-live="assertive"], .error-message-container, .flash, .alert, .error, .invalid-feedback, .toast-message, .toast, .snackbar, .notification, [role="status"]';

/**
 * The page's visible words without the options inside dropdowns. A page's text lists every option
 * of every dropdown, such as "Error 12: Topic not found" in a subject list, which reads like an
 * error on the page when it is only a choice nobody made. `Form fields:` shows the chosen option.
 */
export async function visibleWords(page: Page): Promise<string> {
  const body = await page.locator('body').innerText().catch(() => '');
  const options = await page
    .locator('select option')
    .evaluateAll((elements) => elements.map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))
    .catch(() => [] as string[]);
  if (options.length === 0) return body;
  const left = new Map<string, number>();
  for (const option of options) left.set(option, (left.get(option) ?? 0) + 1);
  return body
    .split('\n')
    .filter((line) => {
      const key = line.replace(/\s+/g, ' ').trim();
      const count = left.get(key) ?? 0;
      if (count === 0) return true;
      left.set(key, count - 1);
      return false;
    })
    .join('\n');
}

const FORM_FIELDS = 'input:not([type="hidden"]):not([type="password"]):not([type="file"]):not([type="submit"]):not([type="button"]), select, textarea';

/**
 * The page's visible words, then what each visible form field holds and which buttons are
 * disabled. The page's text alone leaves out field values, so it cannot show that a field reads
 * "missing value" or that Confirm is greyed out. Password fields are never read.
 */
export async function pageSnapshotText(page: Page): Promise<string> {
  const body = await visibleWords(page);
  const fields = await page
    .locator(FORM_FIELDS)
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((element) => {
          const field = element as HTMLInputElement;
          const name =
            field.labels?.[0]?.textContent?.trim() ||
            field.getAttribute('aria-label') ||
            field.getAttribute('placeholder') ||
            field.getAttribute('name') ||
            field.getAttribute('data-test') ||
            field.id ||
            field.tagName.toLowerCase();
          let value: string;
          if (field.tagName === 'SELECT') {
            const choice = element as HTMLSelectElement;
            value = choice.value ? (choice.selectedOptions[0]?.textContent?.trim() ?? choice.value) : '(nothing chosen)';
          }
          else if (field.type === 'checkbox' || field.type === 'radio') value = field.checked ? 'checked' : 'not checked';
          else value = field.value ? field.value : '(empty)';
          return `- ${name.replace(/\s+/g, ' ').slice(0, 60)}: ${value.replace(/\s+/g, ' ').slice(0, 120)}${field.disabled ? ' (disabled)' : ''}`;
        }),
    )
    .catch(() => [] as string[]);
  const disabled = await page
    .locator('button:disabled, input[type="submit"]:disabled, [role="button"][aria-disabled="true"]')
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getBoundingClientRect().width > 0)
        .map((element) => `- ${((element as HTMLElement).innerText || element.getAttribute('value') || element.getAttribute('aria-label') || 'button').trim().slice(0, 60)} (disabled)`),
    )
    .catch(() => [] as string[]);
  const sections = [body.trim()];
  if (fields.length > 0) sections.push(`Form fields:\n${fields.join('\n')}`);
  if (disabled.length > 0) sections.push(`Disabled buttons:\n${disabled.join('\n')}`);
  return `${sections.join('\n\n')}\n`;
}

/** Text that still holds a secret after masking is not saved; a `.withheld` note takes its place. */
export function saveSealed(path: string, text: string, redactor: Redactor): void {
  try {
    writeRedactedFile(path, redactor.seal(text), { parent: 'chosen' });
  } catch (error) {
    if (!(error instanceof UnredactableError)) throw error;
    rmSync(path, { force: true });
    writeRedactedFile(`${path}.withheld`, fixedText('withheld because masking could not remove a secret\n'), { parent: 'chosen' });
  }
}

export async function captureFailure(page: Page, job: JobRequest, index: number, secrets: SecretMap, redactor: Redactor, screenshots: string[]): Promise<void> {
  try {
    await maskSecrets(page, secrets);
    const path = join(job.outDir, `failed-step-${index}.png`);
    await page.screenshot({ path, timeout: 5_000, mask: [page.locator('input[type="password"], [data-hornet-swarm-secret]')] });
    screenshots.push(path);
    saveSealed(join(job.outDir, `failed-step-${index}.txt`), await pageSnapshotText(page), redactor);
  } catch {
    // A page that has crashed or closed has nothing to capture. The step error still stands.
  }
}

/** Similarity of two short strings from 0 to 1, by edit distance. */
export function similarity(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - (previous[b.length] ?? 0) / Math.max(a.length, b.length);
}

/** The words on the page closest to what a check expected, such as "Releated items" for "Related items". */
export function closestText(lines: string[], expected: string): string | undefined {
  const want = expected.trim();
  const size = want.split(/\s+/).length;
  let best: { text: string; score: number } | undefined;
  for (const line of lines) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    for (let start = 0; start + size <= words.length; start += 1) {
      const text = words.slice(start, start + size).join(' ');
      const score = similarity(text, want);
      if (score < 1 && score >= 0.6 && (!best || score > best.score)) best = { text, score };
    }
  }
  return best?.text;
}

const ERROR_LINE = /\berr+or\b|went wrong|failed|invalid|missing|required|unavailable|out of stock|sold out/i;

/**
 * What the page shows about a failed step: its own message, the state of the element the step
 * used (disabled, hidden, or what it actually reads), the closest words to an expected text, and
 * other error lines on the page. Each is short, and the whole list is kept under 500 characters.
 */
export async function failureClues(page: Page, step: Step, template: TemplateContext): Promise<string[]> {
  const clues: string[] = [];
  const said = await visibleMessage(page);
  if (said) clues.push(`page said: "${said}"`);
  let target = '';
  if ('click' in step) target = step.click.selector;
  else if ('fill' in step) target = step.fill.selector;
  else if ('select' in step) target = step.select.selector;
  else if ('wait' in step && step.wait.selector) target = step.wait.selector;
  else if ('assert' in step && (step.assert.type === 'selector_visible' || step.assert.type === 'field_value')) target = step.assert.selector ?? step.assert.value ?? '';
  target = renderTemplate(target, template);
  const hasText = /:has-text\((['"])(.*?)\1\)/.exec(target);
  const base = target.replace(/:has-text\((['"]).*?\1\)/g, '').replace(/:enabled\b/g, '').trim();
  if (base) {
    try {
      const element = locate(page, base).first();
      if ((await element.count()) > 0) {
        if (await element.isDisabled({ timeout: 1_000 }).catch(() => false)) clues.push('it is on the page but disabled');
        else if (!(await element.isVisible().catch(() => true))) clues.push('it is on the page but hidden');
        if (hasText?.[2]) {
          const reads = ((await element.innerText({ timeout: 1_000 }).catch(() => '')) || (await element.inputValue({ timeout: 500 }).catch(() => ''))).replace(/\s+/g, ' ').trim();
          if (reads && !reads.includes(hasText[2])) clues.push(`it reads "${reads.slice(0, 60)}"`);
        }
      } else if (!('assert' in step && step.assert.type === 'field_value')) {
        clues.push(`nothing on the page matches ${base}`);
      }
    } catch {
      // A selector the page cannot parse adds no clue.
    }
  }
  const body = await visibleWords(page);
  const lines = body.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 0 && line.length <= 160);
  const expected = 'assert' in step && step.assert.type === 'text_visible' ? renderTemplate(step.assert.value ?? '', template) : hasText?.[2];
  if (expected) {
    const near = closestText(lines, expected);
    if (near) clues.push(`closest text on the page: "${near}"`);
  }
  const errors = [...new Set(lines.filter((line) => ERROR_LINE.test(line) && !said.includes(line)))].slice(0, 2);
  for (const line of errors) clues.push(`page also shows: "${line.slice(0, 120)}"`);
  const kept: string[] = [];
  let length = 0;
  for (const clue of clues) {
    if (length + clue.length > 500) break;
    kept.push(clue);
    length += clue.length;
  }
  return kept;
}

/** The first visible error or alert text on the page, up to 200 characters. */
async function visibleMessage(page: Page): Promise<string> {
  try {
    const texts = await page.locator(MESSAGE_SELECTORS).evaluateAll((elements) =>
      elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((element) => (element as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    );
    // A message has words. Leftover values such as "true" or "0" in an alert box are not one.
    const first = texts.find((text) => /[a-z]{2,}/i.test(text) && !/^(true|false|null|undefined)$/i.test(text)) ?? '';
    return first.length > 200 ? `${first.slice(0, 197)}...` : first;
  } catch {
    return '';
  }
}
