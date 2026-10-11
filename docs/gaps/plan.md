# Plan: human code entry and the kill check

Do not execute this plan until the owner says to proceed.

This plan covers two code gaps. A texted or emailed code waits for a human operator. The kill path is checked when the job response still returns. Captcha stays the current workaround. Lid sleep, the keychain, the duration cap, and a cloud Bot are outside this plan. The owner already keeps those.

`docs/plan.md` sections 1–12 are already in `2493d12`. This file does not reopen them.

## Do not

- Solve a captcha, send a challenge image to a model, or type a captcha answer into the browser.
- Treat a fixture access-denied 403, or the tenant-isolation journey, as a captcha or as a second code.
- Show the one-time code, a password, a TOTP secret, or the age key to an agent, a parent packet, a log, a HAR, or a test assertion.
- Store a texted or emailed code as `totp_secret` or as the account password.
- Create a missing runner, add a daemon, or chain the next suite.
- Set a Docker restart policy.

## Captcha stays a workaround

`classifyChallenge` still returns `captcha` first for "verify you are human", reCAPTCHA, hCaptcha, Turnstile, and Arkose. The journey still stops. The summary still says a person needs to look at that page. No new captcha tool, resume, or model call.

A texted or emailed code is not that workaround. It gets the human wait below.

## 1. A person enters a texted or emailed code

Today, after a step returns, `packages/runner/src/job.ts` blocks the rest of the journey on `2fa` unless that journey has a `fill.totp` step. The owner is not asked for the code. The credential page only stores a username, password, and authenticator secret, and it asks for Touch ID before saving them.

The run keeps the browser open and asks the operator for the one-time code.

- The wait starts only when `classifyChallenge` returns `2fa` and the journey does not fill TOTP. Captcha does not wait.
- The controller notifies the operator with the existing local notification. The loopback page asks for that one code, not for a new password.
- Touch ID confirms the person at the machine before the code is accepted. Decline, a lock that fails Touch ID, or no answer before the run deadline ends the wait.
- The code is posted to the runner under a one-time handle, registered on the redactor before any report text is kept, and filled into the visible code field. The journey then continues from the next step.
- On decline or timeout the journey stays `blocked` with `blocked_reason` `2fa`. The parent packet still has `validation_required: true` and the existing second-code sentence. It does not contain the code.
- A kill file during the wait aborts the job the same way as any other in-flight job.
- The duration deadline still applies while the page is waiting. This wait does not extend `max_run_duration_min`.

Done when a fixture page that says a code was texted, with a visible non-password field, blocks until the operator page receives a code, then finishes that journey. A decline or a timeout exits 2 with `2fa` and submits nothing. The normal login journey and the captcha journey stay as they are. The `/sms` journey that must not submit a code still exits 2 when nobody answers. No test prints the code.

## 2. Check kill when the response still returns

Today the `catch` path in `execute` (`packages/controller/src/suite.ts`) stops the project runners and returns `blocked_reason: kill` with `killed: true`. If `/v1/abort` does not reject the fetch, the success path returns the runner report with `killed: false` and does not stop runners from that function.

When the abort reason is `kill`, or `~/.hornet-swarm/KILL` exists, the success path does the same work as the catch path: stop the project runners, and return `killed: true` with `blocked_reason: kill`.

A duration stop stays one label, `killed: false`, and does not write the kill file. MCP `release: true` still returns before a kill.

Done when a test drives `execute`'s success path with the kill file present and a job response that still returns. The result is `killed: true` and `blocked_reason: kill`, and the stop is for the project rather than one label. The existing duration case still leaves `killed: false`. The test does not hit a real site.

## Left out

- Reading the age key once per process, and any sleep or lid check.
- Putting the duration cap into the parent packet, and any follow-up suite.
- A remote or cloud Bot client. The parent remains the local session that is already waiting on the tool.
- Captcha resume.
