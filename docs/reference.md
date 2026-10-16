# Reference

The full manual: setup, the practice sites and labs, every command, how agents work with the swarm, and how checks wait. The [README](../README.md) is the short version.

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

The age private key is created in the macOS Keychain the first time Hornet Swarm stores a password. The Keychain item is named `hornet-swarm-age-key`. An existing item named `aegis-age-key` still unlocks the store. The private key is not written into the project. It is read once per process and kept in memory until that process exits, so a screen lock after the first read does not stop the next account. A new key is created only when the Keychain says no item exists. A locked keychain or a damaged item stops with an error and leaves the Keychain alone. A new key is handed to `security` on its standard input, never as a command argument, so `ps` never shows it. Only the `security` tool can read the item without asking. An item created by an earlier version lets any app read it. To tighten it without losing the key, open the item in Keychain Access, choose Access Control, select "Confirm before allowing access", and remove every app from the list except `security`. Do not delete the item: the stores encrypted with it cannot be read without it. On Linux CI, set `SOPS_AGE_KEY` for that job only.

3. Add an authorisation file that names the domains you are allowed to test, then point a project at your local fixture or your own site. An owner or contract authorisation names its signed document by path and sha256. A run stops when the file is missing or has changed. `hornet-swarm auth check <id>` says whether an authorisation is in force and prints its document's real hash. A relative document path is read from `~/.hornet-swarm/authorisations/`, and `~/` means your home folder.

   `activities` decides what a run may do. The sign-in check needs `signin_smoke` or `functional_e2e`. A journey needs `functional_e2e`. An access check needs `access_control_checks`. An access check is a journey with an `access_denied` assertion, an `http_status` assertion that expects 401 or 403, or the tag `access-control`. Chaos needs `chaos`. `exclusions` are written for people and agents. Hornet Swarm cannot check them itself, so `get_swarm` shows them to every sub-agent.

   The checked-in examples are templates. Do not run them against a live site from this repo's tests. The offline fixture is `test/fixture-app`:

```bash
pnpm --filter @hornet-swarm/fixture-app start
node test/e2e/prepare-fixture.mjs
pnpm hornet-swarm env up --project fixture --count 1
```

4. Run the sample checks:

```bash
pnpm hornet-swarm suite --project fixture \
  --journey examples/journeys/example-app/01-signin-dashboard.journey.yaml \
  --journey examples/journeys/example-app/02-tenant-isolation.journey.yaml
```

Reports land in `~/.hornet-swarm/runs/<run id>/`. `summary.md` is the short version for a person. `analysis.json` is the detailed version for an agent. Its `suspected_cause` and `repro_steps` name the first real problem, step by step. Its `confidence` says how directly that evidence names the cause: high for a known stop such as a kill or a captcha, fairly high for one failed assertion, lower for a crash or several unrelated failures, and lowest for a check that passed only on a retry.

Runs older than `results_retention_days` in `~/.hornet-swarm/config.yaml` (30 by default) are removed when the next run starts.

## Practice sites

One public site ships as a practice project:

- **The Internet** (`the-internet.herokuapp.com`): one published login, a secure area, a delayed page, and status codes. Two labels share the login.

```bash
pnpm build
node scripts/setup-practice.mjs the-internet
pnpm hornet-swarm env up --project the-internet
pnpm hornet-swarm suite --project the-internet
pnpm hornet-swarm stats --project the-internet
```

The script installs a `public_practice` authorisation, the project, its journeys, and a swarm board with a personality and rules for each label, and it stores the published login in the encrypted store. It reads the site's password from that site's own login page at install time, so no password is kept in this repo. If the page has changed, it asks for the password, or reads `HORNET_PRACTICE_PASSWORD`. It saves a dated copy of the page where the site says it is for practice as the authorisation's document. A `public_practice` authorisation needs that statement, refuses chaos and access-control probing, and caps a run at 10 requests a second in total, 5 per runner, and 6 runners working at once. Other people use this site too.

The first live run, on 12 October 2026, found that The Internet's HTTP/2 endpoint stalls when several files load at once over one connection, about one page load in three. `curl --http2` reproduces it with no Hornet Swarm involved. Its project sets `runners.http2: false` so the journeys run over HTTP/1.1. Set it to `true` to measure the stall.

## Local labs

Three testing-practice apps run in Docker on this Mac, for hard practice that touches no live service. Every port is bound to `127.0.0.1`.

- **Restful Booker** (`booker-lab`, http://127.0.0.1:3300): a bed-and-breakfast site with an admin panel. qa-user-3 is a guest and runs the guest journeys with `suite --user qa-user-3`. Its published admin password is a common word that its own pages also show, so redacting it would blank ordinary text. Its admin login is stored only when you set `HORNET_BOOKER_ADMIN_PASSWORD`.
- **ParaBank** (`parabank-lab`, http://127.0.0.1:8095/parabank/): Parasoft's demo online bank. Five made-up customers, each starting with $515.50. Their passwords are letters and digits, because ParaBank's Update Profile page cuts a password short at a `#`; qa-user-5 keeps a symbol so a journey shows that fault. `docs/sample-report-parabank-lab.md` is the write-up. The journeys check that money adds up: after opening an account, a transfer, and a bill payment, every balance and the total must match what moved. A new customer is signed up on each run, so the expected balances never drift.
- **OWASP Juice Shop** (`juice-shop-lab`, http://127.0.0.1:3010): the official image, v20.3.0. Five made-up customers. Routes sit after a `#`, such as `/#/login` and `/#/basket`. A fresh browser shows a welcome banner over the login button and a cookie notice, so `auth.prepare` closes both before the sign-in check types, and every journey closes them too. The customer feedback form asks for a captcha and is left out. The scoreboard and the challenge pages are out of scope. The write-ups are `docs/sample-report-juice-shop-lab.md`, `docs/accessibility-report-juice-shop-lab.md`, and `docs/security-report-juice-shop-lab.md`. `--reset` replaces the Juice Shop container, because its database lives inside it and a plain restart would keep the data.

```bash
pnpm build
node scripts/setup-lab.mjs                       # --reset wipes the labs back to their seed data
pnpm hornet-swarm env up --project juice-shop-lab      # --count n keeps n runners; without it, the project's runners.count
pnpm hornet-swarm suite --project juice-shop-lab
pnpm hornet-swarm suite --project juice-shop-lab --chaos default --seed lab-1
pnpm hornet-swarm stats --project juice-shop-lab         # chaos runs are left out; add --chaos to see them alone
```

The script starts `labs/docker-compose.yml` and writes an `owner` authorisation (`lab-owner`) that covers this Mac only, for 90 days. It allows sign-in checks, functional journeys, chaos, and access-control checks. The access-control journey reads ParaBank's Admin Page and does not press Initialize, Clean, or JMS. It signs up the made-up ParaBank and Juice Shop customers through each app's own form and stores every login in the encrypted store. No password is kept in this repo or printed.

## Everyday commands

- `hornet-swarm env up --count 10` starts the default fleet.
- `hornet-swarm env reset` recreates the containers. `hornet-swarm env reset --hard` also rebuilds the runner and proxy images and the project network.
- `hornet-swarm env status` shows health.
- `hornet-swarm kill` stops a live run. `hornet-swarm kill --release` lets new runs start.
- `hornet-swarm creds serve` opens the private login page on `127.0.0.1`.
- `hornet-swarm creds add <project> <label>` asks for a username and password without showing the password.
- `hornet-swarm export-evidence <run id> --project <id> --out proof.zip` packs the proof for one run.
- `hornet-swarm findings <file> [--out report.md]` checks a report's findings (YAML or JSON: `project`, then `findings` with `id`, `severity`, `title`, `claim`, and `evidence`) against the saved runs. It prints them with how often each happened, or lists the evidence that is missing and exits 3.
- `hornet-swarm accept-baseline <run id> --project <id>` saves the current screenshots, and the words on each screenshotted page, as the comparison point. Each label has its own baseline, because some accounts are meant to look different.
- `hornet-swarm auth check <id>` checks an authorisation and its signed document.
- `hornet-swarm stats --project <id>` shows how reliable the site has been over recent runs: pass rate, p50 and p95 timings, retries, and failing streaks, per journey and for sign-in. `--last <n>` picks how many runs. `--json` prints the same for an agent.
- `hornet-swarm cleanup --days <n>` removes old runs now.
- `hornet-swarm inspect --project <id> --user <label> --url <path>` maps one page for writing a journey: headings, fields, buttons, and links, each with a selector. `--guest` skips signing in. `--json` prints the whole map, with the page's visible words and a screenshot path.

Ctrl-C, closing the terminal, and `kill <pid>` release the login a CLI run holds. Only `kill -9` leaves it until its 30 minute lease runs out.

A macOS Shortcut can run `hornet-swarm kill` if you want a keyboard stop. Hornet Swarm does not register a global hotkey itself.

## Agents

Open `http://127.0.0.1:7781/setup` to keep the website and up to ten logins. Each card is its own label: card 3 is always `qa-user-3`. A card with a stored login keeps it when its username and password are left blank, so a personality or rule can be changed without typing every password again. Saving changes only the website, the login selectors, the first `url_contains` success check, the labels, and the runner counts in `project.yaml`. Comments and other settings stay. The allowed origins are kept while the website stays on the same origin. Start that page with `hornet-swarm creds serve` if it is not already open. Fill the website first, then the cards in order: username, password, a personality, and rules for that sub-agent. A personality is who the sub-agent plays. Rules are what it must and must not do. Press Ready and confirm with Touch ID. The passwords stay in the encrypted store. The page only answers on `127.0.0.1`, and the form carries a token, so another site open in your browser cannot submit it.

After Ready, `hornet-swarm swarm --json` and the MCP tool `get_swarm` show the website, the labels, each label's personality and rules, and its latest notes. They do not show passwords. Each label is one sub-agent and one browser. The browser inside the container is full Chromium on a virtual screen, the same browser a person would use, rather than headless Chromium.

Start the MCP server with `hornet-swarm-mcp` (the built file is `packages/mcp-server/dist/main.js`). Agents see labels such as `qa-user-1`. They never receive passwords. When a login is missing, the agent calls `request_credentials` and you type it on the local page or with `hornet-swarm creds add`.

### Agent ids

Each MCP connection has its own agent id. When a parent runs several sub-agents over one connection, it calls `register_agent` once per sub-agent and passes that id as `agent_id` on every call. One agent id holds one test login at a time. An id from another connection is refused.

### Notes

`add_agent_note` keeps a note for a label, such as something the sub-agent learned about the site. Notes are redacted before they are saved, the last 50 are kept per label, and `get_swarm` shows the latest ten. `get_agent_notes` reads them all. A label another agent holds right now cannot be written to.

### Inspecting a page

`inspect_page` opens one page as a label and returns a map of it: headings, links, buttons, and form fields, each with a selector a journey step accepts, the page's visible words, and a screenshot. `checked: true` means the selector matched exactly one element. A role selector such as `role=button[name="Sign in"]` is unchecked, because only the browser can resolve it. A selector prefers a test id (`data-test`, `data-testid`, `data-cy`, `data-qa`), then a stable id, then a `name` attribute, then the role and accessible name. Generated ids, such as `mat-input-12`, are never offered.

It runs as an ordinary single journey: the authorisation, the allowed sites, the pacing, and the hourly sign-in limit all apply. The journey signs in with the project's own sign-in when the label has a stored login (`sign_in: false` looks as a guest), opens the page, and reads it. It clicks and submits nothing on the page and never reads what a field holds. The journey is kept under `~/.hornet-swarm/projects/<id>/inspections/`, apart from the project's journeys, so a suite never runs it. For a single-page app that routes after a `#`, ask for `/#/checkout`, not `/checkout`.

The loop: inspect a page, draft the journey from the map, `validate_journey`, `run_journey`, and fix it from the failure clues.

### Journeys an agent writes

`run_journey` takes `journey_id` for a saved journey, or `journey_yaml` for one the agent wrote. A written journey gets the same checks as any other: allowed sites only, passive third parties cannot be filled or navigated, no literal password, and credentials only by handle such as `qa-user-1.password`. A navigate URL is checked after its `{{vars}}` are filled in. While a journey runs, the browser refuses to move its page to a passive origin, whether a step, a link, or a script tries. The journey stops there as `allowlist`. A passive origin can still load into a page, such as a font. A written journey is saved under `~/.hornet-swarm/projects/<id>/agent-journeys/` and cannot replace a project journey with the same id. This is still a scripted journey. There is no free-roaming browser. Agents name journeys and projects by id. A file path is refused.

### What agents cannot do

`limits.max_parallel_runners` caps how many logins can be held in a project at once. Each held login is one working runner. A run that finds every slot in use waits for one, up to its deadline. `acquire_test_user` answers `parallel_limit` with a `busy_until` time.

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
- A failed step quotes the page in brackets: its message or toast (`page said: "Your account is locked out."`), whether the control was disabled or what it reads (`it reads "Seach"`), the closest words to an expected text (`closest text on the page: "Releated items"`), and other error lines (`page also shows: "Error: missing checkout total"`). It also saves `failed-step-<n>.png` and `failed-step-<n>.txt`.
- Each `.txt` beside a screenshot holds the page's visible words, then `Form fields:` with what each field holds and `Disabled buttons:`. Dropdown options are left out of the visible words, so a choice such as "Error 12: Topic not found" is not mistaken for a message; the field line shows the option that was chosen. A page's text alone leaves out field values. Password fields are never read. The parent packet lists these files in `page_text_paths`.
- `gate_passed` only means every account signed in. A summary for a failed run says so.
- The MCP server refuses to start when the source is newer than the build, and once the code is rebuilt under it, every tool asks for a restart and runs nothing.
- `runners.http2: false` makes the browser use HTTP/1.1, for a site whose HTTP/2 is known to stall.
- `select: { selector, label }` (or `value`, or `index` where 0 is the first option, for lists such as account numbers that change per customer) chooses from a dropdown. It focuses the field, chooses, and leaves it, as a person does, because some forms only record a choice from a field that was touched.
- `assert: { type: field_value, selector, value }` checks what a form field holds, such as a profile's first name. It may not read the password field. A failure names what the field held.
- `accessibility: { name }` checks the page as it stands against WCAG 2.1 AA with axe-core, which ships inside the runner image and fetches nothing. `standard` picks `wcag2a`, `wcag2aa`, `wcag21aa` (the default), or `wcag22aa`. `exclude` lists selectors to leave out, such as a third-party chat widget the client does not control. The step records problems and passes. With `fail_on: serious` (or `critical`, `moderate`, `minor`) it fails when a problem is at least that serious, so put it last in a journey that should keep going. Each page's findings go to `accessibility-<name>.json` beside the screenshots, with the markup of up to 20 elements per problem, masked like every other file. The summary lists each checked page once, worst problem first, merging the same page across accounts. A run whose journeys passed but whose pages have accessibility problems says so, instead of "nothing needs fixing". Grading follows `docs/severity.md`.
- `inspect: { name }` saves a map of the page to `inspect-<name>.json` and a screenshot. `inspect_page` uses it, and a journey can too.
- Templates work in selectors as well as values, such as `tr:has-text('Room {{run.tag}}')` for a row this run created.
- `auth.prepare` is a list of click selectors. The sign-in check runs them after the sign-in page opens and before it types the login, for a banner or a cookie notice that covers the form. Juice Shop's project uses it. A journey still closes those itself, because each journey is a fresh browser. A role selector uses single quotes, as in `role=button[name='dismiss cookie message']`.
- Templates: `{{run.id}}` for a fresh made-up email on every run, `{{run.tag}}` for its short last part (for sites that limit username length), `{{run.label}}`, `{{self.vars.first_name}}` for the running label's own values, and `{{date.+30}}` for the date 30 days from today.

Chaos (`--chaos <profile> --seed <seed>`) adds delays, dropped requests, refreshes, back presses, and double clicks to journeys. The seed is joined with each label and journey, so each one meets a different pattern that the same seed repeats. A refresh or back is skipped while a form is half filled in, because a person who reloads mid-form types it again. It is also skipped on a page that a sent form produced, because reloading it sends the form again, which a browser does only after asking. A double click lands on the button the step presses, so it tests a double submission. A dropped request is never the page load itself, because no site can recover from the browser's own error page; the drop moves to the next request the page makes. Every skip is logged. In a chaos summary, journeys that stopped at the same step with the same page words share one line. Compare a chaos run with a normal one: a check that passes normally but fails under chaos shows where the site does not recover. On Juice Shop, a lost sign-in request left the review journey on Login with `TypeError: Failed to fetch` (`docs/sample-report-juice-shop-lab.md`).

Requests are paced, not dropped. Each runner may send `limits.request_burst_per_runner` requests at once (20 by default), then its share of the total per second. A busy page loads slower. It does not load broken. The share is `max_requests_per_second_total` divided by the number of runners that can work at once (the smaller of `max_parallel_runners` and the number of labels), and never more than `max_requests_per_second_per_runner`. The egress proxy sees an HTTPS connection only as a tunnel, so it cannot count the requests inside one. It paces new connections, and the runners keep the request total. Service workers are blocked, so a page's worker cannot send requests that skip this pacing. A run is `rate_limited` only when the site itself answers 429 or 503 to more than one request in ten.

A captcha stops the journey only when a person could see it: a visible widget or challenge frame, or the words "verify you are human". Invisible reCAPTCHA v3, the reCAPTCHA badge, and a Turnstile script that never shows a widget are ignored. A second-code prompt needs a one-time-code field, a field named for a code, or wording that a code was sent. A postcode, promo code, or other short field is not a second code. An authenticator code is made with at least 15 seconds of its 30-second window left, waiting for the next window if needed, so a site that accepts only the current code does not see it expire between being made and being typed. A texted or emailed code waits for you on the local code page for up to `auth.operator_code_wait_sec` seconds (600 by default), and never past the run deadline.

A runner that is missing or crashes becomes an error for that account only. The other accounts keep their results. A run where every account hit such an error is `error`, not `failed`, because the harness broke, not the site.

A journey that failed, errored, or was flaky for any label in a `suite` run is copied to `~/.hornet-swarm/regressions/<project>/` and joins later `suite` runs. It is fixed after three `suite` runs in a row where it passed for every label. Then the copy is removed and the ledger stays. While the project still has that journey, its current version runs, so fixing a journey's own mistake also fixes its regression; the saved copy runs only if the project's journey is gone. A single `journey` or `run_journey` call neither adds a regression nor counts toward fixing one.

A journey with `requires_phase1: false` runs even when that label's sign-in check did not pass. Other journeys are skipped then. A label with no stored login whose journeys all have `requires_phase1: false` is a guest, such as a visitor who books without an account: it is not signed in, the summary names it as a guest, and it does not hold back the sign-in gate. Each journey runs in a fresh browser either way, so a journey that needs a session signs in itself.

## Runner output folders

Each runner writes screenshots, traces, and network logs under `~/.hornet-swarm/runners/<project>/<label>`. That folder is mode `0700`. The owner is the user who starts Hornet Swarm, and the group is that user's group.

Docker Desktop on this Mac shows the folder to the container as root, and the runner user (uid 10001) can still write there. The files come back owned by the user who started Hornet Swarm, so the controller can read them. Mode `0700` is enough for that. A group shared with the container would let more accounts in, and it is not required.

If that folder already exists and other accounts can open it, startup stops and names the folder. Hornet Swarm does not change its mode.

After each job the files are moved into the run folder, so nothing unredacted stays in the runner folder. Links written by a runner are not followed. Each runner sees only its own control token, read-only. The egress proxy allows only the exact host and port pairs of the project's origins, plus the credential page port on this Mac.


## Results on 14 October 2026

A live run on The Internet gave the result that site is built to give. Both accounts signed in and all four journeys passed. A scan of every saved file, including traces, found no stored login in any encoding.
