# Goal: unattended swarm for Grok Build and Grok Bot

Implement this file in `/Users/aron/Documents/coding_projects/hornet-swarm`. Do the ten sections in order. Do not expand into a chat model, a free-roam browser agent, or a public release.

Verified against the source on 2026-10-11 by deep-research-5 (control plane), deep-research-6 (runtime), and deep-research-7 (policy, redaction, reports). The gaps below were still present. Three wordings from those passes are already corrected in this file: Playwright adds its own default launch args, a chaos drop does not increment `blockedRequests`, and suite status prefers `failed` over `blocked`.

## Ready means

A Grok Build session or a Grok Bot parent reads `get_swarm`, gives each sub-agent one label, that label's personality, and the website, and tells it the task. Each sub-agent calls the run tools with its own agent id and only its label. The harness signs that account in, runs the journey, and returns a redacted report packet. The parent judges that packet. The harness does not grade the site's AI replies and does not contain a chat model.

## Do not

- Edit `/Users/aron/Documents/coding_projects/QA Swarm Tester spec` except to read `SPEC.md`.
- Open `staging.consistencyhub.app` or any other real site. Test only the offline fixture.
- Push, or change the GitHub repo `IronAdamant/hornet-swarm` from private to public.
- Change git config. If you commit, use `git -c user.name="Aron Amos" -c user.email="aron.amos@ironadamant.com"` before the subcommand. Do not commit this goal file.
- Delete the Keychain item `aegis-age-key`, or any Docker volume whose name starts with `aegis-profile-` or `hornet-swarm-profile-`.
- Stop or remove the old `aegis-*` containers. A new `env up` creates `hornet-swarm-*` containers beside them.
- Rename `AEGIS_*` environment variables. The runner image reads them.
- Solve a CAPTCHA or a non-TOTP second factor.
- Weaken the existing lease e2e assertion that a second label returns `agent_already_holds`.
- Put a password, TOTP secret, or age key in a report, a tool result, a log, or this goal's notes.

The fixture on port 4173 is down. Start `test/fixture-app/server.js` from this repo, bound so Docker can reach it, before any e2e test that needs it. Stop it when the tests are finished if you started it.

Rebuild package `dist` after source edits. E2E imports `packages/*/dist`.

## 1. One agent id per sub-agent

`packages/mcp-server/src/main.ts`: `run_signin_check`, `run_journey`, and `run_suite` call `runSuite` with `agentId: 'mcp'`. `acquire_test_user` and `release_test_user` already require `agent_id` and pass it to `acquireLease` and `releaseStoredLease`.

Add optional `agent_id` to those three run tools and pass it through. When it is omitted, keep `mcp` so current tests stay valid. A swarm passes a different id per sub-agent.

`packages/controller/src/suite.ts` already uses `request.agentId ?? process.env.AEGIS_AGENT_ID ?? cli-${process.pid}`. The CLI suite action in `packages/cli/src/main.ts` does not pass `agentId`. Add `--agent-id` on the suite, sign-in, and journey commands and pass that value.

`decideAcquire` in `packages/core/src/lease.ts` returns `agent_already_holds` when that agent already holds a different label in the same project. Keep that. One id holds one label at a time.

Done when two overlapping calls with different agent ids and different labels both acquire, and a second label for the same id is refused. Cover that with an e2e test on the fixture.

## 2. Keep the lease alive, and stop at the run limit

`hold()` runs one label and calls `releaseStoredLease` in `finally`. The second loop does not hold every label again. It holds only when the run is not killed, that user's phase 1 passed, the gate allows it, and that user has journeys.

`limits.max_parallel_runners` is written by `saveSwarmBoard` and never read by `runSuite`. Leave a single suite process at one label at a time. Parallelism is many CLI processes or many MCP calls, each with its own agent id and one label. `env up` must already have one healthy runner per label. Do not make one suite call hold two labels at once.

`heartbeatStoredLease` is defined in `packages/controller/src/leases-store.ts` and re-exported from `packages/controller/src/index.ts`. Nothing else calls it. While a hold is in progress, call it on an interval well under 30 minutes, and once more just before release. Audit the renewal with no secrets.

`max_run_duration_min` is `z.number().positive().default(30)` on `projectSchema.limits` in `packages/core/src/schemas.ts`. Suite, swarm, env, the proxy, and totp never read it. Enforce it from the start of `runSuite`. When it expires, abort that run the same way the `KILL` file aborts a job, with a status the parent can tell apart from a kill, and release the lease.

Done when a fixture run that lasts past a short test TTL stays the sole holder of that label, and a run past `max_run_duration_min` stops and releases.

## 3. Prepare a real site without reusing the fixture form

`saveSwarmBoard` in `packages/controller/src/swarm.ts` requires an existing `project.yaml` and an authorisation whose domains cover the hostname. It stores at most ten `qa-user-N` cards, writes `vars.personality`, sets `base_url` and `allowed_origins`, and sets `runners.count` and `max_parallel_runners` to the card count. It does not write selectors or an authorisation, and it does not start browsers.

Keep the authorisation rule. Do not invent a domain grant from the setup form.

Add fields to `http://127.0.0.1:7781/setup` for the username selector, the password selector, the submit selector, and the success check. Persist them on `project.auth.selectors` and `project.auth.success`. The fixture values may prefill the form: `#email`, `#password`, `role=button[name='Sign in']`, and a success check for `/dashboard`. Saving a host other than the fixture host while those fixture selectors are unchanged must be refused.

`creds add` on a non-TTY already stores a login and returns `{ok:true, label, status:'ready'}` with no password. That stays the unattended preload. Ready may keep Touch ID for a person at the Mac. An agent that finds `swarm.json` with `ready: true` and stored labels must not call `request_credentials` and must not wait on Touch ID.

`get_swarm` and `hornet-swarm swarm --json` stay the parent view: website, labels, personalities, ready. No username, password, or TOTP secret.

Done when a fixture e2e saves a board through `saveSwarmBoard`, a run uses the saved selectors, and an unauthorised host is still refused.

## 4. Open the site from inside Docker

`containerTarget` in `suite.ts` rewrites a base hostname to `host.docker.internal` only when it is exactly `localhost` or `127.0.0.1`. Other allowed origins are not rewritten. `saveSwarmBoard` adds a `host.docker.internal` origin only for those two names.

Also rewrite `::1`, and any address that belongs to this Mac (`os.networkInterfaces`), to `host.docker.internal`, and add that origin to the runner allow list. Leave every other host alone, including another machine on the LAN and a public site.

`execute` sends `allowOrigins` from that target list and never includes `allowed_third_party`. `allowHostsFrom` in `packages/controller/src/env.ts` starts with `host.docker.internal` and `localhost`, then adds hostnames from both `allowed_origins` and `allowed_third_party`. Put the same third-party origins on the runner allow list. Passive third parties may be loaded. The journey validator must still refuse `navigate` and `fill` against a passive origin.

Done when the fixture on `127.0.0.1:4173` still loads through `host.docker.internal`, and a unit test shows a foreign LAN host is not rewritten.

## 5. An allowlist block is not a rate limit

In `packages/runner/src/job.ts`, after the steps, `requests >= 10 && blockedRequests / requests > 0.1` sets status and `blocked_reason` to `rate_limited` even when every step passed. There is no guard on the current status. Allowlist aborts increment `blockedRequests` and are not counted in `requests`. A chaos drop aborts with `failed` and does not increment that counter. The suite stores a runner status of `rate_limited` on the journey as `blocked`. If any phase or journey is fail, error, or flaky, the run status is `failed` and the blocked branch is not reached.

Count only token-bucket refusals and HTTP 429 or 503 toward `rate_limited`. An allowlist abort stays `allowlist` and must not flip a passed job. A top-level navigation off the list still fails that step as allowlist. Spec section 5.3 is the rate rule: per runner, per user, and total, with 429 or a stop above 10 percent errors over 10 or more requests.

Done when a fixture journey that passes, plus extra aborted off-list requests, stays `passed`, and a fixture journey that trips the request bucket still reports `rate_limited`.

## 6. Sign-in, TOTP, captcha, and double-click

Phase 1 steps are navigate to the sign-in URL, credential fills for username and password, a submit click, a navigation wait, and success asserts. There is no `fill.totp`. `execute` calls `injectTotp` when `project.auth.totp.enabled`. `packages/controller/src/totp.ts` only returns a padded 6-digit HMAC code.

`detectChallenge` returns `captcha` only when the body text includes `verify you are human` or the HTML matches `recaptcha`, `hcaptcha`, `turnstile`, or `arkose`. If any secret handle ends with `.totp_code` it then returns undefined. Otherwise it returns `2fa` only when `input[autocomplete="one-time-code"]` has a count greater than zero.

`applyChaos` records every action. The `double-click` branch only pushes `double-click:armed`. It never clicks.

When TOTP is enabled for the project and that user has `totp_secret`, add a `fill.totp` step to phase 1 after the password and before submit. If TOTP is enabled and the secret is missing, stop that user. Do not skip 2FA detection because a TOTP code was injected. An SMS or email prompt still stops that user with `blocked_reason: '2fa'`. Do not solve either check.

Make double-click call Playwright's double click, and record that it happened.

Done with the existing fixture journeys for captcha, otp, and totp, plus a chaos seed test that sees two clicks.

## 7. Production names and short secrets

`isProductionLooking` in `packages/core/src/policy.ts` returns false for a local host or a `.localhost` suffix, then for a host that starts with `10.`, `192.168.`, or `172.16.` through `172.31.` followed by a dot, and otherwise when the unanchored pattern `staging|test|qa|dev|localhost` matches. `10.prod.example` and `dev.prod.example` are therefore not production-looking.

`productionGate` builds its host list only from `base_url` and `allowed_origins`. It never reads `allowed_third_party`. `chaosPermitted(auth, project)` does not read `confirmProduction`, `allowed_origins`, or `allowed_third_party`. It checks the chaos activity, `project.environment`, and `isProductionLooking` on `base_url` only.

Match `staging`, `test`, `qa`, `dev`, and `localhost` on labels split by dots and hyphens. `dev.example.com` and `my-dev.example.com` stay non-production. `device.example.com` and `contest.example.com` are production-looking. Treat RFC1918 only when the host is a dotted IPv4 address in those ranges, not when a DNS name starts with those characters. Run `productionGate` and `chaosPermitted` over the base host, allowed origins, and non-passive third parties. Update `test/unit/policy.test.ts`. Do not run the consistencyhub example against the network. Its CDN and auth hosts sit outside the owner domains, and `productionGate` currently never sees them.

`validateJourneyDocument` records `literal value matches a stored secret` only when `step.fill.value` is truthy and a known secret of length at least 4 is a substring. `Redactor.register` returns immediately on an empty value and drops every derived form shorter than 4 characters. Keep the original secret even when it is shorter than 4. Still drop derived forms shorter than 4. Reject a journey fill that contains any known secret of length at least 1.

The object keys `value`, `password`, `secret`, and `totp_secret` are replaced with `[REDACTED:field]` by case-sensitive comparison. Leave that as it is.

Done when unit tests cover `device.example.com`, a real `10.x` address, a three-character password in a report, and a journey that pastes that password.

## 8. Rebuild the runner image from current source

`images/runner/build/main.js` still masks `data-aegis-secret` and logs `aegis-runner listening`. `packages/runner/src/job.ts` and `main.ts` use `data-hornet-swarm-secret` and log `hornet-swarm-runner listening`. `scripts/build-image.sh` esbuilds `packages/runner/src/main.ts` to `images/runner/build/main.js`. The Dockerfile copies that bundle to `/opt/runner/main.js`.

`images/runner/entrypoint.sh` starts `Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp`, waits for `/tmp/.X99-lock`, exports `DISPLAY=:99`, and execs the bundle. Nothing forwards that display to the Mac. Leave the window inside the container. The parent uses screenshots.

`browserLaunchOptions` is `headless: false` with `--no-sandbox`, `--disable-dev-shm-usage`, and `--disable-gpu`. Playwright also adds its own default arguments because `ignoreDefaultArgs` is not set. Do not set `ignoreDefaultArgs`.

Run `scripts/build-image.sh` so `hornet-swarm-runner:local` and `hornet-swarm-proxy:local` match this source. Do not delete the old `aegis-*` images if something is still running on them.

Done when the new image's bundle contains `data-hornet-swarm-secret` and a one-runner fixture probe returns ok.

## 9. HTML report matches the spec

`htmlReport` in `packages/report/src/render.ts` renders a redaction PASS/FAIL banner, a Sydney timestamp, the summary, and a table of Account, Sign-in, and Checks. Spec section 11 requires the data-isolation matrix and links to traces and screenshots, with Australia/Sydney `AEDT` or `AEST` plus the ISO time.

`applyBaselines` in `suite.ts` assigns `step.diff` with visual, timing, text set to `same`, console, network, and notes. `visual_mismatch_ratio` is added only when the step screenshot and `baselines/<project>/<journey>/<index>.png` both exist and are compared. `buildAnalysis` copies an existing diff. `analysisMarkdown` prints visual, timing, text, console, and network. `htmlReport` does not render the diff.

Add the matrix and working links to the screenshots and traces that exist for the run. Keep `Redaction: PASS` or `Redaction: FAIL`. Do not embed a secret in the HTML.

## 10. Hand the finished report to the parent

Do this last. It applies to every `run_signin_check`, `run_journey`, and `run_suite`, on the CLI and on MCP.

`runSuite` writes `run.json`, `summary.md`, `analysis.json`, `analysis.md`, `report.html`, and `junit.xml` under the run directory, then returns the `RunResult`. CLI without `--json` prints the status. CLI `--json` prints the `RunResult`. MCP returns that object. `export-evidence` writes a zip of the run directory plus `manifest.json` only when the caller passes `--out`, and only after a redaction scan. `get_results` reads one of `summary.md`, `junit.xml`, `analysis.json`, or `run.json` when the caller passes a run id. Summary is chosen before the other formats. `detail: full` beats `format: junit`. Nothing pushes those files to the parent.

After the report files are written and the redaction scan has passed:

- Call the existing evidence export for that run id to `~/.hornet-swarm/runs/<run_id>/evidence.zip`. The parent must not have to pass `--out`. If the scan fails, keep today's `redaction_failure` behavior, quarantine the artifact, and do not put secret text in the packet.
- Write `~/.hornet-swarm/projects/<project>/latest-parent-report.json` with `validation_required: true`, `run_id`, `project`, `status`, the `summary.md` text, the redacted analysis, the evidence zip path, the HTML path, and the screenshot and trace paths. No password, TOTP secret, age key, or raw secret form.
- Return that same object from the MCP tool and from CLI `--json`, together with the `RunResult`. The first lines of the human CLI output must say the parent has to validate this run, and must print the run id and the path of `latest-parent-report.json`.
- `get_results` with a project and no run id returns that latest packet. A run id still returns that run.
- Store this instruction in the JSON: the parent Grok Build session or Grok Bot reads this packet, checks it against the task, and only then tells the owner the outcome. The harness does not grade a site's AI replies.

Done when a fixture suite's MCP result and `latest-parent-report.json` contain the summary and the zip path, a scan of both shows no fixture password, and `get_results` without a run id returns that packet.

## Finish

Run the unit tests and the fixture e2e tests that cover leases, the swarm board, redaction, policy, captcha, otp, totp, and the new parent packet. `pnpm typecheck` must pass. Rebuild `dist` before e2e. Leave the GitHub repo private. Do not push.
