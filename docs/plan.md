# Plan: make an unattended swarm finish honestly

Implement this file in `/Users/aron/Documents/coding_projects/hornet-swarm`. Do the sections in order. Do not add a chat model, a free-roam browser, a launchd job, or a public release.

Re-checked against the source on 2026-10-11 by deep-research-11 (control plane), deep-research-12 (runtime), and deep-research-13 (redaction and reports). The same gaps are still present. Two corrections from that pass are already written into the sections below: `get_swarm` returns `ready`, `project`, `website`, and agents, and the runner does register an injected TOTP code in its own redactor while the controller scan does not. The journey-name breach sentence was confirmed again by reading `packages/report/src/render.ts` around the `isolationFailed` check. `docs/unattended-swarm-goal.md` is stale where it says the suite never reads `max_run_duration_min`. The suite reads it.

## Ready means

A parent that is already running can give each sub-agent one label and a distinct agent id. That sub-agent can sign in and run only its own label. A time limit, a dead runner, a second-factor page, or a proxy failure ends that run with a parent packet whose status matches what happened. A crash cannot pin every lease. A report cannot call a blocked login a cross-account breach, and it cannot call a blocked step a JUnit success. Secrets that the runner already knows, including the one-time TOTP code and a lowercased password, do not survive in the HAR, the parent packet, or a screenshot filename.

This does not make the Mac stay awake, keep the keychain unlocked, or start a swarm by itself. Those stay operator duties. They are listed at the end and are not code tasks.

## Do not

- Edit `/Users/aron/Documents/coding_projects/QA Swarm Tester spec` except to read `SPEC.md`.
- Open `staging.consistencyhub.app` or any other real site. Test only the offline fixture.
- Push, or change the GitHub repo `IronAdamant/hornet-swarm` from private to public.
- Change git config. If you commit, use `git -c user.name="Aron Amos" -c user.email="aron.amos@ironadamant.com"` before the subcommand. Do not commit this plan file.
- Delete the Keychain item `aegis-age-key`, or any Docker volume whose name starts with `aegis-profile-` or `hornet-swarm-profile-`.
- Stop or remove the old `aegis-*` containers. A new `env up` creates `hornet-swarm-*` containers beside them. If Docker runs out of memory, write the failure into the goal scratch and stop. Do not delete the old fleet to free memory.
- Rename `AEGIS_*` environment variables. The runner image reads them.
- Solve a CAPTCHA or a non-TOTP second factor. Detecting one and stopping is required. Typing a guessed code, clicking through a challenge, or calling a solver is not.
- Weaken the existing lease e2e assertion that a second label returns `agent_already_holds`.
- Treat the fixture's access-denied 403, or the tenant-isolation journey, as a captcha. That journey is expected to pass.
- Set Docker `RestartPolicy`. A kill and a duration stop are supposed to stop containers. The next suite may start a stopped container. It must not come back by itself during a kill.
- Put a password, TOTP secret, TOTP code, or age key in a report, a tool result, a log, an assertion message, or this plan.
- Add a daemon, cron, launchd job, or scheduler. The parent session stays responsible for starting work.

The fixture on port 4173 may be down. Start `test/fixture-app/server.js` from this repo, bound so Docker can reach it, before any e2e test that needs it. Seed it with the e2e `resetFixture()` helper before a login test. A fresh server has an empty user map. Stop the fixture when the tests are finished if you started it.

Rebuild package `dist` after source edits. E2E imports `packages/*/dist`. Rebuild the runner image after runner changes and the proxy image after `egress-proxy.ts` changes. `scripts/build-image.sh` builds both. The proxy image copies `packages/controller/dist/egress-proxy.js`.

## 1. One agent id, and only that label

`packages/mcp-server/src/main.ts`: `run_signin_check`, `run_journey`, and `run_suite` pass `agentId: agent_id ?? 'mcp'`. An omitted id makes every sub-agent share one lease.

`run_journey` accepts `users` and then ignores it. The handler only forwards `project`, `journey_id`, and `agent_id`.

`packages/controller/src/suite.ts` uses `request.users` only when `phase1Only` is true. A journey or suite run takes labels from the journey files, so one sub-agent runs every label on the journey. The CLI `--user` flag exists only on `sign-in`.

Change:

- MCP `agent_id` is required on `run_signin_check`, `run_journey`, and `run_suite`. Reject a missing or blank id. Do not substitute `mcp`.
- `run_journey` passes `users` through to `runSuite`.
- `run_suite` accepts optional `users`. When `users` is present, the labels are the intersection of that list and the journey users. A label outside the journey is not added. When `users` is omitted, a suite still runs the journey users, which is the current CLI behavior.
- CLI `journey` and `suite` accept `--user <label...>`, the same way `sign-in` already does, and pass it as `users`.
- CLI may keep its own default agent id of `AEGIS_AGENT_ID` or `cli-${pid}` when `--agent-id` is omitted. That default is one process, not the shared MCP id.

Done when an MCP call without `agent_id` fails before a lease is taken, two MCP calls with different agent ids can hold different labels, `run_journey` with `users: ['qa-user-1']` on a journey that also lists `qa-user-2` does not sign in `qa-user-2`, and the existing `agent_already_holds` e2e still passes.

## 2. The swarm view shows the kill switch and runner health

`readSwarm` returns `ready`, `project`, `website`, and agents of `label` plus `personality`. `ready: true` means the board was saved. It does not mean a container is up, and `get_swarm` does not look at `~/.hornet-swarm/KILL`.

Keep `ready` as the board flag. Add two fields to the swarm view and to `hornet-swarm swarm --json`:

- `kill_switch`: true when the KILL file exists.
- `runners`: one entry per agent label with `label` and `healthy`. Healthy means `envStatus` has an endpoint for that label. A Docker error leaves `healthy: false` and does not throw away the rest of the view.

Do not put username, password, or TOTP secret in this view. Do not start containers from `readSwarm` or `saveSwarmBoard`.

Done when `swarm --json` for the fixture includes `kill_switch` and `runners`, the password string is absent, and a missing runner is `healthy: false` while `ready` can still be true.

## 3. A time limit must not look like a pass

`runSuite` sets one deadline from `max_run_duration_min` (schema default 30). When a later label reaches that deadline, the code pushes a duration report, sets `durationStop`, skips the earlier label's journeys, and breaks before the duration label is copied into `rich`. `foldRunStatus` never sees `durationStop`. Skipped journeys and a passed phase 1 then fold to `passed`. `publishParent` still sets the parent status to `duration`.

A duration abort also calls `stopRunners(project)`, which stops every runner in the project. Those containers have no restart policy, so the other labels stay down.

Change:

- Pass `durationStop` into the status fold. If the stop happened, the run status must not be `passed`. Keep the existing priority: fail, error, or flaky, then `rate_limited`, then blocked. A duration stop with no fail or rate limit is run status `blocked`. The parent status stays `duration`.
- Copy every label into `rich` before returning, including the label whose phase is the duration report. Journeys skipped because the deadline fired are `blocked` with `blocked_reason: 'duration'`, not a silent skip that folds to passed.
- On duration, stop only the label whose job was in flight. The kill switch still stops the whole project. Do not create the KILL file on a duration stop.
- `foldRunStatus` is the shipped function. Extend it rather than folding in a second copy.

Done when a unit test of the shipped `foldRunStatus` covers a passed phase 1, skipped journeys, and `durationStop`, and the result is `blocked`. A fixture run that hits the deadline still exits 2, leaves no KILL file, and has parent status `duration`. With two fixture runners up, a duration stop of `qa-user-1` leaves the `qa-user-2` container running. If Docker cannot start a second runner, record that and cover the stop-target with a unit test of the label filter instead of deleting containers to make room.

## 4. Abort the browser inside the container

The runner already has `POST /v1/abort`, which sets `abortRequested`. `execute` never calls it. On duration or kill it aborts the controller `fetch` and races `stopRunners` against two seconds.

`startControlGateway` in `packages/controller/src/egress-proxy.ts` pipes the client to the container and does not destroy that upstream request when the client disconnects. The runner's `clientGone` flag therefore stays false.

Change:

- Before aborting the `/v1/jobs` fetch, POST `/v1/abort` on that label's endpoint with a short timeout. Ignore a failed abort post and continue into the existing stop.
- In the control gateway, when the incoming request closes or aborts, destroy the upstream request.
- Keep the two-second race only as a backstop after the abort post. Do not return while the abort post is still the thing you skipped.

The proxy image must be rebuilt after the gateway change. The runner image must be rebuilt if runner source changes.

Done when a fixture duration run still returns parent status `duration` with `killed: false`, and a unit or gateway test shows a closed client destroys the upstream request. Do not point that test at a real site.

## 5. A stopped runner can be started, and a failure still has a packet

`execute` throws `No healthy runner for ${label}` when the endpoint is missing. The `runSuite` catch releases the lease and, when `run.json` is absent, deletes the run directory. The parent gets an exception and no packet. The same happens when the secret handoff throws.

`ensureRunner` starts a stopped container, but only `env up` and `env reset` call it. Do not call the full `ensureRunner` from a suite, because it force-removes a container when the image does not match.

Change:

- If the named container exists and is stopped, start it and wait for health once. If it is missing, running but unhealthy, or still down after that start, write a parent packet with run status `error` and then throw. Do not create a new container from the suite.
- On any throw after the run directory exists, write `run.json` and `latest-parent-report.json` before deleting anything. The packet status is `error`, `validation_required` is true, and the instruction stays the existing parent instruction. Delete the run directory only when both the packet and `run.json` could not be written.
- The packet and the error text must not contain a secret.

Done when a suite against a stopped fixture runner either starts that existing container and runs, or exits with a parent packet whose status is `error`. A missing container does not get created by the suite. The packet from a forced handoff failure does not contain the fixture password.

## 6. The lease lock must not outlive a dead process

`withLock` in `packages/controller/src/leases-store.ts` creates `leases.lock` with `mkdirSync` and deletes it only in `finally`. A crash in between makes every later acquire, release, and heartbeat wait 5 seconds and throw `Timed out waiting for the lease lock.` The directory stays. Nothing else in the repo removes it.

`readLeases` turns any read or parse error into `[]`, and the next acquire writes that empty list over `leases.json`. A torn file can grant a label that is already held.

A dead holder is still leased until `expiresAt`, default 30 minutes. There is no exit hook. That TTL reclaim can stay. Do not steal a live agent's label.

Change:

- Write the holder pid into the lock directory. If the pid is not running, remove the directory and take the lock. If the pid is running, keep the current wait and timeout.
- If `leases.json` cannot be parsed, throw and do not write a replacement. Leave the bytes on disk.
- On SIGTERM, release leases this process acquired. SIGKILL will not run that hook. Do not pretend that it does. The TTL remains the reclaim for a killed process.

Done when a unit test with a temporary home directory, not `~/.hornet-swarm` and not a rewritten `HOME`, creates a lock whose pid is dead and the next acquire succeeds, and a corrupt `leases.json` makes acquire throw while the file bytes stay unchanged. The existing lease e2e, including `agent_already_holds` and renewal, still passes.

## 7. Detect a second factor without solving it

`detectChallenge` in `packages/runner/src/job.ts` returns captcha for the text `verify you are human` or the HTML tokens `recaptcha`, `hcaptcha`, `turnstile`, or `arkose`. It returns 2fa only when `input[autocomplete="one-time-code"]` has a count above zero. That 2fa stop is skipped when the same journey has a `fill.totp` step. It does not look at SMS or email wording, or at a 6-digit field without that autocomplete attribute.

Keep the captcha rule. Do not add a bare HTTP 403 rule. Add a 2fa stop when either of these is true and the journey has no `fill.totp` step:

- The body text says a code was texted, emailed, or sent, and the page has a visible input that is not the password field.
- A visible input has `maxlength` of 6, or an autocomplete, name, or placeholder of a one-time code, and it is not the password field.

The fixture login page must still sign in. Add a fixture page `/sms` whose body says a code was texted and whose input is not `autocomplete="one-time-code"`. A journey that opens it exits 2 with `2fa`. The existing `/otp` and `/login?totp=1` behavior stays.

Done when the new fixture journey is `2fa`, the normal login journey still passes, and the captcha journey still exits 2. No test submits a code on `/sms`.

## 8. A proxy failure is not an allowlist block

A step error matching `allowlist`, `ERR_BLOCKED_BY_CLIENT`, `blockedbyclient`, or `ERR_TUNNEL_CONNECTION_FAILED` is stored as `blocked_reason: 'allowlist'`. `ERR_PROXY_CONNECTION_FAILED` and an HTTP 502 do not match.

Add `proxy` to the step `blocked_reason` enum. Classify `ERR_PROXY_CONNECTION_FAILED` and a proxy HTTP 502 as `proxy`. Leave the allowlist matches as `allowlist`. `foldRunStatus` already treats a blocked step as a blocked run. A `proxy` reason must take that blocked path and must not become `passed` or `rate_limited`.

Done when a unit test of the shipped classifier covers those two proxy failures and one real allowlist error, and the allowlist e2e still fails closed.

## 9. Redaction has to catch the forms the runner already has

`Redactor.register` lowercases only labels that end in `.username`. A lowercased password or `totp_secret` is not redacted. Derived forms shorter than 4 characters are dropped unless they are the original value, so a one-space secret does not redact the literal `%20`. Keep that short-form rule for ordinary derivations. Also keep the percent-encoding of an original secret when that encoding is the thing that would otherwise be dropped.

`validateJourneyDocument` rejects a known secret only inside `fill.value`. `screenshot.name` becomes the PNG filename with no check. The evidence scan looks at file bytes and zip-entry text, not entry names, so the name is copied into `evidence.zip` and `manifest.json`.

The runner registers `${label}.totp_code` before the job because `injectTotp` posts it first. Playwright then writes `network.har` and `trace.zip` with the raw code. Nothing rewrites the HAR through that redactor. The controller redactor used by `redactTree` and `scanTree` registers username, password, and `totp_secret` only.

Change:

- Register a lowercased password and `totp_secret` the same way as a username. Keep percent-encodings of an original value even when they are shorter than 4 characters. Do not keep every other short derivation.
- Reject `screenshot.name` when it contains a known secret of length at least 1, with the same error style as a pasted password. The error text must not include the secret.
- After `context.close` in the runner, if `network.har` exists, rewrite it through the job redactor before returning. That redactor already has the TOTP code.
- Have `injectTotp` hand the code back in memory. Register it on the controller redactor before `redactTree`, `scanTree`, and `publishParent`. Do not write the code into `run.json`, the job report, the audit log, or the parent packet.
- If a trace still contains the code, the scan quarantines that file and section 10 keeps it out of the parent packet.

Done when a unit test shows a lowercased password and the percent-encoding of a one-space secret are redacted, a journey whose screenshot name contains the fixture secret is rejected with exit 3 and the secret is absent from the output, and the TOTP fixture journey's `network.har` does not contain the 6-digit code. The assertion failure must say that the code was still present. It must not print the code or the HAR body.

## 10. A withheld packet must not point at the files

When the parent packet JSON matches `contains()`, `publishParent` sets `redaction_failure`, replaces the summary, sets analysis to `{ withheld: true }`, and sets `evidence_zip` to `''`. It leaves `screenshot_paths`, `trace_paths`, and `html_path` in place, and it does not delete the zip.

`quarantineFile` already unlinks a file and writes a `.quarantined` marker.

Change: on that hit, quarantine the evidence zip and any screenshot, trace, or HTML file that still contains a secret, and clear `screenshot_paths`, `trace_paths`, and `html_path` as well as `evidence_zip`. A path that survives in the packet must point at a file that no longer contains a registered secret. Do not delete a clean artifact only because a different file failed.

Done when a unit or fixture case that forces a secret into the packet JSON ends with status `redaction_failure`, empty evidence and artifact paths, and the zip file either gone or replaced by the quarantine marker.

## 11. The summary and JUnit must match the run

`summaryMarkdown` sets `isolationFailed` when a journey name contains `denied` and the status is not `pass` or `skipped`. That branch is chosen before the captcha and 2FA paragraphs. A blocked captcha on a journey with that name is reported as a cross-account opening.

`junitXml` writes a failure element only for `fail`, `flaky`, or `error`. A `blocked` step is a passing testcase.

Change:

- Report the cross-account sentence only when that journey's status is `fail`. A `blocked` journey, including captcha, 2FA, duration, or allowlist, uses the existing blocked paragraphs.
- A `blocked` step writes a JUnit failure element. `skipped` stays without one.

Done when a unit test with a blocked journey named like the tenant-isolation journey returns the human-check sentence, a failed journey with that name still returns the cross-account sentence, and a blocked step's JUnit contains `<failure`.

## 12. MCP can release the kill switch

The MCP kill tool calls `engageKill` and `stopRunners`. It never calls `releaseKill`. Only CLI `kill --release` deletes the KILL file. A parent that sees `kill_switch: true` cannot clear it through MCP.

Add `release: true` on that tool. When it is set, call `releaseKill` and do not engage the switch or stop runners. When it is omitted, keep today's engage behavior.

Done when an MCP call with `release: true` removes a KILL file that the test created, and a call with `kill: true` still creates it.

## Verification

Rebuild `dist` before e2e. After gateway or runner edits, run `scripts/build-image.sh`. Then run one healthy fixture runner. If a second runner is required for the duration test and Docker cannot start it, keep the unit coverage from section 3 and do not delete `aegis-*` containers.

From this repo:

- `pnpm test`
- `pnpm typecheck`
- The named fixture e2e set: `leases`, `redaction`, `policy`, `suite-reports`, `mcp`, `swarm-board`, `unattended`, and `rate-limit`, plus the new cases from this plan.

Seed the fixture before the login tests. Stop it afterward. Leave the old `aegis-*` containers running. Leave `creds serve` running if it is already up.

A green run is unit tests, typecheck, and that e2e set passing. The new assertions above must be among those tests, not only a manual note.

## Operator duties, not code

Do not implement these. A night run still needs all of them:

- The Mac stays awake, Docker Desktop stays running, and the login keychain stays readable. Secret decrypt calls `security find-generic-password`.
- The parent Grok session stays open and passes a distinct `agent_id` and one label per sub-agent.
- The board, authorisation, selectors, and journeys are already saved. The setup page still requires Touch ID. `creds add` does not, and that stays.
- A production-looking host still needs an authorisation that includes production. `confirm_production` does not replace that check.
- The harness will not solve a captcha or an SMS code. It will stop.
- There is no night daemon. A default suite still stops at `max_run_duration_min`.
