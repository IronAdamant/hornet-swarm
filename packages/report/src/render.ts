import { analysisSchema, type Analysis, type RunResult, type StepResult } from '@aegis/core';

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
};

export type RichUser = {
  label: string;
  phase1: { status: StepResult['status']; duration_ms: number; blocked_reason?: string; error?: string };
  journeys: RichJourney[];
};

export function summaryMarkdown(users: RichUser[], status: RunResult['status']): string {
  const flaky = users.some((user) => user.journeys.some((journey) => journey.status === 'flaky' || journey.steps.some((step) => step.status === 'flaky')));
  const phaseFailed = users.some((user) => user.phase1.status !== 'pass');
  const blockedCaptcha = users.some((user) => user.phase1.blocked_reason === 'captcha' || user.journeys.some((journey) => journey.steps.some((step) => step.blocked_reason === 'captcha')));
  const blockedCode = users.some((user) => user.phase1.blocked_reason === '2fa' || user.journeys.some((journey) => journey.steps.some((step) => step.blocked_reason === '2fa')));
  const isolationFailed = users.some((user) => user.journeys.some((journey) => journey.name.toLowerCase().includes('denied') && journey.status !== 'pass' && journey.status !== 'skipped'));
  let paragraph: string;
  if (status === 'redaction_failure') {
    paragraph = 'A saved file still contained something that should have stayed hidden. This is critical. Do not share these results until that file is removed.';
  } else if (isolationFailed) {
    paragraph = 'A test account could open another account\'s page. This is critical. Fix that access before anything else.';
  } else if (blockedCaptcha) {
    paragraph = 'The site asked for a human check, so the checks stopped. This is high. A person needs to look at that page.';
  } else if (blockedCode) {
    paragraph = 'The site asked for a second code, so the checks stopped. This is high. A person needs to look at that page.';
  } else if (phaseFailed) {
    paragraph = 'Sign-in did not work, so the later checks were not run. This is high. Fix sign-in first.';
  } else if (flaky) {
    paragraph = 'A check failed and then passed when it was tried again. That still counts as a failure. This is medium. Look at that check first.';
  } else if (status !== 'passed') {
    paragraph = 'A check did not pass. This is high. Look at the first thing that failed.';
  } else {
    paragraph = 'Sign-in worked and the checks that followed passed. Nothing needs fixing. This is low.';
  }
  const findings = ['Sign-in was checked.'];
  if (!phaseFailed) findings.push('The test account got in.');
  if (users.some((user) => user.journeys.some((journey) => journey.steps.length > 0 && journey.status === 'pass'))) {
    findings.push('The later checks passed.');
  }
  if (flaky) findings.push('One check had to be tried again, and the overall result stays failed.');
  if (isolationFailed) findings.push('One account could see a page that belongs to someone else.');
  if (blockedCaptcha) findings.push('A human check stopped the run.');
  if (blockedCode) findings.push('A second code stopped the run.');
  if (status === 'passed' && !flaky) findings.push('Nothing needs a change.');
  return `${paragraph}\n\nFindings:\n${findings.map((line) => `- ${line}`).join('\n')}\n`;
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
    `Gate: ${analysis.gate} (${analysis.gate_passed ? 'passed' : 'not passed'})`,
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

export function htmlReport(result: RunResult, summary: string): string {
  const when = formatSydney(result.started_at);
  const banner = result.redaction === 'pass' ? 'Redaction: PASS' : 'Redaction: FAIL';
  const rows = result.users
    .map((user) => `<tr><td>${escapeXml(user.label)}</td><td>${escapeXml(user.phase1.status)}</td><td>${user.journeys.map((journey) => `${escapeXml(journey.id)} ${escapeXml(journey.status)}`).join(', ')}</td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Aegis report</title></head><body><h1>${banner}</h1><p>${escapeXml(when)}</p><pre>${escapeXml(summary)}</pre><table><tr><th>Account</th><th>Sign-in</th><th>Checks</th></tr>${rows}</table></body></html>\n`;
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
  const failed = status === 'fail' || status === 'flaky' || status === 'error';
  const body = failed ? `<failure message="${escapeXml(status)}">${escapeXml(error ?? status)}</failure>` : '';
  return `<testcase classname="${escapeXml(classname)}" name="${escapeXml(name)}" time="${(secondsMs / 1000).toFixed(3)}">${body}</testcase>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
