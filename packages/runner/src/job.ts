import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { Redactor, renderTemplate, type Step, type StepResult, type TemplateContext } from '@aegis/core';

export type ChaosAction = { step: number; kind: string; detail: string };

export type JobRequest = {
  runId: string;
  label: string;
  journeyId: string;
  baseUrl: string;
  steps: Step[];
  allowOrigins: string[];
  authEndpoints: string[];
  minStepDelayMs: number;
  rps: number;
  accessDeniedMarkers: string[];
  chaosActions: ChaosAction[];
  outDir: string;
  vars: Record<string, string>;
  users: TemplateContext['users'];
};

export type JobReport = {
  ok: boolean;
  status: 'passed' | 'failed' | 'blocked' | 'error' | 'rate_limited';
  blocked_reason?: 'captcha' | '2fa' | 'allowlist' | 'rate_limited' | 'kill' | 'signin_limit';
  steps: Array<
    StepResult & {
      console_logs: string[];
      selectors: string[];
      assertions: string[];
      screenshot_paths: string[];
    }
  >;
  chaosApplied: string[];
  tracePath?: string;
  harPath?: string;
};

type SecretMap = Map<string, string>;

export async function executeJob(job: JobRequest, secrets: SecretMap, isAborted: () => boolean): Promise<JobReport> {
  mkdirSync(job.outDir, { recursive: true });
  const redactor = new Redactor();
  for (const [handle, value] of secrets) redactor.register(handle, value);
  const contextTemplate: TemplateContext = { vars: job.vars, users: job.users };
  const steps: JobReport['steps'] = [];
  const chaosApplied: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context: BrowserContext | undefined;
  let status: JobReport['status'] = 'passed';
  let blocked: JobReport['blocked_reason'];
  const harPath = join(job.outDir, 'network.har');
  const tracePath = join(job.outDir, 'trace.zip');
  let requests = 0;
  let blockedRequests = 0;
  let dropLeft = 0;
  const bucket = createBucket(job.rps);

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    context = await browser.newContext({
      ...(process.env.AEGIS_PROXY ? { proxy: { server: process.env.AEGIS_PROXY } } : {}),
      recordHar: { path: harPath, content: 'embed' },
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (dropLeft > 0) {
        dropLeft -= 1;
        await route.abort('failed');
        return;
      }
      if (!url.startsWith('about:') && !url.startsWith('data:') && !originAllowed(url, job.allowOrigins)) {
        blockedRequests += 1;
        await route.abort('blockedbyclient');
        return;
      }
      requests += 1;
      if (!bucket.take()) {
        blockedRequests += 1;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    const consoleLogs: string[] = [];
    const networkErrors: { method: string; url: string; status: number }[] = [];
    page.on('console', (message) => consoleLogs.push(redactor.redact(message.text())));
    page.on('pageerror', (error) => consoleLogs.push(redactor.redact(error.message)));
    page.on('response', (response) => {
      if (response.status() < 400) return;
      networkErrors.push({
        method: response.request().method(),
        url: redactor.redact(response.url()),
        status: response.status(),
      });
    });
    const nav = { status: 0 };
    const totpReady = [...secrets.keys()].some((handle) => handle.endsWith('.totp_code'));

    for (let index = 0; index < job.steps.length; index += 1) {
      if (isAborted()) {
        status = 'blocked';
        blocked = 'kill';
        break;
      }
      const step = job.steps[index] as Step;
      const kind = Object.keys(step)[0] ?? 'step';
      const started = Date.now();
      const beforeConsole = consoleLogs.length;
      const beforeNetwork = networkErrors.length;
      const selectors: string[] = [];
      const assertions: string[] = [];
      const screenshots: string[] = [];
      try {
        await applyChaos(job.chaosActions.filter((action) => action.step === index), page, context, chaosApplied, (count) => {
          dropLeft += count;
        });
        if (job.minStepDelayMs > 0) await interruptible(job.minStepDelayMs, isAborted);
        const outcome = await runStep(page, step, secrets, job, contextTemplate, redactor, selectors, assertions, screenshots, nav, isAborted);
        const challenge = await detectChallenge(page, totpReady);
        if (challenge) {
          status = 'blocked';
          blocked = challenge;
          steps.push(finishStep(index, kind, 'blocked', started, selectors, assertions, screenshots, consoleLogs.slice(beforeConsole), networkErrors.slice(beforeNetwork), redactor, blocked));
          break;
        }
        steps.push(finishStep(index, kind, 'pass', started, selectors, assertions, screenshots, consoleLogs.slice(beforeConsole), networkErrors.slice(beforeNetwork), redactor, undefined, outcome.httpStatus));
      } catch (error) {
        if (error instanceof AbortJob) {
          status = 'blocked';
          blocked = error.reason;
          steps.push(finishStep(index, kind, 'blocked', started, selectors, assertions, screenshots, consoleLogs.slice(beforeConsole), networkErrors.slice(beforeNetwork), redactor, blocked, undefined, 'stopped'));
          break;
        }
        const message = redactor.redact(error instanceof Error ? error.message : String(error));
        const reason = /allowlist|ERR_BLOCKED_BY_CLIENT|blockedbyclient|ERR_TUNNEL_CONNECTION_FAILED/i.test(message) ? 'allowlist' : undefined;
        if (reason) {
          status = 'blocked';
          blocked = 'allowlist';
        } else if (status === 'passed') status = 'failed';
        steps.push(
          finishStep(
            index,
            kind,
            reason ? 'blocked' : 'fail',
            started,
            selectors,
            assertions,
            screenshots,
            consoleLogs.slice(beforeConsole),
            networkErrors.slice(beforeNetwork),
            redactor,
            reason,
            undefined,
            message,
          ),
        );
        if (reason) break;
        status = 'failed';
        break;
      }
    }
    if (requests >= 10 && blockedRequests / Math.max(1, requests) > 0.1) {
      status = 'rate_limited';
      blocked = 'rate_limited';
    }
    await context.tracing.stop({ path: tracePath });
    await context.close();
    context = undefined;
    writeFileSync(join(job.outDir, 'console.log'), consoleLogs.map((line) => redactor.redact(line)).join('\n'), 'utf8');
  } catch (error) {
    status = status === 'passed' ? 'error' : status;
    const message = redactor.redact(error instanceof Error ? error.message : String(error));
    if (steps.length === 0) {
      steps.push(finishStep(0, 'launch', 'error', Date.now(), [], [], [], [], [], redactor, undefined, undefined, message));
    }
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    for (const [handle] of secrets) secrets.set(handle, '');
    secrets.clear();
  }

  const report: JobReport = {
    ok: status === 'passed',
    status,
    ...(blocked ? { blocked_reason: blocked } : {}),
    steps,
    chaosApplied,
    ...(tracePath ? { tracePath } : {}),
    ...(harPath ? { harPath } : {}),
  };
  return redactor.redactUnknown(report) as JobReport;
}

class AbortJob extends Error {
  constructor(readonly reason: JobReport['blocked_reason'] & string) {
    super('stopped');
  }
}

async function runStep(
  page: Page,
  step: Step,
  secrets: SecretMap,
  job: JobRequest,
  template: TemplateContext,
  redactor: Redactor,
  selectors: string[],
  assertions: string[],
  screenshots: string[],
  nav: { status: number },
  isAborted: () => boolean,
): Promise<{ statusCode: number; httpStatus?: number }> {
  if ('navigate' in step) {
    const url = absolute(renderTemplate(step.navigate.url, template), job.baseUrl);
    if (!originAllowed(url, job.allowOrigins)) throw new Error('blocked_by_allowlist');
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    nav.status = response?.status() ?? 0;
    return { statusCode: nav.status };
  }
  if ('click' in step) {
    selectors.push(step.click.selector);
    const target = locate(page, step.click.selector);
    await target.click({ timeout: 15_000 });
    return { statusCode: 0 };
  }
  if ('fill' in step) {
    selectors.push(step.fill.selector);
    let text = '';
    if (step.fill.value !== undefined) text = renderTemplate(step.fill.value, template);
    if (step.fill.credential) {
      const value = secrets.get(step.fill.credential);
      if (!value) throw new Error('missing credential handle');
      text = value;
    }
    if (step.fill.totp) {
      const value = secrets.get(`${step.fill.totp}.totp_code`);
      if (!value) throw new Error('missing totp code');
      text = value;
    }
    await locate(page, step.fill.selector).fill(text, { timeout: 15_000 });
    text = '';
    return { statusCode: 0 };
  }
  if ('wait' in step) {
    if (step.wait.for === 'timeout') {
      await interruptible(step.wait.ms ?? 0, isAborted);
      return { statusCode: 0 };
    }
    if (step.wait.for === 'navigation') {
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
      return { statusCode: 0 };
    }
    selectors.push(step.wait.selector ?? '');
    await locate(page, step.wait.selector ?? 'body').waitFor({ state: step.wait.state ?? 'visible', timeout: step.wait.ms ?? 15_000 });
    return { statusCode: 0 };
  }
  if ('assert' in step) {
    const value = step.assert.value ? renderTemplate(step.assert.value, template) : '';
    assertions.push(`${step.assert.type}${value ? ` ${value}` : ''}`);
    const body = await page.locator('body').innerText().catch(() => '');
    if (step.assert.type === 'url_contains' && !page.url().includes(value)) throw new Error('url did not match');
    if (step.assert.type === 'text_visible' && !body.includes(value)) throw new Error('text was not visible');
    if (step.assert.type === 'selector_visible') {
      selectors.push(value);
      await locate(page, value).waitFor({ state: 'visible', timeout: 10_000 });
    }
    if (step.assert.type === 'selector_absent') {
      selectors.push(value);
      if ((await locate(page, value).count()) > 0 && (await locate(page, value).first().isVisible().catch(() => false))) {
        throw new Error('selector was still visible');
      }
    }
    if (step.assert.type === 'http_status') {
      if (String(nav.status) !== value) throw new Error('http status did not match');
      return { statusCode: nav.status, httpStatus: nav.status };
    }
    if (step.assert.type === 'access_denied') {
      const statusCode = nav.status;
      const denied =
        statusCode === 401 ||
        statusCode === 403 ||
        page.url().includes('/login') ||
        job.accessDeniedMarkers.some((marker) => body.toLowerCase().includes(marker.toLowerCase()));
      if (!denied) throw new Error('access was not denied');
      return { statusCode, httpStatus: statusCode };
    }
    return { statusCode: 0 };
  }
  if ('upload' in step) {
    selectors.push(step.upload.selector);
    const file = join('/opt/runner/fixtures', step.upload.fixture);
    await locate(page, step.upload.selector).setInputFiles(file);
    return { statusCode: 0 };
  }
  if ('screenshot' in step) {
    await maskSecrets(page, secrets);
    const path = join(job.outDir, `${step.screenshot.name}.png`);
    await page.screenshot({
      path,
      fullPage: Boolean(step.screenshot.full_page),
      mask: [page.locator('input[type="password"], [data-aegis-secret]')],
    });
    screenshots.push(path);
    return { statusCode: 0 };
  }
  return { statusCode: 0 };
}

function finishStep(
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
    console_logs: consoleLogs.map((line) => redactor.redact(line)),
    selectors: selectors.map((selector) => redactor.redact(selector)),
    assertions: assertions.map((assertion) => redactor.redact(assertion)),
    screenshot_paths: screenshots,
  };
}

async function detectChallenge(page: Page, totpReady: boolean): Promise<'captcha' | '2fa' | undefined> {
  const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  const html = (await page.content().catch(() => '')).toLowerCase();
  if (text.includes('verify you are human') || /recaptcha|hcaptcha|turnstile|arkose/.test(html)) return 'captcha';
  if (totpReady) return undefined;
  const otp = await page.locator('input[autocomplete="one-time-code"]').count();
  if (otp > 0) return '2fa';
  return undefined;
}

async function applyChaos(
  actions: ChaosAction[],
  page: Page,
  context: BrowserContext,
  applied: string[],
  drop: (count: number) => void,
): Promise<void> {
  for (const action of actions) {
    applied.push(`${action.kind}:${action.detail}`);
    if (action.kind === 'latency' || action.kind === 'slow-api') await page.waitForTimeout(parseMs(action.detail));
    if (action.kind === 'refresh') await page.reload({ timeout: 10_000 }).catch(() => undefined);
    if (action.kind === 'back') await page.goBack({ timeout: 10_000 }).catch(() => undefined);
    if (action.kind === 'offline') await context.setOffline(true);
    if (action.kind === 'drop' || action.kind === 'fail-api') drop(action.detail === 'twice' ? 2 : 1);
    if (action.kind === 'double-click') applied.push('double-click:armed');
  }
}

async function maskSecrets(page: Page, secrets: SecretMap): Promise<void> {
  const values = [...secrets.values()].filter((value) => value.length >= 4);
  if (values.length === 0) return;
  await page.evaluate((secretsOnPage) => {
    for (const node of document.querySelectorAll('input, textarea, body *')) {
      const field = node as HTMLInputElement;
      const text = typeof field.value === 'string' && field.value ? field.value : node.textContent ?? '';
      if (secretsOnPage.some((secret) => text.includes(secret))) node.setAttribute('data-aegis-secret', '1');
    }
  }, values);
}

function locate(page: Page, selector: string): Locator {
  const role = /^role=([a-z]+)\[name='([^']+)'\]$/i.exec(selector);
  if (role?.[1] && role[2]) return page.getByRole(role[1] as 'button', { name: role[2], exact: true });
  return page.locator(selector);
}

function absolute(url: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return new URL(url, base.endsWith('/') ? base : `${base}/`).toString();
}

function originAllowed(url: string, allow: string[]): boolean {
  try {
    return allow.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function parseMs(detail: string): number {
  const match = /(\d+)/.exec(detail);
  return match ? Number(match[1]) : 300;
}

function createBucket(rps: number): { take: () => boolean } {
  let tokens = Math.max(1, rps);
  let updated = Date.now();
  return {
    take() {
      const now = Date.now();
      tokens = Math.min(rps, tokens + ((now - updated) / 1000) * rps);
      updated = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

async function interruptible(ms: number, isAborted: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isAborted()) throw new AbortJob('kill');
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, end - Date.now())));
  }
}
