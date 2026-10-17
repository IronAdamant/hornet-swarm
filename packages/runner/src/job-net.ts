import type { BrowserContext, Locator, Page, Request } from 'playwright';
import { delay } from './job-operator.js';
import { AbortJob, type ChaosAction, type SecretMap } from './job-types.js';

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

export async function maskSecrets(page: Page, secrets: SecretMap): Promise<void> {
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

export function locate(page: Page, selector: string, frame?: string): Locator {
  const root = frame ? page.frameLocator(frame) : page;
  const role = /^role=([a-z]+)\[name='([^']+)'\]$/i.exec(selector);
  if (role?.[1] && role[2]) return root.getByRole(role[1] as 'button', { name: role[2], exact: true });
  return root.locator(selector);
}

export function absolute(url: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return new URL(url, base.endsWith('/') ? base : `${base}/`).toString();
}

export function mainFrameNavigation(request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    // A request with no frame, such as one from a worker, is not a page navigation.
    return false;
  }
}

export function originAllowed(url: string, allow: string[]): boolean {
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

export type NavState = { status: number; count: number; mark: number; inflight: number; lastActivity: number };

export const ASSERT_TIMEOUT_MS = 10_000;
export const fixturesDir = (): string => process.env.AEGIS_FIXTURES_DIR ?? '/opt/runner/fixtures';

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

export async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, isAborted: () => boolean): Promise<boolean> {
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
export async function waitForNavigationOrSettle(page: Page, nav: NavState, isAborted: () => boolean, timeoutMs: number): Promise<void> {
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

export async function interruptible(ms: number, isAborted: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isAborted()) throw new AbortJob('kill');
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, end - Date.now())));
  }
}
