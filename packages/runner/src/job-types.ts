import type { Step, StepResult, TemplateContext } from '@hornet-swarm/core';

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
  /** Directory of test-inbox mailboxes. A journey reads one only when it has an inbox step. */
  inboxDir?: string;
};

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

export type SecretMap = Map<string, string>;

export class AbortJob extends Error {
  constructor(readonly reason: JobReport['blocked_reason'] & string) {
    super('stopped');
  }
}
