import { request as httpRequest } from 'node:http';
import type { Page } from 'playwright';
import type { Redactor } from '@hornet-swarm/core';
import type { JobRequest, SecretMap } from './job-types.js';

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

export async function askOperator(job: JobRequest, isAborted: () => boolean): Promise<OperatorSettlement> {
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

export async function fillVisibleCode(page: Page, code: string): Promise<void> {
  for (const selector of CODE_FIELDS) {
    const field = page.locator(selector).first();
    if ((await field.count()) === 0) continue;
    await field.fill(code, { timeout: 15_000 });
    return;
  }
  throw new Error('no visible code field');
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
