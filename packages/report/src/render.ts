import { accessibilitySeverity, analysisSchema, sortViolations, type AccessibilityResult, type Analysis, type RunResult, type StepResult } from '@hornet-swarm/core';

export type RichStep = StepResult & {
  console_logs?: string[];
  selectors?: string[];
  assertions?: string[];
  screenshot_paths?: string[];
  trace_path?: string;
  diff?: Analysis['users'][number]['journeys'][number]['steps'][number]['diff'];
};

export type RichJourney = {
  id: string;
  name: string;
  status: StepResult['status'];
  duration_ms: number;
  steps: RichStep[];
  chaosApplied?: string[];
  /** Job-level stop reason. The published journey status stays a step status. */
  blocked_reason?: string;
};

export type RichUser = {
  label: string;
  phase1: { status: StepResult['status']; duration_ms: number; blocked_reason?: string; error?: string };
  journeys: RichJourney[];
};

type StopReason = 'kill' | 'duration' | 'captcha' | '2fa' | 'lease_busy' | 'rate_limited' | 'signin_limit' | 'totp_missing' | 'allowlist' | 'proxy';

function anyReason(users: RichUser[], reason: string): boolean {
  return users.some(
    (user) =>
      user.phase1.blocked_reason === reason ||
      user.journeys.some((journey) => journey.blocked_reason === reason || journey.steps.some((step) => step.blocked_reason === reason)),
  );
}

const DENIAL_CHECK = /^(access_denied\b|http_status (401|403)\b)/;
const NOT_FOUND_CHECK = /^http_status 404\b/;

/**
 * A cross-account finding needs a failed access check, not a journey name. The failed step must be
 * an access_denied assertion or an http_status assertion that expected 401 or 403. In a journey
 * that also ran an access_denied check, a failed selector_absent or an expected 404 counts too,
 * because a site can hide another account's page as "not found". A 404 check on its own, such as
 * a status-code page, is an ordinary failure. So is a failed positive control, such as the user
 * opening their own resource.
 */
export function isolationBreach(users: RichUser[]): { label: string; journey: string; step: number } | undefined {
  for (const user of users) {
    for (const journey of user.journeys) {
      const deniedCheckRan = journey.steps.some((step) => (step.assertion ?? '').startsWith('access_denied'));
      for (const step of journey.steps) {
        if (step.status !== 'fail' || !step.assertion) continue;
        const contextual = step.assertion.startsWith('selector_absent') || NOT_FOUND_CHECK.test(step.assertion);
        if (DENIAL_CHECK.test(step.assertion) || (deniedCheckRan && contextual)) {
          return { label: user.label, journey: journey.name, step: step.index };
        }
      }
    }
  }
  return undefined;
}

const PAGE_LOAD_TIMEOUT = /page\.goto: Timeout|Timeout \d+ms exceeded[\s\S]*navigating to/;

/** Playwright errors carry a call log after the first line. A report keeps the first line. */
function firstLine(error: string): string {
  return (error.split('\n')[0] ?? error).trim();
}

function pageLoadTimedOut(error?: string): boolean {
  return Boolean(error && PAGE_LOAD_TIMEOUT.test(error));
}

const REFUSED = /invalid (email|user ?name|login|credentials)|incorrect (email|user ?name|password)|could not be verified|not recogni[sz]ed/i;

/** Every account that should sign in failed, each with the site's own refusal, such as "Invalid email or password". */
function allRefusedByTheSite(users: RichUser[]): boolean {
  const members = users.filter((user) => user.phase1.blocked_reason !== 'guest');
  return members.length > 0 && members.every((user) => user.phase1.status === 'fail' && REFUSED.test(user.phase1.error ?? ''));
}

function refusalWords(users: RichUser[]): string {
  const said = users.map((user) => /page said: "([^"]+)"/.exec(user.phase1.error ?? '')?.[1]).find(Boolean);
  return said ? `"${said}"` : 'a refused sign-in';
}

/** A guest is not signed in on purpose: it has no login, and none of its journeys signs in. */
function signedInOrGuest(user: RichUser): boolean {
  return user.phase1.status === 'pass' || user.phase1.blocked_reason === 'guest';
}

/** What a failed step means, in words a site owner reads. Playwright's own timeouts become plain English. */
function plainFailure(step: RichUser['journeys'][number]['steps'][number]): string {
  const error = firstLine(step.error ?? '');
  // Keep the page's words that the runner added in brackets; only Playwright's own prefix changes.
  const waited = /^locator\.waitFor: Timeout \d+ms exceeded\.?\s*/i.exec(error);
  if (waited) {
    const plain = step.assertion?.startsWith('selector_visible') ? 'it did not appear within 10 seconds' : 'the page element did not appear in time';
    return `${plain}${error.slice(waited[0].length) ? ` ${error.slice(waited[0].length)}` : ''}`;
  }
  const acted = /^locator\.(click|fill|selectOption|focus|dblclick): Timeout \d+ms exceeded\.?\s*/i.exec(error);
  if (acted) return `the page element was not there to use${error.slice(acted[0].length) ? ` ${error.slice(acted[0].length)}` : ''}`;
  return error || 'it failed';
}

/**
 * A step can pass while a write behind it was refused (409). That is not a failure, but a reader
 * should know, so each one gets a short note.
 */
export function writeErrorsOnPassingSteps(users: RichUser[]): string[] {
  const notes: string[] = [];
  for (const user of users) {
    for (const journey of user.journeys) {
      for (const step of journey.steps) {
        if (step.status !== 'pass') continue;
        for (const entry of step.network_errors ?? []) {
          if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(entry.method) || entry.status < 400 || entry.status >= 500) continue;
          let path = entry.url;
          try {
            path = new URL(entry.url).pathname;
          } catch {
            // Keep the address as recorded.
          }
          notes.push(`${user.label} · ${journey.name} · step ${step.index} passed, but ${entry.method} ${path} answered ${entry.status}.`);
        }
      }
    }
  }
  return [...new Set(notes)].slice(0, 5);
}

const STANDARD_NAMES: Record<string, string> = { wcag2a: 'WCAG 2.0 A', wcag2aa: 'WCAG 2.0 AA', wcag21aa: 'WCAG 2.1 AA', wcag22aa: 'WCAG 2.2 AA' };

/**
 * One line per checked page. Several accounts and journeys often check the same page, so a page's
 * problems are merged by rule, and each rule counts the most places any one check found.
 */
export function accessibilityFindings(users: RichUser[]): string[] {
  const pages = new Map<string, { result: AccessibilityResult; rules: Map<string, AccessibilityResult['violations'][number]>; review: number }>();
  for (const user of users) {
    for (const journey of user.journeys) {
      for (const step of journey.steps) {
        const result = step.accessibility;
        if (!result) continue;
        let path = result.url;
        try {
          // A single-page app routes after the #, as in /#/checkout.
          const parsed = new URL(result.url);
          path = `${parsed.pathname}${parsed.hash}`;
        } catch {
          // Keep the address as recorded.
        }
        const key = `${result.name} (${path})`;
        const page = pages.get(key) ?? { result, rules: new Map(), review: 0 };
        for (const violation of result.violations) {
          const seen = page.rules.get(violation.rule);
          if (!seen || violation.count > seen.count) page.rules.set(violation.rule, violation);
        }
        page.review = Math.max(page.review, result.needs_review);
        pages.set(key, page);
      }
    }
  }
  return [...pages.entries()].map(([key, page]) => {
    const standard = STANDARD_NAMES[page.result.standard] ?? page.result.standard;
    const review = page.review > 0 ? ` ${page.review} ${page.review === 1 ? 'check needs' : 'checks need'} a person to look.` : '';
    const violations = sortViolations([...page.rules.values()]);
    if (violations.length === 0) return `Accessibility · ${key}: no problems found against ${standard}.${review}`;
    const worst = violations[0] as AccessibilityResult['violations'][number];
    const listed = violations
      .slice(0, 4)
      .map((violation) => `${violation.help} (${violation.impact}, ${violation.count} ${violation.count === 1 ? 'place' : 'places'}, such as \`${violation.example}\`)`)
      .join('; ');
    const more = violations.length > 4 ? `; and ${violations.length - 4} more in the page's accessibility file` : '';
    return `Accessibility · ${key}: ${violations.length} ${violations.length === 1 ? 'problem' : 'problems'} against ${standard}, the worst ${worst.impact} (${accessibilitySeverity(worst.impact)} to start). ${listed}${more}.${review}`;
  });
}

function hasAccessibilityProblems(users: RichUser[]): boolean {
  return users.some((user) => user.journeys.some((journey) => journey.steps.some((step) => (step.accessibility?.violations.length ?? 0) > 0)));
}

/** Every failed journey, once. The same failure on several accounts is one line naming them all. */
export function failureList(users: RichUser[]): string[] {
  const groups = new Map<string, { labels: string[]; line: string }>();
  for (const user of users) {
    if (!signedInOrGuest(user)) continue;
    for (const journey of user.journeys) {
      if (journey.status !== 'fail' && journey.status !== 'error' && journey.status !== 'flaky') continue;
      const step = journey.steps.find((entry) => entry.status !== 'pass' && entry.status !== 'skipped');
      const where = step ? `step ${step.index} (${describeStep(step)})` : 'before its first step';
      const what = journey.status === 'flaky' ? 'passed only on a retry' : step ? plainFailure(step) : 'it failed';
      const line = `${journey.name} · ${where}: ${what}`;
      const group = groups.get(line) ?? { labels: [], line };
      group.labels.push(user.label);
      groups.set(line, group);
    }
  }
  return [...groups.values()].map((group) => `${group.labels.join(', ')} · ${group.line}`);
}

/**
 * Under chaos, many journeys often stop at the same shared step, such as their sign-in. One line
 * per cause, naming every journey it stopped, reads as the one finding it is.
 */
export function chaosFailureGroups(users: RichUser[]): string[] {
  const groups = new Map<string, string[]>();
  for (const user of users) {
    if (!signedInOrGuest(user)) continue;
    for (const journey of user.journeys) {
      if (journey.status !== 'fail' && journey.status !== 'error' && journey.status !== 'flaky') continue;
      const step = journey.steps.find((entry) => entry.status !== 'pass' && entry.status !== 'skipped');
      const cause = step ? `${describeStep(step)}: ${journey.status === 'flaky' ? 'passed only on a retry' : plainFailure(step)}` : 'it failed before its first step';
      const members = groups.get(cause) ?? [];
      members.push(`${user.label} · ${journey.name}${step ? ` (step ${step.index})` : ''}`);
      groups.set(cause, members);
    }
  }
  return [...groups.entries()].map(([cause, members]) =>
    members.length === 1 ? `${members[0]}: ${cause}` : `the same failure stopped ${members.length} journeys: ${cause}. Seen in ${members.join('; ')}`,
  );
}

export function summaryMarkdown(users: RichUser[], status: RunResult['status'], chaos?: { profile: string; seed: string }): string {
  const flaky = users.some((user) => user.journeys.some((journey) => journey.status === 'flaky' || journey.steps.some((step) => step.status === 'flaky')));
  const phaseFailed = users.some((user) => user.phase1.status === 'fail' || user.phase1.status === 'error');
  const has = (reason: StopReason) => anyReason(users, reason);
  const breach = isolationBreach(users);
  const rateLimited = status === 'rate_limited' || has('rate_limited');
  let paragraph: string;
  if (status === 'redaction_failure') {
    paragraph = 'A saved file still contained something that should have stayed hidden. This is critical. Do not share these results until that file is removed.';
  } else if (breach) {
    paragraph = 'A test account could open another account\'s page. This is critical. Fix that access before anything else.';
  } else if (has('kill')) {
    paragraph = 'The run was stopped with the kill switch before it finished. Nothing after that point was checked. Release the switch with `hornet-swarm kill --release` before the next run.';
  } else if (has('duration')) {
    paragraph = 'The run reached its time limit before it finished. The checks that did not run are marked blocked. Raise `limits.max_run_duration_min` or run fewer checks at once.';
  } else if (has('captcha')) {
    paragraph = 'The site asked for a human check, so the checks stopped. This is high. A person needs to look at that page.';
  } else if (has('2fa')) {
    paragraph = 'The site asked for a second code, so the checks stopped. This is high. A person needs to look at that page.';
  } else if (has('lease_busy')) {
    const busy = users.filter((user) => user.phase1.blocked_reason === 'lease_busy').map((user) => user.phase1.error ?? `${user.label} is busy: another agent holds its login.`);
    paragraph = `Another agent was using ${busy.length === 1 ? 'one of these logins' : 'some of these logins'}, so ${busy.length === 1 ? 'that account was' : 'those accounts were'} not checked. This is not a site failure. ${busy.join(' ')}`.trim();
  } else if (rateLimited) {
    paragraph = 'The site answered "too many requests" or "unavailable" (HTTP 429 or 503) to more than one request in ten, so the checks stopped to avoid overloading it. This is high. Check the site\'s capacity or its rate limits.';
  } else if (has('signin_limit')) {
    paragraph = 'The hourly sign-in limit for this account was reached, so it was not signed in again. Wait, or raise `limits.max_signin_attempts_per_user_per_hour`.';
  } else if (has('totp_missing')) {
    paragraph = 'This project uses an authenticator code, but no authenticator secret is stored for this account. Store it with `hornet-swarm creds add`.';
  } else if (has('allowlist') || has('proxy')) {
    paragraph = 'A page needed a site outside the allowed list, or the egress proxy failed, so the checks stopped. This is high. Check `targets.allowed_origins` and the proxy.';
  } else if (phaseFailed && users.every((user) => user.phase1.status === 'pass' || pageLoadTimedOut(user.phase1.error))) {
    paragraph = 'The sign-in page did not finish loading in time, so the later checks were not run. This is high. The site was slow or stalled. The trace and network.har show which requests never answered.';
  } else if (phaseFailed && allRefusedByTheSite(users)) {
    paragraph = `Every account was refused with the site's own words (${refusalWords(users)}). If these accounts signed in before, the site may have deleted them, as a demo or staging site can when it resets its data. Create them again, for a practice site with \`node scripts/setup-practice.mjs <site>\`, then run again. This says nothing yet about the site's journeys.`;
  } else if (phaseFailed) {
    const failedLabels = users.filter((user) => user.phase1.status === 'fail' || user.phase1.status === 'error').map((user) => user.label);
    paragraph =
      failedLabels.length < users.length
        ? `Sign-in failed for ${failedLabels.join(', ')} (${failedLabels.length} of ${users.length} accounts). The other accounts signed in. Checks for the failed accounts were not run. This is high. Look at why ${failedLabels.length === 1 ? 'that account was' : 'those accounts were'} refused.`
        : 'Sign-in did not work, so the later checks were not run. This is high. Fix sign-in first.';
  } else if (flaky) {
    paragraph = 'A check failed and then passed when it was tried again. That still counts as a failure. This is medium. Look at that check first.';
  } else if (status !== 'passed' && failureList(users).length > 1) {
    paragraph = `${failureList(users).length} checks did not pass. This is high. Each one is listed below with the step where it broke.`;
  } else if (status !== 'passed') {
    paragraph = 'A check did not pass. This is high. Look at the first thing that failed.';
  } else {
    const asGuests = users.length > 0 && users.every((user) => user.phase1.blocked_reason === 'guest');
    paragraph = hasAccessibilityProblems(users)
      ? `${asGuests ? 'The checks passed, run as guests with no sign-in' : 'Sign-in worked and the checks that followed passed'}, but the accessibility check found problems. Each checked page is listed below, worst problem first.`
      : asGuests
        ? 'The checks passed, run as guests with no sign-in. Nothing needs fixing. This is low.'
        : 'Sign-in worked and the checks that followed passed. Nothing needs fixing. This is low.';
  }
  const guests = users.filter((user) => user.phase1.blocked_reason === 'guest');
  const members = users.filter((user) => user.phase1.blocked_reason !== 'guest');
  const signedIn = members.filter((user) => user.phase1.status === 'pass').length;
  const findings: string[] = [];
  if (members.length > 0) findings.push(members.length === 1 ? (signedIn ? 'Sign-in: the test account got in.' : 'Sign-in: the test account did not get in.') : `Sign-in: ${signedIn} of ${members.length} accounts got in.`);
  if (guests.length > 0) findings.push(`Guests, with no login and journeys that do not sign in: ${guests.map((user) => user.label).join(', ')}.`);
  const ran = users.flatMap((user) => user.journeys.filter((journey) => journey.steps.length > 0));
  if (ran.length > 0) findings.push(`Journeys: ${ran.filter((journey) => journey.status === 'pass').length} of ${ran.length} passed.`);
  // gate_passed only means every account signed in. Say so, so no agent reads it as a pass.
  if (status !== 'passed' && members.length > 0 && signedIn === members.length) {
    findings.push('Sign-in gate: passed, because every account signed in. It does not mean the journeys passed.');
  }
  const failures = failureList(users);
  if (flaky) findings.push('One check had to be tried again, and the overall result stays failed.');
  if (breach) findings.push('One account could see a page that belongs to someone else.');
  if (has('captcha')) findings.push('A human check stopped the run.');
  if (has('2fa')) findings.push('A second code stopped the run.');
  if (rateLimited) findings.push('The site pushed back with HTTP 429 or 503.');
  for (const failure of chaos ? chaosFailureGroups(users) : failures) findings.push(`Failed: ${failure}`);
  for (const note of writeErrorsOnPassingSteps(users)) findings.push(`Note: ${note}`);
  for (const line of accessibilityFindings(users)) findings.push(line);
  const first = diagnose(users, status);
  if (status !== 'passed' && failures.length === 0) findings.push(`First problem: ${first.suspected}`);
  if (status === 'passed' && !flaky && !hasAccessibilityProblems(users)) findings.push('Nothing needs a change.');
  // Under chaos, compare with a normal run: a check that passes normally but failed here is a
  // place where the site did not recover from a lost request, a delay, a refresh, or a double click.
  const chaosNote = chaos
    ? `\n\nThis run added chaos (profile ${chaos.profile}, seed ${chaos.seed}). Compare it with a run without chaos. A check that passes normally but failed here shows where the site did not recover from a lost request, a delay, a refresh, or a double click.`
    : '';
  return `${paragraph}${chaosNote}\n\nFindings:\n${findings.map((line) => `- ${line}`).join('\n')}\n`;
}

const REASON_TEXT: Record<string, string> = {
  kill: 'the kill switch stopped it',
  duration: 'the run reached its time limit',
  captcha: 'the site showed a human check',
  '2fa': 'the site asked for a texted or emailed code',
  lease_busy: 'another agent held this login',
  rate_limited: 'the site answered HTTP 429 or 503 too often',
  signin_limit: 'the hourly sign-in limit was reached',
  totp_missing: 'no authenticator secret is stored',
  allowlist: 'a page needed a site outside the allowed list',
  proxy: 'the egress proxy failed',
};

const NEXT_ACTION: Record<string, string> = {
  kill: 'Release the kill switch with `hornet-swarm kill --release` when it is safe, then run again.',
  duration: 'Raise `limits.max_run_duration_min`, or split the checks across more agents.',
  captcha: 'Open the screenshot. A person has to clear the human check, or the test environment has to turn it off for these accounts.',
  '2fa': 'Turn on TOTP for these accounts, or answer the code page when the run asks.',
  lease_busy: 'Wait for the other agent to finish, or ask for a free label with `acquire_test_user`.',
  rate_limited: 'Check the site\'s rate limits and capacity, or lower `limits.max_requests_per_second_per_runner`.',
  signin_limit: 'Wait an hour, or raise `limits.max_signin_attempts_per_user_per_hour`.',
  totp_missing: 'Store the authenticator secret with `hornet-swarm creds add`.',
  allowlist: 'Add the needed origin to `targets.allowed_origins` if it is in the authorisation, or remove it from the page.',
  proxy: 'Run `hornet-swarm env status`, then `hornet-swarm env reset` if the proxy is down.',
};

/**
 * Names the first real problem from the step evidence. Confidence says how directly that evidence
 * names the cause: a known stop reason or a passing run is high, a single failed assertion is
 * fairly high, a crash or several unrelated failures is lower, and a check that passed only on a
 * retry is lowest.
 */
export function diagnose(users: RichUser[], status: RunResult['status']): { suspected: string; confidence: number; repro: string[]; next: string[] } {
  if (status === 'passed') {
    return { suspected: 'Nothing failed.', confidence: 0.95, repro: ['Sign in with the test account.', 'Repeat the same checks.'], next: ['No change is needed.'] };
  }
  if (status === 'redaction_failure') {
    return {
      suspected: 'A saved file still contained something that should have stayed hidden.',
      confidence: 0.95,
      repro: ['Run the same checks again after the hidden text is removed.'],
      next: ['Do not share these results.', 'Remove the hidden text and run the check again.'],
    };
  }
  const breach = isolationBreach(users);
  const problems: { text: string; reason?: string; repro: string[]; flaky: boolean; error: boolean; stalled: boolean }[] = [];
  for (const user of users) {
    if (!signedInOrGuest(user)) {
      const reason = user.phase1.blocked_reason;
      problems.push({
        text: reason
          ? `${user.label} · sign-in stopped: ${REASON_TEXT[reason] ?? reason}.`
          : pageLoadTimedOut(user.phase1.error)
            ? `${user.label} · the sign-in page did not finish loading within 15 seconds.`
            : `${user.label} · sign-in ${user.phase1.status === 'error' ? 'could not run' : 'failed'}${user.phase1.error ? `: ${firstLine(user.phase1.error)}` : '.'}`,
        ...(reason ? { reason } : {}),
        repro: pageLoadTimedOut(user.phase1.error)
          ? [`Open the sign-in page as ${user.label}.`, 'Watch the network panel for requests that never answer.']
          : [`Open the sign-in page as ${user.label}.`, 'Enter the stored username and password and submit.', 'Check that the success condition in `auth.success` appears.'],
        flaky: false,
        error: user.phase1.status === 'error',
        stalled: pageLoadTimedOut(user.phase1.error),
      });
      continue;
    }
    for (const journey of user.journeys) {
      if (journey.status === 'pass' || journey.status === 'skipped') continue;
      const step = journey.steps.find((entry) => entry.status !== 'pass') ?? journey.steps[journey.steps.length - 1];
      const reason = step?.blocked_reason ?? journey.blocked_reason;
      const what = step ? `step ${step.index} (${describeStep(step)})` : 'before its first step';
      const outcome = reason
        ? `stopped: ${REASON_TEXT[reason] ?? reason}`
        : journey.status === 'flaky'
          ? 'passed only on a retry'
          : pageLoadTimedOut(step?.error)
            ? 'failed: the page did not finish loading within 15 seconds'
            : step?.error
              ? `failed: ${firstLine(step.error)}`
              : 'failed';
      problems.push({
        text: `${user.label} · ${journey.name} · ${what} ${outcome}${outcome.endsWith('.') ? '' : '.'}`,
        ...(reason ? { reason } : {}),
        repro: [
          `Sign in as ${user.label}.`,
          ...journey.steps.filter((entry) => !step || entry.index <= step.index).map((entry) => `Step ${entry.index}: ${describeStep(entry)}.`),
        ],
        flaky: journey.status === 'flaky',
        error: journey.status === 'error',
        stalled: pageLoadTimedOut(step?.error),
      });
    }
  }
  const first = problems[0];
  if (!first) {
    return { suspected: 'The run did not finish every check.', confidence: 0.5, repro: ['Run the same checks again.'], next: ['Read run.json for the account that did not finish.'] };
  }
  const suspected = breach ? `${breach.label} · ${breach.journey} · step ${breach.step}: another account's data was reachable.` : first.text;
  let confidence = first.reason ? 0.95 : first.flaky ? 0.5 : first.error ? 0.6 : 0.8;
  if (!first.reason && new Set(problems.map((problem) => problem.text)).size > 2) confidence = Math.min(confidence, 0.6);
  const next = breach
    ? ['Fix the access check on that page before anything else.', 'Run the isolation journey again to confirm the fix.']
    : first.reason
      ? [NEXT_ACTION[first.reason] ?? 'Look at the screenshot for that step.']
      : first.stalled
        ? [
            'Open network.har or the trace and find the requests that never answered.',
            'If they stall only over HTTP/2, that is a finding about the site. Set runners.http2: false to keep testing its pages over HTTP/1.1.',
          ]
        : first.flaky
        ? ['Look for a race on that page: content that appears late, or a request that sometimes fails.', 'Run the journey several times and compare with `hornet-swarm stats`.']
        : ['Open the screenshot and trace for that step.', 'Fix the first failed check and run it again.'];
  return { suspected, confidence, repro: first.repro, next };
}

function describeStep(step: RichStep): string {
  if (step.assertion) return `${step.type} ${step.assertion}`;
  if (step.selector) return `${step.type} ${step.selector}`;
  return step.type;
}

export function buildAnalysis(input: {
  result: RunResult;
  users: RichUser[];
  chaos: { profile: string; seed: string; actions: string[] } | null;
  suspected: string;
  confidence: number;
  repro: string[];
  regressions: string[];
  next: string[];
}): Analysis {
  const analysis: Analysis = {
    schema_version: '1.0.0',
    project: input.result.project,
    status: input.result.status,
    gate: input.result.gate,
    gate_passed: input.result.gate_passed,
    started_at: input.result.started_at,
    finished_at: input.result.finished_at ?? input.result.started_at,
    environment: input.result.environment,
    authorisation_id: input.result.authorisation_id,
    redaction: input.result.redaction,
    chaos: input.chaos,
    users: input.users.map((user) => ({
      label: user.label,
      phase1: user.phase1,
      journeys: user.journeys.map((journey) => ({
        id: journey.id,
        name: journey.name,
        status: journey.status,
        duration_ms: journey.duration_ms,
        steps: journey.steps.map((step) => ({
          index: step.index,
          type: step.type,
          status: step.status,
          duration_ms: step.duration_ms,
          started_at: step.started_at,
          finished_at: step.finished_at,
          ...(step.selector ? { selector: step.selector } : {}),
          ...(step.assertion ? { assertion: step.assertion } : {}),
          ...(step.error ? { error: step.error } : {}),
          ...(step.screenshot ? { screenshot: step.screenshot } : {}),
          ...(step.blocked_reason ? { blocked_reason: step.blocked_reason } : {}),
          ...(step.console_error_count !== undefined ? { console_error_count: step.console_error_count } : {}),
          ...(step.network_errors ? { network_errors: step.network_errors } : {}),
          ...(step.http_status ? { http_status: step.http_status } : {}),
          ...(step.accessibility ? { accessibility: step.accessibility } : {}),
          timings: { started_at: step.started_at, finished_at: step.finished_at, duration_ms: step.duration_ms },
          selectors: step.selectors ?? (step.selector ? [step.selector] : []),
          assertions: step.assertions ?? (step.assertion ? [step.assertion] : []),
          console_logs: step.console_logs ?? [],
          network_failures: step.network_errors ?? [],
          ...(step.trace_path ? { trace_path: step.trace_path } : {}),
          screenshot_paths: step.screenshot_paths ?? (step.screenshot ? [step.screenshot] : []),
          ...(step.diff ? { diff: step.diff } : {}),
        })),
      })),
    })),
    suspected_cause: input.suspected,
    confidence: input.confidence,
    repro_steps: input.repro,
    related_regressions: input.regressions,
    suggested_next_actions: input.next,
  };
  return analysisSchema.parse(analysis);
}

export function analysisMarkdown(analysis: Analysis): string {
  const lines = [
    '# Analysis',
    '',
    `Status: ${analysis.status}`,
    `Redaction: ${analysis.redaction}`,
    `Sign-in gate: ${analysis.gate} (${analysis.gate_passed ? 'passed: every account signed in. This says nothing about the journeys' : 'not passed'})`,
    `Confidence: ${analysis.confidence}`,
    '',
    '## Suspected cause',
    analysis.suspected_cause,
    '',
    '## Chaos',
  ];
  if (analysis.chaos) {
    lines.push(`Profile: ${analysis.chaos.profile}`, `Seed: ${analysis.chaos.seed}`, `Actions: ${analysis.chaos.actions.join(', ') || 'none'}`);
  } else {
    lines.push('No chaos actions.');
  }
  lines.push('', '## Steps');
  for (const user of analysis.users) {
    lines.push(`### ${user.label}`, `Sign-in: ${user.phase1.status} (${user.phase1.duration_ms} ms)`);
    for (const journey of user.journeys) {
      lines.push(`#### ${journey.id} ${journey.name}`, `Journey status: ${journey.status} (${journey.duration_ms} ms)`);
      for (const step of journey.steps) {
        lines.push(
          `- Step ${step.index} ${step.type} ${step.status}`,
          `  Timings: ${step.timings.started_at} to ${step.timings.finished_at} (${step.timings.duration_ms} ms)`,
          `  Selectors: ${step.selectors.join(', ') || 'none'}`,
          `  Assertions: ${step.assertions.join(', ') || 'none'}`,
          `  Console: ${step.console_logs.join(' | ') || 'none'}`,
          `  Network: ${step.network_failures.map((failure) => `${failure.method} ${failure.url} ${failure.status}`).join(' | ') || 'none'}`,
          `  Trace: ${step.trace_path ?? 'none'}`,
          `  Screenshots: ${step.screenshot_paths.join(', ') || 'none'}`,
          step.diff
            ? `  Diff: visual ${step.diff.visual}, timing ${step.diff.timing}, text ${step.diff.text}, console ${step.diff.console}, network ${step.diff.network}`
            : '  Diff: none',
        );
        if (step.accessibility) {
          const found = step.accessibility.violations.map((violation) => `${violation.rule} ${violation.impact} x${violation.count}`).join(', ');
          lines.push(`  Accessibility: ${step.accessibility.standard} at ${step.accessibility.url}: ${found || 'no problems'}; ${step.accessibility.needs_review} to review`);
        }
      }
    }
  }
  lines.push('', '## Reproduction', ...analysis.repro_steps.map((step) => `- ${step}`));
  lines.push('', '## Regressions', analysis.related_regressions.length > 0 ? analysis.related_regressions.map((item) => `- ${item}`).join('\n') : 'none');
  lines.push('', '## Next actions', ...analysis.suggested_next_actions.map((step) => `- ${step}`), '');
  return `${lines.join('\n')}\n`;
}

export function junitXml(result: RunResult): string {
  const suites = result.users
    .map((user) => {
      const cases = [
        testcase(user.label, 'sign-in', user.phase1.status, user.phase1.duration_ms, user.phase1.error),
        ...user.journeys.flatMap((journey) =>
          journey.steps.map((step) => testcase(user.label, `${journey.id} ${step.type}`, step.status, step.duration_ms, step.error)),
        ),
      ];
      return `  <testsuite name="${escapeXml(user.label)}">${cases.join('')}</testsuite>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>${suites}</testsuites>\n`;
}

export function htmlReport(result: RunResult, summary: string, artifacts?: { screenshots: string[]; traces: string[] }): string {
  const when = formatSydney(result.started_at);
  const banner = result.redaction === 'pass' ? 'Redaction: PASS' : 'Redaction: FAIL';
  const journeyIds = [...new Set(result.users.flatMap((user) => user.journeys.map((journey) => journey.id)))];
  const header = `<tr><th>Account</th><th>Sign-in</th>${journeyIds.map((id) => `<th>${escapeXml(id)}</th>`).join('')}</tr>`;
  const rows = result.users
    .map((user) => {
      const cells = journeyIds
        .map((id) => {
          const journey = user.journeys.find((entry) => entry.id === id);
          return `<td>${escapeXml(journey?.status ?? '')}</td>`;
        })
        .join('');
      return `<tr><td>${escapeXml(user.label)}</td><td>${escapeXml(user.phase1.status)}</td>${cells}</tr>`;
    })
    .join('');
  const links = [...(artifacts?.screenshots ?? []), ...(artifacts?.traces ?? [])]
    .map((path) => `<li><a href="${escapeXml(linkHref(path))}">${escapeXml(path)}</a></li>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hornet Swarm report</title></head><body><h1>${banner}</h1><p>${escapeXml(when)}</p><pre>${escapeXml(summary)}</pre><h2>Data isolation</h2><table>${header}${rows}</table><h2>Evidence</h2><ul>${links}</ul></body></html>\n`;
}

function linkHref(path: string): string {
  const href = path.startsWith('/') ? `file://${path}` : path;
  return encodeURI(href).replace(/&/g, '%26');
}

export function formatSydney(iso: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const offset = get('timeZoneName');
  const label = offset.includes('+11') ? 'AEDT' : 'AEST';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${label} (${iso})`;
}

function testcase(classname: string, name: string, status: string, secondsMs: number, error?: string): string {
  const failed = status === 'fail' || status === 'flaky' || status === 'error' || status === 'blocked';
  const body = failed ? `<failure message="${escapeXml(status)}">${escapeXml(error ?? status)}</failure>` : '';
  return `<testcase classname="${escapeXml(classname)}" name="${escapeXml(name)}" time="${(secondsMs / 1000).toFixed(3)}">${body}</testcase>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
