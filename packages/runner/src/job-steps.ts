import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { DEFAULT_ACCESSIBILITY_STANDARD, renderTemplate, resolveSelf, type Redactor, type Step, type TemplateContext } from '@hornet-swarm/core';
import { runAccessibilityCheck } from './accessibility-step.js';
import { pageKey, RedundantEntryTracker } from './redundant-entry-tracker.js';
import type { JobRequest, SecretMap } from './job-types.js';
import { readInboxCode } from './inbox.js';
import { inspectPage, pageSnapshotText, saveSealed, type StepFindings } from './job-page.js';
import { ASSERT_TIMEOUT_MS, absolute, deniedByMarker, fixturesDir, interruptible, locate, maskSecrets, originAllowed, pollUntil, waitForNavigationOrSettle, type NavState } from './job-net.js';

export async function runStep(
  page: Page,
  step: Step,
  secrets: SecretMap,
  job: JobRequest,
  template: TemplateContext,
  redactor: Redactor,
  selectors: string[],
  assertions: string[],
  screenshots: string[],
  nav: NavState,
  isAborted: () => boolean,
  doubleClick = false,
  found: StepFindings = {},
  entries?: RedundantEntryTracker,
  stepIndex = 0,
): Promise<{ statusCode: number; httpStatus?: number }> {
  if ('navigate' in step) {
    const url = absolute(renderTemplate(step.navigate.url, template), job.baseUrl);
    if (!originAllowed(url, job.allowOrigins)) throw new Error('blocked_by_allowlist');
    if (originAllowed(url, job.passiveOrigins ?? [])) throw new Error('blocked_by_allowlist: passive origin');
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    nav.status = response?.status() ?? 0;
    return { statusCode: nav.status };
  }
  if ('click' in step) {
    const clickSelector = renderTemplate(step.click.selector, template);
    selectors.push(clickSelector);
    const target = locate(page, clickSelector);
    // Chaos double-click presses the step's own button twice, as an impatient person does.
    if (doubleClick) await target.dblclick({ timeout: 15_000 });
    else await target.click({ timeout: 15_000 });
    return { statusCode: 0 };
  }
  if ('fill' in step) {
    const fillSelector = renderTemplate(step.fill.selector, template);
    selectors.push(fillSelector);
    await assertFrameFillable(page, step.fill.frame, job);
    if (originAllowed(page.url(), job.passiveOrigins ?? [])) throw new Error('blocked_by_allowlist: passive origin');
    let text = '';
    if (step.fill.value !== undefined) text = renderTemplate(step.fill.value, template);
    if (step.fill.credential) {
      const value = secrets.get(resolveSelf(step.fill.credential, job.label));
      if (!value) throw new Error('missing credential handle');
      text = value;
    }
    if (step.fill.totp) {
      const value = secrets.get(`${resolveSelf(step.fill.totp, job.label)}.totp_code`);
      if (!value) throw new Error('missing totp code');
      text = value;
    }
    const field = locate(page, fillSelector, step.fill.frame);
    if (entries && !step.fill.credential && !step.fill.totp) {
      const before = await field.inputValue({ timeout: 1_000 }).catch(() => '');
      const isPassword = await field.evaluate((element) => element instanceof HTMLInputElement && element.type === 'password', undefined, { timeout: 1_000 }).catch(() => false);
      const repeated = isPassword ? undefined : entries.observe({ step: stepIndex, page: pageKey(page.url()), field: redactor.redact(fillSelector), value: text, before });
      if (repeated) found.redundantEntry = repeated;
    }
    await field.fill(text, { timeout: 15_000 });
    return { statusCode: 0 };
  }
  if ('select' in step) {
    const selectSelector = renderTemplate(step.select.selector, template);
    selectors.push(selectSelector);
    const option =
      step.select.index !== undefined
        ? { index: step.select.index }
        : step.select.value !== undefined
          ? { value: renderTemplate(step.select.value, template) }
          : { label: renderTemplate(step.select.label ?? '', template) };
    // Focus, choose, then leave the field, as a person does. Some forms (Angular's among them)
    // only record the choice once the field has been touched.
    const target = locate(page, selectSelector);
    await target.focus({ timeout: 15_000 });
    await target.selectOption(option, { timeout: 15_000 });
    await target.blur();
    return { statusCode: 0 };
  }
  if ('wait' in step) {
    if (step.wait.for === 'timeout') {
      await interruptible(step.wait.ms ?? 0, isAborted);
      return { statusCode: 0 };
    }
    if (step.wait.for === 'navigation') {
      await waitForNavigationOrSettle(page, nav, isAborted, step.wait.ms ?? 15_000);
      return { statusCode: 0 };
    }
    const waitSelector = step.wait.selector ? renderTemplate(step.wait.selector, template) : '';
    selectors.push(waitSelector);
    await locate(page, waitSelector || 'body').waitFor({ state: step.wait.state ?? 'visible', timeout: step.wait.ms ?? 15_000 });
    return { statusCode: 0 };
  }
  if ('assert' in step) {
    const value = step.assert.value ? renderTemplate(step.assert.value, template) : '';
    assertions.push(`${step.assert.type}${value ? ` ${value}` : ''}`);
    const bodyText = () => page.locator('body').innerText().catch(() => '');
    // Pages that render after the first paint get the same 10 seconds a person would wait.
    if (step.assert.type === 'url_contains' && !(await pollUntil(() => page.url().includes(value), ASSERT_TIMEOUT_MS, isAborted))) {
      throw new Error('url did not match');
    }
    if (step.assert.type === 'text_visible' && !(await pollUntil(async () => (await bodyText()).includes(value), ASSERT_TIMEOUT_MS, isAborted))) {
      throw new Error('text was not visible');
    }
    if (step.assert.type === 'selector_visible') {
      selectors.push(value);
      await locate(page, value).waitFor({ state: 'visible', timeout: ASSERT_TIMEOUT_MS });
    }
    if (step.assert.type === 'selector_absent') {
      selectors.push(value);
      // Let late content arrive first, so a leak that renders after the first paint is still seen.
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
      if ((await locate(page, value).count()) > 0 && (await locate(page, value).first().isVisible().catch(() => false))) {
        throw new Error('selector was still visible');
      }
    }
    if (step.assert.type === 'field_value') {
      const field = renderTemplate(step.assert.selector ?? '', template);
      selectors.push(field);
      assertions[assertions.length - 1] = `field_value ${field} = ${value}`;
      const read = () => locate(page, field).inputValue({ timeout: 2_000 }).catch(() => undefined);
      if (!(await pollUntil(async () => (await read()) === value, ASSERT_TIMEOUT_MS, isAborted))) {
        const actual = await read();
        throw new Error(actual === undefined ? 'field was not found' : `field held "${actual.slice(0, 80)}"`);
      }
    }
    if (step.assert.type === 'http_status') {
      if (String(nav.status) !== value) throw new Error('http status did not match');
      return { statusCode: nav.status, httpStatus: nav.status };
    }
    if (step.assert.type === 'access_denied') {
      const denied = await pollUntil(
        async () => {
          if (nav.status === 401 || nav.status === 403) return true;
          const here = new URL(page.url());
          if (/\/(login|signin|sign-in)(\/|$|\?)/i.test(`${here.pathname}${here.hash.replace(/^#/, '')}`)) return true;
          return deniedByMarker(await bodyText(), job.accessDeniedMarkers);
        },
        5_000,
        isAborted,
      );
      if (!denied) throw new Error('access was not denied');
      return { statusCode: nav.status, httpStatus: nav.status };
    }
    return { statusCode: 0 };
  }
  if ('upload' in step) {
    const uploadSelector = renderTemplate(step.upload.selector, template);
    selectors.push(uploadSelector);
    const file = join(fixturesDir(), step.upload.fixture);
    if (!existsSync(file)) throw new Error(`upload fixture ${step.upload.fixture} is not in the runner image. Add it to images/runner/fixtures and run pnpm image.`);
    await locate(page, uploadSelector).setInputFiles(file);
    return { statusCode: 0 };
  }
  if ('screenshot' in step) {
    await maskSecrets(page, secrets);
    const path = join(job.outDir, `${step.screenshot.name}.png`);
    await page.screenshot({
      path,
      fullPage: Boolean(step.screenshot.full_page),
      mask: [page.locator('input[type="password"], [data-hornet-swarm-secret]')],
    });
    screenshots.push(path);
    // The words beside the picture, and what each form field holds, which a screenshot shows but
    // the page's text leaves out. A later run can say whether either changed.
    saveSealed(join(job.outDir, `${step.screenshot.name}.txt`), await pageSnapshotText(page), redactor);
    return { statusCode: 0 };
  }
  if ('accessibility' in step) {
    const check = step.accessibility;
    const exclude = (check.exclude ?? []).map((selector) => renderTemplate(selector, template));
    assertions.push(`accessibility ${check.name} (${check.standard ?? DEFAULT_ACCESSIBILITY_STANDARD})`);
    const outcome = await runAccessibilityCheck(page, check, exclude, redactor, (fileName, text) => saveSealed(join(job.outDir, fileName), text, redactor));
    found.accessibility = outcome.result;
    if (outcome.failure) throw new Error(outcome.failure);
    return { statusCode: 0 };
  }
  if ('inspect' in step) {
    const name = step.inspect.name;
    assertions.push(`inspect ${name}`);
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
    await maskSecrets(page, secrets);
    const path = join(job.outDir, `inspect-${name}.png`);
    await page.screenshot({ path, fullPage: true, mask: [page.locator('input[type="password"], [data-hornet-swarm-secret]')] });
    screenshots.push(path);
    const map = await inspectPage(page);
    saveSealed(join(job.outDir, `inspect-${name}.json`), JSON.stringify(map, null, 2), redactor);
    return { statusCode: 0 };
  }
  if ('storefront_password' in step) {
    const password = secrets.get(resolveSelf(step.storefront_password.credential, job.label));
    if (!password) throw new Error('missing credential handle');
    if (!sameOrigin(page.url(), job.baseUrl) || originAllowed(page.url(), job.passiveOrigins ?? [])) {
      throw new Error('blocked_by_allowlist: a storefront password is typed only on the project base origin');
    }
    selectors.push('form[action*="/password"] input[type="password"]');
    const field = page.locator('form[action*="/password"] input[type="password"]').first();
    await field.fill(password, { timeout: 15_000 });
    await page.locator('form[action*="/password"] button, form[action*="/password"] input[type="submit"]').first().click({ timeout: 15_000 });
    return { statusCode: 0 };
  }
  if ('inbox' in step) {
    await assertFrameFillable(page, step.inbox.frame, job);
    if (originAllowed(page.url(), job.passiveOrigins ?? [])) throw new Error('blocked_by_allowlist: passive origin');
    const code = readInboxCode(job.inboxDir || process.env.AEGIS_INBOX_DIR || '', step.inbox.mailbox);
    // The controller never sees this code, so only the runner can mask it, and the trace is dropped.
    secrets.set(`${INBOX_CODE_HANDLE}_${stepIndex}`, code);
    redactor.register(INBOX_CODE_HANDLE, code);
    const inboxSelector = renderTemplate(step.inbox.selector, template);
    selectors.push(inboxSelector);
    await locate(page, inboxSelector, step.inbox.frame).fill(code, { timeout: 15_000 });
    return { statusCode: 0 };
  }
  return { statusCode: 0 };
}

export const INBOX_CODE_HANDLE = 'inbox_code';

const CAPTCHA_FRAME = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha/i;

/** A selector can name a captcha frame without saying so, so the frame's own address is checked too. */
async function assertFrameFillable(page: Page, frame: string | undefined, job: JobRequest): Promise<void> {
  if (!frame) return;
  if (CAPTCHA_FRAME.test(frame)) throw new Error('a journey does not fill a captcha frame');
  const element = await page.locator(frame).first().elementHandle({ timeout: 15_000 });
  const url = (await element?.contentFrame())?.url() ?? '';
  if (CAPTCHA_FRAME.test(url)) throw new Error('a journey does not fill a captcha frame');
  if (!originAllowed(url, job.allowOrigins)) throw new Error('blocked_by_allowlist: frame origin');
  if (originAllowed(url, job.passiveOrigins ?? [])) throw new Error('blocked_by_allowlist: passive origin');
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
