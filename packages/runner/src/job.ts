import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { Redactor, chosenDir, runnerOverload, type Step, type TemplateContext } from '@hornet-swarm/core';
import { browserLaunchOptions } from './launch.js';
import { RedundantEntryTracker } from './redundant-entry-tracker.js';
import { detectChallenge, journeyFillsTotp, classifyBlockedReason } from './job-challenge.js';
import { applyChaos, createBucket, interruptible, mainFrameNavigation, originAllowed } from './job-net.js';
import { askOperator, fillVisibleCode, resolveChallenge } from './job-operator.js';
import { captureFailure, failureClues, finishStep, saveSealed, type StepFindings } from './job-page.js';
import { runStep } from './job-steps.js';
import { AbortJob, type JobReport, type JobRequest, type SecretMap } from './job-types.js';

export type { ChaosAction, JobReport, JobRequest } from './job-types.js';
export type { OperatorSettlement } from './job-operator.js';
export { operatorDeadline, pollOperatorGate, resolveChallenge, settleOperatorAnswer, stageOperatorCode } from './job-operator.js';
export { closestText, failureClues, inspectPage, pageSnapshotText, similarity, visibleWords } from './job-page.js';
export type { ChallengeFrame, ChallengeInput, ChallengeWidget } from './job-challenge.js';
export { classifyBlockedReason, classifyChallenge } from './job-challenge.js';
export { applyChaos, createBucket, deniedByMarker } from './job-net.js';

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
    // An inbox step is the journey opting in to a code from the test inbox. It is not a captcha solver.
    const fillsTotp = journeyFillsTotp(job.steps) || job.steps.some((step) => 'inbox' in step);
    const entries = new RedundantEntryTracker();

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
        const outcome = await runStep(page, step, secrets, job, contextTemplate, redactor, selectors, assertions, screenshots, nav, isAborted, chaosEffect.doubleClick, found, entries, index);
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
        steps.push(finishStep(index, kind, 'pass', started, selectors, assertions, screenshots, consoleLogs.slice(beforeConsole), networkErrors.slice(beforeNetwork), redactor, undefined, outcome.httpStatus, undefined, found));
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
            found,
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
