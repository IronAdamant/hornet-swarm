# Hornet Swarm

Hornet Swarm is a local tool for checking websites you own, or websites someone has authorised you in writing to test. It runs a small browser inside one container per test account. You talk to it from the `hornet-swarm` command, or from an AI agent through the MCP server.

It is not a load tester, and it does not try to break into sites. If a page asks for a human check or a second code, Hornet Swarm stops and tells you.

## What you need

- macOS on Apple Silicon
- Node.js 22
- pnpm 9
- Docker Desktop (or another engine that speaks the Docker API, such as OrbStack)
- `sops` and `age` (`brew install sops age`)
- `tesseract` so screenshots can be checked for leaked passwords (`brew install tesseract`)

## Set up

1. Install the workspace and build it:

```bash
pnpm install
pnpm build
pnpm image
```

2. Check the machine:

```bash
pnpm hornet-swarm doctor
```

Doctor also says whether system sleep can freeze a long run. Closing a MacBook lid sleeps it whatever that setting says, unless it is in clamshell mode.

The age private key is created in the macOS Keychain the first time Hornet Swarm stores a password. The Keychain item is named `hornet-swarm-age-key`. An existing item named `aegis-age-key` still unlocks the store. The private key is not written into the project. It is read once per process and kept in memory until that process exits, so a screen lock after the first read does not stop the next account. A new key is created only when the Keychain says no item exists. A locked keychain or a damaged item stops with an error and leaves the Keychain alone. On Linux CI, set `SOPS_AGE_KEY` for that job only.

3. Add an authorisation file that names the domains you are allowed to test, then point a project at your local fixture or your own site. The checked-in examples are templates. Do not run them against a live site from this repo's tests. The offline fixture is `test/fixture-app`:

```bash
pnpm --filter @hornet-swarm/fixture-app start
node test/e2e/prepare-fixture.mjs
pnpm hornet-swarm env up --project fixture --count 1
```

4. Run the sample checks:

```bash
pnpm hornet-swarm suite --project fixture \
  --journey examples/journeys/consistencyhub/01-signin-dashboard.journey.yaml \
  --journey examples/journeys/consistencyhub/02-tenant-isolation.journey.yaml
```

Reports land in `~/.hornet-swarm/runs/<run id>/`. `summary.md` is the short version for a person. `analysis.json` is the detailed version for an agent. Its `suspected_cause` and `repro_steps` name the first real problem, step by step. Its `confidence` says how directly that evidence names the cause: high for a known stop such as a kill or a captcha, fairly high for one failed assertion, lower for a crash or several unrelated failures, and lowest for a check that passed only on a retry.

Runs older than `results_retention_days` in `~/.hornet-swarm/config.yaml` (30 by default) are removed when the next run starts.

## Practice sites

Two public sites exist for test-automation practice, and the repo ships projects for both:

- **The Internet** (`the-internet.herokuapp.com`): one published login, a secure area, a delayed page, and status codes. Two labels share the login.
- **Sauce Demo** (`www.saucedemo.com`): six published accounts that each misbehave on purpose, one label each. `standard_user` works, `problem_user` and `error_user` break checkout, `performance_glitch_user` is slow, `visual_user` looks different, and `locked_out_user` is refused.

```bash
pnpm build
node scripts/setup-practice.mjs the-internet     # or saucedemo
pnpm hornet-swarm env up --project the-internet
pnpm hornet-swarm suite --project the-internet
pnpm hornet-swarm stats --project the-internet
```

The script installs a `public_practice` authorisation, the project, its journeys, and a swarm board with a personality and rules for each label, and it stores the published logins in the encrypted store. It reads each site's password from that site's own login page at install time, so no password is kept in this repo. If the page has changed, it asks for the password, or reads `HORNET_PRACTICE_PASSWORD`. It saves a dated copy of the page where each site says it is for practice as the authorisation's document. A `public_practice` authorisation needs that statement, refuses chaos and access-control probing, and caps a run at 10 requests a second in total, 5 per runner, and 6 runners. Other people use these sites too.

The first live run, on 12 October 2026, found that The Internet's HTTP/2 endpoint stalls when several files load at once over one connection, about one page load in three. `curl --http2` reproduces it with no Hornet Swarm involved. Its project sets `runners.http2: false` so the journeys run over HTTP/1.1. Set it to `true` to measure the stall.

## Everyday commands

- `hornet-swarm env up --count 10` starts the default fleet.
- `hornet-swarm env reset` recreates the containers. `hornet-swarm env reset --hard` also rebuilds the runner and proxy images and the project network.
- `hornet-swarm env status` shows health.
- `hornet-swarm kill` stops a live run. `hornet-swarm kill --release` lets new runs start.
- `hornet-swarm creds serve` opens the private login page on `127.0.0.1`.
- `hornet-swarm creds add <project> <label>` asks for a username and password without showing the password.
- `hornet-swarm export-evidence <run id> --project <id> --out proof.zip` packs the proof for one run.
- `hornet-swarm accept-baseline <run id> --project <id>` saves the current screenshots as the comparison point.
- `hornet-swarm stats --project <id>` shows how reliable the site has been over recent runs: pass rate, p50 and p95 timings, retries, and failing streaks, per journey and for sign-in. `--last <n>` picks how many runs. `--json` prints the same for an agent.
- `hornet-swarm cleanup --days <n>` removes old runs now.

Ctrl-C, closing the terminal, and `kill <pid>` release the login a CLI run holds. Only `kill -9` leaves it until its 30 minute lease runs out.

A macOS Shortcut can run `hornet-swarm kill` if you want a keyboard stop. Hornet Swarm does not register a global hotkey itself.

## Agents

Open `http://127.0.0.1:7781/setup` to keep the website and up to ten logins. Start that page with `hornet-swarm creds serve` if it is not already open. Fill the website first, then the cards in order: username, password, a personality, and rules for that sub-agent. A personality is who the sub-agent plays. Rules are what it must and must not do. Press Ready and confirm with Touch ID. The passwords stay in the encrypted store. The page only answers on `127.0.0.1`, and the form carries a token, so another site open in your browser cannot submit it.

After Ready, `hornet-swarm swarm --json` and the MCP tool `get_swarm` show the website, the labels, each label's personality and rules, and its latest notes. They do not show passwords. Each label is one sub-agent and one browser. The browser inside the container is full Chromium on a virtual screen, the same browser a person would use, rather than headless Chromium.

Start the MCP server with `hornet-swarm-mcp` (the built file is `packages/mcp-server/dist/main.js`). Agents see labels such as `qa-user-1`. They never receive passwords. When a login is missing, the agent calls `request_credentials` and you type it on the local page or with `hornet-swarm creds add`.

### Agent ids

Each MCP connection has its own agent id. When a parent runs several sub-agents over one connection, it calls `register_agent` once per sub-agent and passes that id as `agent_id` on every call. One agent id holds one test login at a time. An id from another connection is refused.

### Notes

`add_agent_note` keeps a note for a label, such as something the sub-agent learned about the site. Notes are redacted before they are saved, the last 50 are kept per label, and `get_swarm` shows the latest ten. `get_agent_notes` reads them all. A label another agent holds right now cannot be written to.

### Journeys an agent writes

`run_journey` takes `journey_id` for a saved journey, or `journey_yaml` for one the agent wrote. A written journey gets the same checks as any other: allowed sites only, passive third parties cannot be filled or navigated, no literal password, and credentials only by handle such as `qa-user-1.password`. It is saved under `~/.hornet-swarm/projects/<id>/agent-journeys/` and cannot replace a project journey with the same id. This is still a scripted journey. There is no free-roaming browser.

### What agents cannot do

Any agent can engage the kill switch with `reset_environment` and `kill: true`. Only you can release it, with `hornet-swarm kill --release`. A reset is refused while another agent holds a login, and a hard reset (an image rebuild) is CLI-only.

### Reliability

`get_reliability` returns the same figures as `hornet-swarm stats`.

### Claude Code

`.mcp.json` registers the MCP server as `hornet-swarm` when Claude Code starts in this repo. `.claude/agents/hornet-swarm-tester.md` is a sub-agent for one label, so a Claude parent can spawn one per label. The playbook for any parent, Grok or Claude, is `docs/agents.md`.

### One journey for many accounts

In a journey, `credential: "self.password"` and `fill: { totp: self }` mean the label running it. A journey that lists several users can then sign each of them in with their own login.

## How checks wait

A page is checked the way a person would see it.

- `wait: { for: navigation }` waits for the page to navigate after the last action, including a single-page app that changes the URL with `history.pushState`. A login that renders in place without changing the URL ends the wait once the network has been quiet for half a second.
- `url_contains` and `text_visible` retry for up to 10 seconds, like `selector_visible`. `access_denied` retries for up to 5 seconds. `selector_absent` waits for the network to go quiet (up to 3 seconds) first, so content that renders late is still seen.
- `http_status` and `access_denied` read the status of the last page load, whether a `navigate` step or a click caused it.
- A failed step records the page's own visible error text, such as `(page said: "Sorry, this user has been locked out.")`.
- `runners.http2: false` makes the browser use HTTP/1.1, for a site whose HTTP/2 is known to stall.

Requests are paced, not dropped. Each runner may send `limits.request_burst_per_runner` requests at once (20 by default), then `limits.max_requests_per_second_per_runner` per second. A busy page loads slower. It does not load broken. The egress proxy queues requests over `max_requests_per_second_total` the same way. A run is `rate_limited` only when the site itself answers 429 or 503 to more than one request in ten.

A captcha stops the journey only when a person could see it: a visible widget or challenge frame, or the words "verify you are human". Invisible reCAPTCHA v3, the reCAPTCHA badge, and a Turnstile script that never shows a widget are ignored. A second-code prompt needs a one-time-code field, a field named for a code, or wording that a code was sent. A postcode, promo code, or other short field is not a second code. A texted or emailed code waits for you on the local code page for up to `auth.operator_code_wait_sec` seconds (600 by default), and never past the run deadline.

A runner that is missing or crashes becomes an error for that account only. The other accounts keep their results. A run where every account hit such an error is `error`, not `failed`, because the harness broke, not the site.

A failed journey is copied to `~/.hornet-swarm/regressions/<project>/` and joins later `suite` runs until it passes three times in a row. Then the copy is removed and the ledger stays. A single `journey` or `run_journey` call does not add it.

## Runner output folders

Each runner writes screenshots, traces, and network logs under `~/.hornet-swarm/runners/<project>/<label>`. That folder is mode `0700`. The owner is the user who starts Hornet Swarm, and the group is that user's group.

Docker Desktop on this Mac shows the folder to the container as root, and the runner user (uid 10001) can still write there. The files come back owned by the user who started Hornet Swarm, so the controller can read them. Mode `0700` is enough for that. A group shared with the container would let more accounts in, and it is not required.

If that folder already exists and other accounts can open it, startup stops and names the folder. Hornet Swarm does not change its mode.

After each job the files are moved into the run folder, so nothing unredacted stays in the runner folder. Links written by a runner are not followed. Each runner sees only its own control token, read-only. The egress proxy allows only the exact host and port pairs of the project's origins, plus the credential page port on this Mac.

## Tests

```bash
pnpm test
pnpm test:e2e
```

`pnpm test` is the unit suite. `pnpm test:e2e` is the end-to-end suite. Both use the offline fixture only. Do not point them at a live site.

End-to-end tests need Docker or OrbStack, sops, age, and tesseract on this Mac. GitHub Actions runs build, lint, and unit tests on Linux for every push and pull request (`.github/workflows/ci.yml`). That Linux job does not run `pnpm test:e2e`. GitHub-hosted macOS runners do not provide Docker or OrbStack, so the end-to-end command stays manual:

```bash
pnpm test:e2e
```

The Linux job also runs `pnpm test:coverage`. That command fails the check when redactor or policy coverage drops below the gate in `vitest.config.ts`.

The fixture includes pages shaped like a real site: a single-page app sign-in, a page with 65 resources and invisible captcha scripts, and a site that answers 429. The fixture password contains a space, an apostrophe, parentheses, `!`, and `~`, which an HTML form encodes differently from `encodeURIComponent`.

On 12 October 2026 this Mac ran both commands against the offline fixture only.

`pnpm test` exited 0. 21 files passed and 119 tests passed.

`pnpm test:e2e` exited 0. 17 files passed and 47 tests passed.

The same day, live runs on the two practice sites gave the results each site is built to give. The Internet: both accounts signed in and all four journeys passed. Sauce Demo: `standard_user`, `performance_glitch_user` (8.4 s sign-ins), and `visual_user` passed checkout; `problem_user` failed at step 15 with the page saying "Error: Last Name is required"; `error_user` failed at step 17 because the order never completed; and `locked_out_user` was refused with "Sorry, this user has been locked out." A scan of every saved file, including traces, found no stored login in any encoding.
