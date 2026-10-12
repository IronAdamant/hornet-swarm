import { z } from 'zod';

export const globalConfigSchema = z
  .object({
    runtime: z.enum(['auto', 'orbstack', 'colima']).default('auto'),
    default_project: z.string().default('consistencyhub'),
    results_retention_days: z.number().int().positive().default(30),
    ocr_screenshot_check: z.boolean().default(true),
    log_level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  })
  .strict();

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

export const assertionSchema = z
  .object({
    type: z.enum([
      'url_contains',
      'text_visible',
      'selector_visible',
      'selector_absent',
      'http_status',
      'access_denied',
    ]),
    value: z.string().optional(),
  })
  .strict();

export type Assertion = z.infer<typeof assertionSchema>;

export const thirdPartySchema = z
  .object({
    origin: z.string().url(),
    passive: z.boolean(),
  })
  .strict();

export const userSchema = z
  .object({
    label: z.string().regex(/^qa-user-\d+$/),
    role: z.string(),
    tenant: z.string(),
    vars: z.record(z.string()).default({}),
  })
  .strict();

export type ProjectUser = z.infer<typeof userSchema>;

export const projectSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    authorisation_id: z.string(),
    environment: z.enum(['staging', 'test', 'dev', 'production']),
    targets: z
      .object({
        base_url: z.string().url(),
        allowed_origins: z.array(z.string().url()).min(1),
        allowed_third_party: z.array(thirdPartySchema).default([]),
      })
      .strict(),
    auth: z
      .object({
        signin_url: z.string(),
        selectors: z
          .object({
            username: z.string(),
            password: z.string(),
            submit: z.string(),
            totp: z.string().default("input[autocomplete='one-time-code']"),
          })
          .strict(),
        success: z.array(assertionSchema).min(1),
        auth_endpoints: z.array(z.string()).default([]),
        totp: z
          .object({
            enabled: z.boolean().default(false),
          })
          .default({ enabled: false }),
        /** How long a run waits for the owner to type a texted or emailed code. The run deadline still applies. */
        operator_code_wait_sec: z.number().int().positive().max(3600).default(600),
        access_denied_markers: z
          .array(z.string())
          .default(['access denied', 'not authorised', 'not authorized', 'forbidden', 'not found']),
      })
      .strict(),
    runners: z
      .object({
        count: z.number().int().min(1).max(30).default(10),
        memory: z.string().default('1g'),
        cpus: z.number().positive().max(8).default(1),
      })
      .strict(),
    limits: z
      .object({
        max_parallel_runners: z.number().int().min(1).max(30).default(10),
        max_requests_per_second_per_runner: z.number().positive().default(5),
        /** How many requests one runner may send at once before the per-second rate applies. A single page load is a burst. */
        request_burst_per_runner: z.number().int().positive().max(200).default(20),
        max_requests_per_second_total: z.number().positive().default(20),
        min_step_delay_ms: z.number().int().nonnegative().default(250),
        max_run_duration_min: z.number().positive().default(30),
        max_signin_attempts_per_user_per_hour: z.number().int().positive().default(5),
      })
      .strict(),
    phase2: z
      .object({
        gate: z.enum(['all', 'per_user']).default('all'),
      })
      .default({ gate: 'all' }),
    journeys_dir: z.string().default('./journeys'),
    users: z.array(userSchema).min(1).max(30),
  })
  .strict();

export type Project = z.infer<typeof projectSchema>;

export const activitySchema = z.enum([
  'functional_e2e',
  'signin_smoke',
  'access_control_checks',
  'chaos',
]);

export const authorisationSchema = z
  .object({
    id: z.string(),
    basis: z.enum(['owner', 'contract']),
    client: z.string(),
    authoriser: z
      .object({
        name: z.string(),
        role: z.string(),
        email: z.string().email(),
      })
      .strict(),
    granted_to: z.string(),
    scope: z
      .object({
        domains: z.array(z.string()).min(1),
        environments: z.array(z.enum(['staging', 'test', 'dev', 'production'])).min(1),
      })
      .strict(),
    activities: z.array(activitySchema).min(1),
    exclusions: z.array(z.string()).default([]),
    valid_from: z.string(),
    valid_until: z.string(),
    document: z
      .object({
        path: z.string(),
        sha256: z.string(),
      })
      .strict(),
    notes: z.string().default(''),
    revoked: z.boolean().optional(),
  })
  .strict();

export type Authorisation = z.infer<typeof authorisationSchema>;

const navigateStep = z.object({ navigate: z.object({ url: z.string() }).strict() }).strict();
const clickStep = z.object({ click: z.object({ selector: z.string() }).strict() }).strict();
const fillStep = z
  .object({
    fill: z
      .object({
        selector: z.string(),
        value: z.string().optional(),
        credential: z.string().optional(),
        totp: z.string().optional(),
      })
      .strict(),
  })
  .strict();
const waitStep = z
  .object({
    wait: z
      .object({
        for: z.enum(['selector', 'navigation', 'timeout']),
        selector: z.string().optional(),
        ms: z.number().int().nonnegative().optional(),
        state: z.enum(['visible', 'hidden', 'attached']).optional(),
      })
      .strict(),
  })
  .strict();
const assertStep = z.object({ assert: assertionSchema }).strict();
const uploadStep = z
  .object({
    upload: z
      .object({
        selector: z.string(),
        fixture: z.string(),
      })
      .strict(),
  })
  .strict();
const screenshotStep = z
  .object({
    screenshot: z
      .object({
        name: z.string(),
        full_page: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const stepSchema = z.union([
  navigateStep,
  clickStep,
  fillStep,
  waitStep,
  assertStep,
  uploadStep,
  screenshotStep,
]);

export type Step = z.infer<typeof stepSchema>;

export const journeySchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    description: z.string().default(''),
    users: z.array(z.string().regex(/^qa-user-\d+$/)).min(1),
    requires_phase1: z.boolean().default(true),
    tags: z.array(z.string()).default([]),
    vars: z.record(z.string()).default({}),
    retries: z.number().int().min(0).max(3).default(0),
    steps: z.array(stepSchema).min(1),
  })
  .strict();

export type Journey = z.infer<typeof journeySchema>;

export const stepStatusSchema = z.enum(['pass', 'fail', 'skipped', 'blocked', 'error', 'flaky']);

export const runStatusSchema = z.enum([
  'passed',
  'failed',
  'blocked',
  'rate_limited',
  'redaction_failure',
  'error',
]);

export const stepResultSchema = z
  .object({
    index: z.number().int().nonnegative(),
    type: z.string(),
    status: stepStatusSchema,
    duration_ms: z.number().nonnegative(),
    started_at: z.string(),
    finished_at: z.string(),
    selector: z.string().optional(),
    assertion: z.string().optional(),
    error: z.string().optional(),
    screenshot: z.string().optional(),
    blocked_reason: z
      .enum(['captcha', '2fa', 'allowlist', 'rate_limited', 'kill', 'signin_limit', 'duration', 'totp_missing', 'proxy', 'lease_busy'])
      .optional(),
    console_error_count: z.number().int().nonnegative().optional(),
    network_errors: z
      .array(
        z.object({
          method: z.string(),
          url: z.string(),
          status: z.number().int(),
        }),
      )
      .optional(),
    http_status: z.number().int().optional(),
  })
  .strict();

export type StepResult = z.infer<typeof stepResultSchema>;

export const runResultSchema = z
  .object({
    schema_version: z.literal('1'),
    run_id: z.string(),
    project: z.string(),
    started_at: z.string(),
    finished_at: z.string().optional(),
    status: runStatusSchema,
    gate: z.enum(['all', 'per_user']),
    gate_passed: z.boolean(),
    totals: z.object({
      users: z.number().int(),
      journeys: z.number().int(),
      steps: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      skipped: z.number().int(),
    }),
    users: z.array(
      z.object({
        label: z.string(),
        phase1: z.object({
          status: stepStatusSchema,
          duration_ms: z.number().nonnegative(),
          blocked_reason: z.string().optional(),
          error: z.string().optional(),
        }),
        journeys: z.array(
          z.object({
            id: z.string(),
            status: stepStatusSchema,
            duration_ms: z.number().nonnegative(),
            steps: z.array(stepResultSchema),
          }),
        ),
      }),
    ),
    environment: z.string(),
    authorisation_id: z.string(),
    redaction: z.enum(['pass', 'fail']),
  })
  .strict();

export type RunResult = z.infer<typeof runResultSchema>;

export const ANALYSIS_SCHEMA_VERSION = '1.0.0';

export const analysisSchema = z
  .object({
    schema_version: z.literal(ANALYSIS_SCHEMA_VERSION),
    project: z.string(),
    status: runStatusSchema,
    gate: z.enum(['all', 'per_user']),
    gate_passed: z.boolean(),
    started_at: z.string(),
    finished_at: z.string(),
    environment: z.string(),
    authorisation_id: z.string(),
    redaction: z.enum(['pass', 'fail']),
    chaos: z
      .object({
        profile: z.string(),
        seed: z.string(),
        actions: z.array(z.string()),
      })
      .nullable(),
    users: z.array(
      z.object({
        label: z.string(),
        phase1: z.object({
          status: stepStatusSchema,
          duration_ms: z.number(),
          blocked_reason: z.string().optional(),
          error: z.string().optional(),
        }),
        journeys: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: stepStatusSchema,
            duration_ms: z.number(),
            steps: z.array(
              stepResultSchema.extend({
                timings: z.object({
                  started_at: z.string(),
                  finished_at: z.string(),
                  duration_ms: z.number(),
                }),
                selectors: z.array(z.string()),
                assertions: z.array(z.string()),
                console_logs: z.array(z.string()),
                network_failures: z.array(
                  z.object({
                    method: z.string(),
                    url: z.string(),
                    status: z.number(),
                  }),
                ),
                trace_path: z.string().optional(),
                screenshot_paths: z.array(z.string()),
                diff: z
                  .object({
                    visual: z.enum(['same', 'changed', 'no_baseline']),
                    visual_mismatch_ratio: z.number().optional(),
                    timing: z.enum(['same', 'slower', 'no_baseline']),
                    text: z.enum(['same', 'changed', 'no_baseline']),
                    console: z.enum(['same', 'new_errors', 'no_baseline']),
                    network: z.enum(['same', 'new_errors', 'no_baseline']),
                    notes: z.array(z.string()),
                  })
                  .optional(),
              }),
            ),
          }),
        ),
      }),
    ),
    suspected_cause: z.string(),
    confidence: z.number().min(0).max(1),
    repro_steps: z.array(z.string()),
    related_regressions: z.array(z.string()),
    suggested_next_actions: z.array(z.string()),
  })
  .strict();

export type Analysis = z.infer<typeof analysisSchema>;

export const credentialRequestSchema = z
  .object({
    project: z.string(),
    label: z.string().regex(/^qa-user-\d+$/),
    reason: z.string().min(1),
  })
  .strict();

export const leaseAcquireSchema = z
  .object({
    project: z.string(),
    label: z.string().regex(/^qa-user-\d+$/),
    agent_id: z.string().min(1),
    run_id: z.string().optional(),
    ttl_ms: z.number().int().positive().optional(),
  })
  .strict();
