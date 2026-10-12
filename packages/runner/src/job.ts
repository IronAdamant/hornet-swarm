import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { browserLaunchOptions } from './launch.js';
import { Redactor, renderTemplate, runnerOverload, type Step, type StepResult, type TemplateContext } from '@hornet-swarm/core';

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
  /** Requests allowed at once before pacing starts. Defaults to rps. */
  burst?: number;
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
  let httpOverloads = 0;
  let dropLeft = 0;
  let closing = false;
  const bucket = createBucket(job.rps, job.burst ?? job.rps);
  const stopWaiting = () => closing || isAborted();

  try {
    browser = await chromium.launch(browserLaunchOptions());
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
      try {
        await applyChaos(job.chaosActions.filter((action) => action.step === index), page, context, chaosApplied, (count) => {
          dropLeft += count;
        });
        if (job.minStepDelayMs > 0) await interruptible(job.minStepDelayMs, isAborted);
        if (!('wait' in step) && !('assert' in step) && !('screenshot' in step)) nav.mark = nav.count;
        const outcome = await runStep(page, step, secrets, job, contextTemplate, redactor, selectors, assertions, screenshots, nav, isAborted);
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
        steps.push(finishStep(index, kind, 'pass', started, selectors, assertions, screenshots, consoleLogs.slice(beforeConsole), networkErrors.slice(beforeNetwork), redactor, undefined, outcome.httpStatus));
      } catch (error) {
        if (error instanceof AbortJob) {
          status = 'blocked';
          blocked = error.reason;
          steps.push(finishStep(index, kind, 'blocked', started, selectors, assertions, screenshots, consoleLogs.slice(beforeConsole), networkErrors.slice(beforeNetwork), redactor, blocked, undefined, 'stopped'));
          break;
        }
        const message = redactor.redact(error instanceof Error ? error.message : String(error));
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
    writeFileSync(join(job.outDir, 'console.log'), consoleLogs.map((line) => redactor.redact(line)).join('\n'), 'utf8');
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
    if (existsSync(harPath)) writeFileSync(harPath, redactor.redact(readFileSync(harPath, 'utf8')));
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
    selectors.push(step.wait.selector ?? '');
    await locate(page, step.wait.selector ?? 'body').waitFor({ state: step.wait.state ?? 'visible', timeout: step.wait.ms ?? 15_000 });
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
      mask: [page.locator('input[type="password"], [data-hornet-swarm-secret]')],
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
    if (action.kind === 'double-click') {
      await page.locator('body').dblclick({ timeout: 5_000, position: { x: 4, y: 4 } }).catch(() => undefined);
      applied.push('click');
      applied.push('click');
    }
  }
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
