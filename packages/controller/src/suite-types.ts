import type { StepResult } from '@hornet-swarm/core';
import type { RichStep } from '@hornet-swarm/report';

export type JobReport = {
  ok: boolean;
  status: 'passed' | 'failed' | 'blocked' | 'error' | 'rate_limited';
  blocked_reason?: StepResult['blocked_reason'];
  steps: RichStep[];
  chaosApplied: string[];
};

export type SuiteRequest = {
  project: string;
  journeyFiles?: string[];
  home?: string;
  gate?: 'all' | 'per_user';
  confirmProduction?: boolean;
  chaos?: { profile: string; seed: string };
  agentId?: string;
  via?: 'cli' | 'mcp';
  phase1Only?: boolean;
  users?: string[];
  /**
   * Open regression copies join a suite run, and the suite records new ones. A single-journey
   * run does neither. Defaults to true.
   */
  includeRegressions?: boolean;
  /**
   * Whether a journey may be named by a file path. The CLI allows it. An agent names journeys by
   * id only, so it cannot make the harness read a file outside the project. Defaults to true.
   */
  journeyPathsAllowed?: boolean;
  /** Test hook. Production runs keep the 30 minute lease. */
  leaseTtlMs?: number;
};

export type ParentPacket = {
  validation_required: true;
  run_id: string;
  project: string;
  status: string;
  summary: string;
  analysis: unknown;
  evidence_zip: string;
  html_path: string;
  screenshot_paths: string[];
  /** The page's words and form-field values beside each screenshot. Quote these, not a reading of the picture. */
  page_text_paths: string[];
  trace_paths: string[];
  packet_path: string;
  instruction: string;
  killed: boolean;
  max_run_duration_min: number;
  deadline: string;
  /** Set when a journey ended on a human check or a second code. That journey is finished. */
  stop_note?: string;
};

export const STOP_NOTE =
  'A journey ended on a human check or a second code. That journey is finished and will not resume. The screenshot is for a person to look at. Do not try to solve the challenge.';

export const PARENT_INSTRUCTION =
  "The parent agent (a Grok Build session, Grok Bot, Claude, or another MCP client) reads this packet, checks it against the task, and only then tells the owner the outcome. The harness does not grade a site's AI replies.";

export function selectRunLabels(input: {
  phase1Only: boolean;
  users?: string[];
  projectUsers: string[];
  journeyUsers: string[];
}): string[] {
  if (input.phase1Only) return input.users ?? input.projectUsers;
  const journeyUsers = [...new Set(input.journeyUsers)];
  if (!input.users) return journeyUsers;
  const wanted = new Set(input.users);
  return journeyUsers.filter((label) => wanted.has(label));
}

export function mapStatus(report: JobReport): StepResult['status'] {
  if (report.status === 'passed') return 'pass';
  if (report.status === 'blocked' || report.status === 'rate_limited') return 'blocked';
  if (report.status === 'error') return 'error';
  return 'fail';
}

export function makeRunId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const hex = Math.random().toString(16).slice(2, 8);
  return `run_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${hex}`;
}

export function isoOffset(date = new Date()): string {
  const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
