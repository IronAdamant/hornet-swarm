import { existsSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Locator, type Page, type Request } from 'playwright';
import { browserLaunchOptions } from './launch.js';
import {
  DEFAULT_ACCESSIBILITY_STANDARD,
  PAGE_MAP_LIMITS,
  Redactor,
  accessibilityTags,
  atLeast,
  chosenDir,
  fixedText,
  renderTemplate,
  resolveSelf,
  runnerOverload,
  sortViolations,
  type AccessibilityImpact,
  type AccessibilityResult,
  type PageMap,
  type Step,
  type StepResult,
  type TemplateContext,
  UnredactableError,
  writeRedactedFile,
} from '@hornet-swarm/core';

export type ChaosAction = { step: number; kind: string; detail: string };

export type JobRequest = {
  runId: string;
  label: string;
  journeyId: string;
  baseUrl: string;
  steps: Step[];
  allowOrigins: string[];
  /** Origins that may load into a page but that the page may never navigate to or be typed into. */
  passiveOrigins?: string[];
  authEndpoints: string[];
  minStepDelayMs: number;
  rps: number;
  /** Requests allowed at once before pacing starts. Defaults to rps. */
  burst?: number;
  /** False makes the browser use HTTP/1.1. */
  http2?: boolean;
  accessDeniedMarkers: string[];
  chaosActions: ChaosAction[];
  outDir: string;
  vars: Record<string, string>;
  users: TemplateContext['users'];
  deadline?: number;
  operatorPollUrl?: string;
  /** The longest the run waits for the owner to type a texted or emailed code. */
  operatorWaitMs?: number;
};

export type OperatorSettlement = { action: 'continue'; code: string } | { action: 'block'; reason: '2fa' } | { action: 'abort'; reason: 'kill' };

export function settleOperatorAnswer(answer: 'code' | 'declined' | 'touchid' | 'timeout' | 'kill', code?: string): OperatorSettlement {
  if (answer === 'kill') return { action: 'abort', reason: 'kill' };
  if (answer === 'code' && code) return { action: 'continue', code };
  return { action: 'block', reason: '2fa' };
}

export function stageOperatorCode(redactor: Redactor, secrets: SecretMap, code: string): string {
  const handle = 'operator_code';
  secrets.set(handle, code);
  redactor.register(handle, code);
  return handle;
}

export async function resolveChallenge(input: {
  challenge: 'captcha' | '2fa' | undefined;
  fillsTotp: boolean;
  redactor: Redactor;
  secrets: SecretMap;
  ask: () => Promise<OperatorSettlement>;
}): Promise<{ kind: 'continue' } | { kind: 'stop'; reason: 'captcha' | '2fa' | 'kill' }> {
  if (input.challenge === 'captcha') return { kind: 'stop', reason: 'captcha' };
  if (input.challenge !== '2fa' || input.fillsTotp) return { kind: 'continue' };
  const settlement = await input.ask();
  if (settlement.action === 'abort') return { kind: 'stop', reason: 'kill' };
  if (settlement.action !== 'continue') return { kind: 'stop', reason: '2fa' };
  stageOperatorCode(input.redactor, input.secrets, settlement.code);
  return { kind: 'continue' };
}

export async function pollOperatorGate(pollUrl: string, deadline: number, isAborted: () => boolean): Promise<OperatorSettlement> {
  if (isAborted()) return { action: 'abort', reason: 'kill' };
  await gateRequest(pollUrl, 'POST').catch(() => undefined);
  while (Date.now() < deadline - 750) {
    if (isAborted()) return { action: 'abort', reason: 'kill' };
    try {
      const response = await gateRequest(pollUrl, 'GET');
      if (response.ok) {
        const body = (await response.json()) as { status?: string; code?: string };
        if (body.status === 'declined' || body.status === 'touchid') return { action: 'block', reason: '2fa' };
        if (body.status === 'ready' && body.code) return settleOperatorAnswer('code', body.code);
      }
    } catch {
      // The page can be down. The wait still ends at the deadline.
    }
    await delay(200);
  }
  if (isAborted()) return { action: 'abort', reason: 'kill' };
  return { action: 'block', reason: '2fa' };
}

// The runner sits on an internal network and cannot resolve host.docker.internal.
// Global fetch ignores AEGIS_PROXY, so the poll is an absolute-form request through that proxy.
// With no proxy set, the same call uses fetch so a page on 127.0.0.1 still answers.
async function gateRequest(pollUrl: string, method: 'GET' | 'POST'): Promise<{ ok: boolean; json: () => Promise<unknown> }> {
  const proxy = process.env.AEGIS_PROXY;
  if (!proxy) return fetch(pollUrl, method === 'POST' ? { method } : undefined);
  const proxyUrl = new URL(proxy);
  const target = new URL(pollUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method,
        path: pollUrl,
        headers: { host: target.host, accept: 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            json: async () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** The wait ends at the run deadline or the operator wait limit, whichever comes first. With no code page, nobody can answer, so the journey stops at once. */
export function operatorDeadline(job: Pick<JobRequest, 'deadline' | 'operatorWaitMs'>, now = Date.now()): number {
  const cap = now + (job.operatorWaitMs ?? 600_000);
  return Math.min(job.deadline ?? cap, cap);
}

async function askOperator(job: JobRequest, isAborted: () => boolean): Promise<OperatorSettlement> {
  if (isAborted()) return { action: 'abort', reason: 'kill' };
  if (!job.operatorPollUrl) return { action: 'block', reason: '2fa' };
  return pollOperatorGate(job.operatorPollUrl, operatorDeadline(job), isAborted);
}

const CODE_FIELDS = [
  'input[autocomplete="one-time-code"]:visible',
  'input[name*="otp" i]:visible:not([type="password"])',
  'input[name*="code" i]:visible:not([type="password"])',
  'input[id*="code" i]:visible:not([type="password"])',
  'input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])',
];

async function fillVisibleCode(page: Page, code: string): Promise<void> {
  for (const selector of CODE_FIELDS) {
    const field = page.locator(selector).first();
    if ((await field.count()) === 0) continue;
    await field.fill(code, { timeout: 15_000 });
    return;
  }
  throw new Error('no visible code field');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type JobReport = {
  ok: boolean;
  status: 'passed' | 'failed' | 'blocked' | 'error' | 'rate_limited';
  blocked_reason?: 'captcha' | '2fa' | 'allowlist' | 'proxy' | 'rate_limited' | 'kill' | 'signin_limit' | 'duration' | 'totp_missing';
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
  chosenDir(job.outDir);
  const redactor = new Redactor();
  for (const [handle, value] of secrets) redactor.register(handle, value);
  const contextTemplate: TemplateContext = { vars: job.vars, users: job.users, run: { id: job.runId, label: job.label } };
  const steps: JobReport['steps'] = [];
  const chaosApplied: string[] = [];
  let formInProgress = false;
  // A page that a sent form produced. Reloading it sends the form again, which a browser only does
  // after asking, so chaos does not refresh it.
  let formSent = false;
  let lastPageLoadMethod = 'GET';
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context: BrowserContext | undefined;
  let status: JobReport['status'] = 'passed';
  let blocked: JobReport['blocked_reason'];
  const harPath = join(job.outDir, 'network.har');
  const tracePath = join(job.outDir, 'trace.zip');
  let requests = 0;
  let httpOverloads = 0;
  let dropLeft = 0;
  let closing = false;
  /** Set when the page tried to move to a passive origin. The journey stops there, with that reason. */
  let passiveNavigation: string | undefined;
  const bucket = createBucket(job.rps, job.burst ?? job.rps);
  const stopWaiting = () => closing || isAborted();

  try {
    browser = await chromium.launch(browserLaunchOptions({ ...(job.http2 === false ? { http2: false } : {}) }));
    context = await browser.newContext({
      ...(process.env.AEGIS_PROXY ? { proxy: { server: process.env.AEGIS_PROXY } } : {}),
      recordHar: { path: harPath, content: 'embed' },
      // A service worker's own requests skip context.route, so they would skip the allowlist and the pacing below.
      serviceWorkers: 'block',
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (dropLeft > 0) {
        // A lost page load leaves only the browser's own error page, which no site can recover
        // from, so chaos drops the requests a page makes, never the page itself.
        if (mainFrameNavigation(route.request())) {
          chaosApplied.push('drop:spared the page load');
        } else {
          dropLeft -= 1;
          await route.abort('failed');
          return;
        }
      }
      if (!url.startsWith('about:') && !url.startsWith('data:') && !originAllowed(url, job.allowOrigins)) {
        await route.abort('blockedbyclient');
        return;
      }
      // A passive origin may load into the page, but the page itself never moves there, by a step, a link, or a script.
      if (mainFrameNavigation(route.request()) && originAllowed(url, job.passiveOrigins ?? [])) {
        passiveNavigation = new URL(url).origin;
        await route.abort('blockedbyclient');
        return;
      }
      requests += 1;
      // The per-runner limit paces requests. It never drops one, so a busy page loads
      // slowly instead of loading broken, and the site is not blamed for the harness.
      if (!(await bucket.wait(stopWaiting))) {
        await route.abort('aborted').catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });
    const page = await context.newPage();
    const consoleLogs: string[] = [];
    const networkErrors: { method: string; url: string; status: number }[] = [];
    page.on('console', (message) => consoleLogs.push(redactor.redact(message.text())));
    page.on('pageerror', (error) => consoleLogs.push(redactor.redact(error.message)));
    const nav = { status: 0, count: 0, mark: 0, inflight: 0, lastActivity: Date.now() };
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) nav.count += 1;
    });
    page.on('request', (request) => {
      if (mainFrameNavigation(request)) lastPageLoadMethod = request.method();
    });
    page.on('request', () => {
      nav.inflight += 1;
      nav.lastActivity = Date.now();
    });
    const settled = () => {
      nav.inflight = Math.max(0, nav.inflight - 1);
      nav.lastActivity = Date.now();
    };
    page.on('requestfinished', settled);
    page.on('requestfailed', settled);
    page.on('response', (response) => {
      const request = response.request();
      // A click that navigates updates the page status too, not only a navigate step.
      if (request.isNavigationRequest() && response.frame() === page.mainFrame()) nav.status = response.status();
      // The harness's own proxy marks its refusals. Only the site's 429 and 503 count against the site.
      const fromHarness = Boolean(response.headers()['x-hornet-swarm']);
      if (!fromHarness && (response.status() === 429 || response.status() === 503)) httpOverloads += 1;
      if (response.status() < 400) return;
      networkErrors.push({
        method: response.request().method(),
        url: redactor.redact(response.url()),
        status: response.status(),
      });
    });
    const fillsTotp = journeyFillsTotp(job.steps);

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
      const found: StepFindings = {};
      try {
        const chaosEffect = await applyChaos(
          job.chaosActions.filter((action) => action.step === index),
          page,
          context,
          chaosApplied,
          (count) => {
            dropLeft += count;
          },
          { formInProgress, formSent, clickStep: 'click' in step },
        );
        const navBefore = nav.count;
        if (job.minStepDelayMs > 0) await interruptible(job.minStepDelayMs, isAborted);
        if (!('wait' in step) && !('assert' in step) && !('screenshot' in step) && !('accessibility' in step) && !('inspect' in step)) nav.mark = nav.count;
        const outcome = await runStep(page, step, secrets, job, contextTemplate, redactor, selectors, assertions, screenshots, nav, isAborted, chaosEffect.doubleClick, found);
        // Typed-in values stay on the page until it navigates away. Chaos must not refresh them away.
        if ('fill' in step || 'select' in step) formInProgress = true;
        if ('navigate' in step || nav.count !== navBefore) formInProgress = false;
        if (nav.count !== navBefore) formSent = lastPageLoadMethod === 'POST';
        if (passiveNavigation) throw new Error(`blocked_by_allowlist: the page tried to open the passive origin ${passiveNavigation}`);
        const challenge = await detectChallenge(page);
        const decision = await resolveChallenge({
          challenge,
          fillsTotp,
          redactor,
          secrets,
          ask: () => askOperator(job, isAborted),
        });
        if (decision.kind === 'stop') {
          status = 'blocked';
          blocked = decision.reason;
          steps.push(finishStep(index, kind, 'blocked', started, selectors, assertions, screenshots, consoleLogs.slice(beforeConsole), networkErrors.slice(beforeNetwork), redactor, blocked));
          break;
        }
        if (challenge === '2fa' && !fillsTotp) {
          const code = secrets.get('operator_code') ?? '';
          await fillVisibleCode(page, code);
        }
        steps.push(finishStep(index, kind, 'pass', started, selectors, assertions, screenshots, consoleLogs.slice(beforeConsole), networkErrors.slice(beforeNetwork), redactor, undefined, outcome.httpStatus, undefined, found.accessibility));
      } catch (error) {
        if (error instanceof AbortJob) {
          status = 'blocked';
          blocked = error.reason;
          steps.push(finishStep(index, kind, 'blocked', started, selectors, assertions, screenshots, consoleLogs.slice(beforeConsole), networkErrors.slice(beforeNetwork), redactor, blocked, undefined, 'stopped'));
          break;
        }
        const raw = error instanceof Error ? error.message : String(error);
        // The page's own words tell an agent why, such as an account the site refused, so the
        // error quotes them instead of leaving the agent to read a screenshot.
        const clues = await failureClues(page, step, contextTemplate);
        const message = redactor.redact(clues.length > 0 ? raw.replace(/^([^\n]*)/, `$1 (${clues.join('; ')})`) : raw);
        // A picture and the page's words at the moment it failed, for every failed step.
        await captureFailure(page, job, index, secrets, redactor, screenshots);
        const reason = classifyBlockedReason(message);
        if (reason) {
          status = 'blocked';
          blocked = reason;
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
            found.accessibility,
          ),
        );
        if (reason) break;
        status = 'failed';
        break;
      }
    }
    if (status === 'passed' && runnerOverload(requests, 0, httpOverloads)) {
      status = 'rate_limited';
      blocked = 'rate_limited';
    }
    closing = true;
    await context.tracing.stop({ path: tracePath });
    await context.close();
    context = undefined;
    saveSealed(join(job.outDir, 'console.log'), consoleLogs.join('\n'), redactor);
  } catch (error) {
    status = status === 'passed' ? 'error' : status;
    const message = redactor.redact(error instanceof Error ? error.message : String(error));
    if (steps.length === 0) {
      steps.push(finishStep(0, 'launch', 'error', Date.now(), [], [], [], [], [], redactor, undefined, undefined, message));
    }
  } finally {
    closing = true;
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (existsSync(harPath)) saveSealed(harPath, readFileSync(harPath, 'utf8'), redactor);
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
  nav: NavState,
  isAborted: () => boolean,
  doubleClick = false,
  found: StepFindings = {},
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
    await locate(page, fillSelector).fill(text, { timeout: 15_000 });
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
    const standard = check.standard ?? DEFAULT_ACCESSIBILITY_STANDARD;
    const exclude = (check.exclude ?? []).map((selector) => renderTemplate(selector, template));
    assertions.push(`accessibility ${check.name} (${standard})`);
    const raw = await checkAccessibility(page, accessibilityTags(standard), exclude);
    // The full findings, with each element's markup, go beside the screenshots. The markup can
    // hold what a customer typed, so it is masked like every other saved file.
    saveSealed(join(job.outDir, `accessibility-${check.name}.json`), JSON.stringify({ name: check.name, standard, ...raw }, null, 2), redactor);
    const result: AccessibilityResult = {
      name: check.name,
      url: redactor.redact(raw.url),
      standard,
      violations: sortViolations(
        raw.violations.map((violation) => ({
          rule: violation.id,
          impact: violation.impact,
          help: violation.help,
          count: violation.count,
          example: redactor.redact(violation.nodes[0]?.target ?? ''),
        })),
      ),
      needs_review: raw.incomplete,
    };
    found.accessibility = result;
    const failOn = check.fail_on;
    const serious = failOn ? result.violations.filter((violation) => atLeast(violation.impact, failOn)) : [];
    if (serious.length > 0) {
      throw new Error(`accessibility: ${serious.length} ${serious.length === 1 ? 'problem' : 'problems'} at or above ${failOn} (${serious.map((violation) => `${violation.rule}: ${violation.help}`).slice(0, 3).join('; ')})`);
    }
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
  return { statusCode: 0 };
}

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
type StepFindings = { accessibility?: AccessibilityResult };

type AxeFinding = {
  id: string;
  impact: AccessibilityImpact;
  help: string;
  helpUrl: string;
  /** Every element with the problem. `nodes` keeps the first 20. */
  count: number;
  nodes: { target: string; html: string; summary: string }[];
};

let axeSource: string | undefined;

/** axe-core from the runner's own files. The page never loads it from the network. */
function axeScript(): string {
  axeSource ??= readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
  return axeSource;
}

export async function checkAccessibility(page: Page, tags: string[], exclude: string[]): Promise<{ url: string; violations: AxeFinding[]; incomplete: number }> {
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
  await page.evaluate(axeScript());
  return page.evaluate(
    async ({ tags, exclude }) => {
      type AxeNode = { target: unknown[]; html: string; failureSummary?: string };
      type AxeRule = { id: string; impact?: string | null; help: string; helpUrl: string; nodes: AxeNode[] };
      const axe = (globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: AxeRule[]; incomplete: AxeRule[] }> } }).axe;
      const context = exclude.length > 0 ? { exclude: exclude.map((selector) => [selector]) } : document;
      const results = await axe.run(context, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] });
      return {
        url: location.href,
        incomplete: results.incomplete.length,
        violations: results.violations.map((rule) => ({
          id: rule.id,
          impact: (rule.impact ?? 'minor') as AccessibilityImpact,
          help: rule.help,
          helpUrl: rule.helpUrl,
          count: rule.nodes.length,
          nodes: rule.nodes.slice(0, 20).map((node) => ({
            target: node.target.map(String).join(' '),
            html: node.html.slice(0, 300),
            summary: (node.failureSummary ?? '').slice(0, 500),
          })),
        })),
      };
    },
    { tags, exclude },
  );
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
  accessibility?: AccessibilityResult,
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
    ...(accessibility ? { accessibility } : {}),
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
function saveSealed(path: string, text: string, redactor: Redactor): void {
  try {
    writeRedactedFile(path, redactor.seal(text), { parent: 'chosen' });
  } catch (error) {
    if (!(error instanceof UnredactableError)) throw error;
    rmSync(path, { force: true });
    writeRedactedFile(`${path}.withheld`, fixedText('withheld because masking could not remove a secret\n'), { parent: 'chosen' });
  }
}

async function captureFailure(page: Page, job: JobRequest, index: number, secrets: SecretMap, redactor: Redactor, screenshots: string[]): Promise<void> {
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

function journeyFillsTotp(steps: Step[]): boolean {
  return steps.some((step) => 'fill' in step && Boolean(step.fill.totp));
}

export function classifyBlockedReason(message: string): 'allowlist' | 'proxy' | undefined {
  if (/ERR_PROXY_CONNECTION_FAILED/i.test(message) || (/proxy/i.test(message) && /\b502\b/.test(message))) return 'proxy';
  if (/allowlist|ERR_BLOCKED_BY_CLIENT|blockedbyclient|ERR_TUNNEL_CONNECTION_FAILED/i.test(message)) return 'allowlist';
  return undefined;
}

export type ChallengeFrame = { src?: string; title?: string; width: number; height: number; visible: boolean; badge?: boolean };
export type ChallengeWidget = { width: number; height: number; visible: boolean; size?: string };
export type ChallengeInput = {
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  maxlength?: string;
  inputmode?: string;
  label?: string;
};

const CAPTCHA_PROVIDER = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i;
const CODE_TOKEN = /^(otp|totp|mfa|2fa|passcode|onetime)$/;
const CODE_PHRASE = /one[\s_-]?time[\s_-]?(code|pass(word|code)?)|verification[\s_-]?code|security[\s_-]?code|auth(entication|enticator)?[\s_-]?code|login[\s_-]?code|sign[\s_-]?in[\s_-]?code/;
const NOT_A_SECOND_CODE = /^(post|zip|promo|coupon|discount|referral|gift|voucher|country|area|postal)$/;
const CODE_SENT =
  /(texted|emailed|sent|messaged) you (a|an|the|your) ([\w-]+ )?code|code (was|has been) (texted|emailed|sent)|enter the (\d+[\s-]digit )?code (we|that was) (sent|texted|emailed)|we('ve| have) sent (a|an|the) ([\w-]+ )?code/;

function words(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Only a challenge a person can see stops the journey. Invisible reCAPTCHA v3, the reCAPTCHA
 * badge, and a Turnstile or hCaptcha script that never shows a widget are ignored. A second-code
 * prompt needs a one-time-code field, a field named for a code, or wording that a code was sent.
 */
export function classifyChallenge(input: {
  text: string;
  frames?: ChallengeFrame[];
  widgets?: ChallengeWidget[];
  inputs: ChallengeInput[];
}): 'captcha' | '2fa' | undefined {
  const text = input.text.toLowerCase();
  if (text.includes('verify you are human')) return 'captcha';
  const shown = (box: { width: number; height: number; visible: boolean }) => box.visible && box.width >= 100 && box.height >= 50;
  const captchaFrame = (input.frames ?? []).some(
    (frame) => shown(frame) && !frame.badge && !/size=invisible/i.test(frame.src ?? '') && CAPTCHA_PROVIDER.test(`${frame.src ?? ''} ${frame.title ?? ''}`),
  );
  const captchaWidget = (input.widgets ?? []).some((widget) => shown(widget) && widget.size !== 'invisible');
  if (captchaFrame || captchaWidget) return 'captcha';
  const isPassword = (field: ChallengeInput) => (field.type ?? '').toLowerCase() === 'password' || words(`${field.name ?? ''} ${field.id ?? ''} ${field.autocomplete ?? ''}`).includes('password');
  const other = input.inputs.filter((field) => !isPassword(field));
  const codeSent = CODE_SENT.test(text);
  const oneTime = other.some((field) => {
    if ((field.autocomplete ?? '').toLowerCase().includes('one-time-code')) return true;
    const described = `${field.name ?? ''} ${field.id ?? ''} ${field.placeholder ?? ''} ${field.label ?? ''}`;
    const tokens = words(described);
    if (tokens.some((token) => NOT_A_SECOND_CODE.test(token))) return false;
    if (tokens.some((token) => CODE_TOKEN.test(token)) || CODE_PHRASE.test(described.toLowerCase())) return true;
    return field.maxlength === '6' && tokens.includes('code');
  });
  if ((codeSent && other.length > 0) || oneTime) return '2fa';
  return undefined;
}

async function detectChallenge(page: Page): Promise<'captcha' | '2fa' | undefined> {
  const text = await page.locator('body').innerText().catch(() => '');
  // Each callback runs inside the page. It is written out in full rather than built with
  // new Function, which a strict Content-Security-Policy would block.
  const frames = await page
    .locator('iframe')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          src: element.getAttribute('src') ?? '',
          title: element.getAttribute('title') ?? '',
          badge: Boolean(element.closest('.grecaptcha-badge')),
          width: rect.width,
          height: rect.height,
          visible:
            style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0,
        };
      }),
    )
    .catch(() => [] as ChallengeFrame[]);
  const widgets = await page
    .locator('.g-recaptcha, .h-captcha, .cf-turnstile, #FunCaptcha, [data-hcaptcha-widget-id]')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          size: element.getAttribute('data-size') ?? '',
          width: rect.width,
          height: rect.height,
          visible:
            style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0,
        };
      }),
    )
    .catch(() => [] as ChallengeWidget[]);
  const inputs = await page
    .locator('input:visible')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        type: element.getAttribute('type') ?? '',
        name: element.getAttribute('name') ?? '',
        id: element.getAttribute('id') ?? '',
        autocomplete: element.getAttribute('autocomplete') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
        maxlength: element.getAttribute('maxlength') ?? '',
        inputmode: element.getAttribute('inputmode') ?? '',
        label: element.getAttribute('aria-label') ?? (element as HTMLInputElement).labels?.[0]?.textContent ?? '',
      })),
    )
    .catch(() => [] as ChallengeInput[]);
  return classifyChallenge({ text, frames, widgets, inputs });
}

/**
 * Applies this step's chaos. A refresh or back is skipped while a form is half filled in, because
 * a person who reloads mid-form types it again; wiping the form would test the robot, not the site.
 * It is also skipped on a page that a sent form produced, because reloading it sends the form again,
 * which a browser does only after asking.
 * A double-click lands on the step's own button, so only a click step can take one.
 */
export async function applyChaos(
  actions: ChaosAction[],
  page: Page,
  context: BrowserContext,
  applied: string[],
  drop: (count: number) => void,
  state: { formInProgress: boolean; formSent?: boolean; clickStep: boolean } = { formInProgress: false, clickStep: false },
): Promise<{ doubleClick: boolean }> {
  let doubleClick = false;
  for (const action of actions) {
    if ((action.kind === 'refresh' || action.kind === 'back') && state.formInProgress) {
      applied.push(`${action.kind}:skipped (form in progress)`);
      continue;
    }
    if ((action.kind === 'refresh' || action.kind === 'back') && state.formSent) {
      applied.push(`${action.kind}:skipped (the page came from a sent form)`);
      continue;
    }
    if (action.kind === 'double-click' && !state.clickStep) {
      applied.push('double-click:skipped (not a click step)');
      continue;
    }
    applied.push(`${action.kind}:${action.detail}`);
    if (action.kind === 'latency' || action.kind === 'slow-api') await page.waitForTimeout(parseMs(action.detail));
    if (action.kind === 'refresh') await page.reload({ timeout: 10_000 }).catch(() => undefined);
    if (action.kind === 'back') await page.goBack({ timeout: 10_000 }).catch(() => undefined);
    if (action.kind === 'offline') await context.setOffline(true);
    if (action.kind === 'drop' || action.kind === 'fail-api') drop(action.detail === 'twice' ? 2 : 1);
    if (action.kind === 'double-click') doubleClick = true;
  }
  return { doubleClick };
}

async function maskSecrets(page: Page, secrets: SecretMap): Promise<void> {
  const values = [...secrets.values()].filter((value) => value.length >= 1);
  if (values.length === 0) return;
  await page.evaluate((secretsOnPage) => {
    for (const node of document.querySelectorAll('input, textarea, body *')) {
      const field = node as HTMLInputElement;
      const text = typeof field.value === 'string' && field.value ? field.value : node.textContent ?? '';
      if (secretsOnPage.some((secret) => text.includes(secret))) node.setAttribute('data-hornet-swarm-secret', '1');
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

function mainFrameNavigation(request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    // A request with no frame, such as one from a worker, is not a page navigation.
    return false;
  }
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

type NavState = { status: number; count: number; mark: number; inflight: number; lastActivity: number };

const ASSERT_TIMEOUT_MS = 10_000;
const fixturesDir = (): string => process.env.AEGIS_FIXTURES_DIR ?? '/opt/runner/fixtures';

export function createBucket(rps: number, burst = rps): { take: () => boolean; wait: (stop: () => boolean) => Promise<boolean> } {
  const capacity = Math.max(1, burst);
  let tokens = capacity;
  let updated = Date.now();
  const refill = () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - updated) / 1000) * rps);
    updated = now;
  };
  const take = () => {
    refill();
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
  return {
    take,
    async wait(stop) {
      for (;;) {
        if (take()) return true;
        if (stop()) return false;
        await delay(Math.max(10, Math.ceil(((1 - tokens) / Math.max(rps, 0.001)) * 1000)));
      }
    },
  };
}

async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, isAborted: () => boolean): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    if (isAborted()) throw new AbortJob('kill');
    await delay(150);
  }
}

/**
 * Waits for the main frame to navigate after the last action, including a single-page app
 * route change, then for that page's DOM. A login that renders in place without changing the
 * URL never navigates, so the wait also ends once the network has been quiet for half a second.
 * The assertions that follow decide whether the page is right.
 */
async function waitForNavigationOrSettle(page: Page, nav: NavState, isAborted: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  await pollUntil(
    () => nav.count > nav.mark || (Date.now() - started > 300 && nav.inflight === 0 && Date.now() - nav.lastActivity > 500),
    timeoutMs,
    isAborted,
  );
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
}

export function deniedByMarker(body: string, markers: string[]): boolean {
  const lower = body.toLowerCase();
  return markers.some((marker) => {
    const escaped = marker.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(lower);
  });
}

async function interruptible(ms: number, isAborted: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isAborted()) throw new AbortJob('kill');
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, end - Date.now())));
  }
}
