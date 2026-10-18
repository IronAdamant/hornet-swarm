# Running a swarm as an agent

This is for the parent agent and its sub-agents: a Grok Build session, Grok Bot, Claude Code, or any other MCP client. The harness signs in, drives the browser, and writes evidence. The agents decide what to test and judge the results.

## Before you start

The owner does these. An agent does not.

1. An authorisation file covers the site: `owner`, `contract`, or `public_practice`.
2. The project exists with its logins stored. For the practice site: `node scripts/setup-practice.mjs the-internet`.
3. `hornet-swarm env up --project <id>` has started one healthy runner per label.

Connect to the MCP server: `node packages/mcp-server/dist/main.js` over stdio. Restart it after every `pnpm build`. A server whose code was rebuilt under it answers every tool with "Restart the MCP server" and runs nothing, and it refuses to start when the source is newer than the build. In Claude Code, `.mcp.json` in this repo registers it as `hornet-swarm`, and `.claude/agents/hornet-swarm-tester.md` defines a sub-agent for one label.

## The parent

1. `get_swarm` for the project. Check `ready` is true, `kill_switch` is false, and each label's runner is healthy. Read each label's `personality`, `rules`, and latest `notes`.
2. Give each sub-agent one label, that label's personality and rules, the website, and the task. Give no passwords. There are none to give.
3. If the sub-agents share your MCP connection, each one calls `register_agent` and uses its own id. One id holds one login at a time.
4. Every result is a packet with `validation_required: true`. Check each sub-agent's report against its packet: the status, every `Failed:` line in the summary, and the page text. Then tell the owner the outcome with the run ids.
   - `gate_passed: true` only means every account signed in. It says nothing about the journeys.
   - "qa-user-5 is busy until ..." means another agent holds that login. It is not a site failure. Run it again after that time.
5. After several runs, `get_reliability` gives pass rates, p50 and p95 timings, retries, and failing streaks. Call a site reliable only from that, not from one run. Chaos runs are left out of those figures. Pass `chaos: true` to see them alone.

## A sub-agent

1. `register_agent`, then pass `agent_id` on every call.
2. `run_signin_check` with `users: [<label>]`.
3. `run_journey` with `users: [<label>]`, and `journey_id` or `journey_yaml`.
4. Quote the page, not your reading of the picture. A failed step's error already quotes what the page showed: its message or toast, whether the control was disabled or what it reads, the closest words to the text the check expected, and other error lines. Every failed step also saves `failed-step-<n>.png` and `failed-step-<n>.txt`. `page_text_paths` in the packet lists each `.txt` beside its screenshot.
   - A `.txt` holds the page's visible words, then `Form fields:` (what each field holds, such as `- City: Testville`) and `Disabled buttons:`. Password fields are never read, and stored logins are masked. Dropdown options are left out of the visible words; the field line shows the chosen one.
   - A field's name in `Form fields:` is the label the page attaches to it. If a label looks wrong for its value, such as a postcode sitting in the city field, the page has attached its labels to the wrong fields. That is a finding about the page.
   - Not every error-looking word is an error. A misspelled dropdown option or a heading is page text, not a message the site showed. A request answered 401 while a page loads, when the site is asking who is signed in, is normal, not a finding.
   - Copy spellings from the `.txt`. A screenshot is easy to misread.
5. `add_agent_note` for what you learned, then `release_test_user`.

## What a status means

| Status | Exit | Meaning |
|---|---|---|
| `passed` | 0 | Every check that ran passed. |
| `failed` | 1 | The site did not do what a check expected. `analysis.suspected_cause` names the first failed step. |
| `blocked` | 2 | A run stopped before a verdict: kill switch, time limit, captcha, second code, busy login, sign-in limit, or a page outside the allowed list. The summary says which. |
| `rate_limited` | 2 | The site answered 429 or 503 to more than one request in ten. Back off. |
| `redaction_failure` | 1 | A saved file still held a secret. Do not share that run. |
| `error` | 4 | The harness broke, such as a missing runner. Not a site problem. |

`stop_note` in a packet means a captcha or second-code page ended that journey. It is finished. Never try to solve the challenge.

## Writing a journey

```yaml
version: 1
id: search-results            # lowercase letters, digits, dashes
name: Search shows results
users: [qa-user-1, qa-user-2]
steps:
  - navigate: { url: "/login" }
  - fill: { selector: "#username", credential: "self.username" }
  - fill: { selector: "#password", credential: "self.password" }
  - click: { selector: "button[type='submit']" }
  - wait: { for: navigation }
  - fill: { selector: "#q", value: "widget" }
  - click: { selector: "role=button[name='Search']" }
  - assert: { type: text_visible, value: "results" }
  - screenshot: { name: "search" }
```

- Templates work in selectors too: `tr:has-text('Room {{run.tag}}')` finds a row this run created.
- A label with no stored login whose journeys all have `requires_phase1: false` runs as a guest. The summary names it as a guest, not a failed sign-in.
- `self.username` and `self.password` mean the label running the journey. One journey can serve every label.
- Each journey runs in a fresh browser, so it signs in itself.
- Steps: `navigate`, `click`, `fill`, `select` (a dropdown, by `label`, `value`, or `index`), `wait` (`navigation`, `selector`, `timeout`), `assert`, `upload`, `screenshot`, `accessibility` (checks the page against WCAG 2.1 AA and records problems; `fail_on: serious` makes it fail), and `inspect` (saves a map of the page).
- Assertions: `url_contains`, `text_visible`, `selector_visible`, `selector_absent`, `http_status`, `access_denied`, and `field_value` (with a `selector`, for what a form field holds). `url_contains`, `text_visible`, `selector_visible`, and `field_value` wait up to 10 seconds.
- Templates: `{{run.id}}` (a fresh made-up email per run, such as `nova.{{run.id}}@example.com`), `{{run.tag}}` (its short last part, for a username length limit), `{{run.label}}`, `{{self.vars.city}}` (the running label's own value from the project), and `{{date.+30}}`.
- Assert what a working site does. A planted or real bug then shows up as a failed step with the page's own words.
- A selector is CSS, or `role=button[name='Sign in']` for an accessible name. The name is in single quotes. A role selector with double quotes is not read as a role.
- `auth.prepare` is a list of clicks after the sign-in page opens and before the login is typed. Juice Shop's sign-in uses it to close the welcome banner and the cookie notice, because the banner covers the login button. Each journey still closes those itself, in a fresh browser.
- To write a journey for a page you have not seen, call `inspect_page` first. It returns the page's headings, links, buttons, and fields, each with a selector to use, and the visible words. Prefer selectors marked `checked: true`. Draft from the map, validate, run, and fix from the failure clues. It clicks nothing, so inspect each page the journey will reach. For a site that routes after a `#`, ask for `/#/page`.
- `validate_journey` checks a journey without running it. A journey that navigates off the allowed site, fills a passive third party, or contains a literal password is refused. A navigate URL is checked after its `{{vars}}` are filled in, and `//host/` counts as a site.
- Name journeys by id, such as `signin-dashboard`. A file path is refused.
- A journey with an `access_denied` assertion, an expected 401 or 403, or the tag `access-control` is an access check. It runs only when the authorisation lists `access_control_checks`. A public practice site never lists that activity. `lab-owner` lists it for the local labs. ParaBank's `admin-page-readonly` journey uses the tag and must not press Initialize, Clean, or JMS.
- `requires_phase1: false` lets a journey run when the label's sign-in check failed. Use it only for pages that need no login.
- An `upload` step attaches a file the runner image ships: `sample.txt`, `sample.png`, or `sample.pdf`.

## Practice sites

The Internet is a public site built for test-automation practice. Other people use it too.

- Keep the project's limits. A `public_practice` authorisation refuses more than 10 requests a second in total, 5 per runner, 6 runners at once, chaos, and access-control probing. Each runner gets an equal share of the total.
- Read `exclusions` in `get_swarm`. They are the owner's written limits, such as never typing a real card number. Follow them as you would the label's rules.
- Never type real personal details. The journeys use placeholders.

## Local labs

`node scripts/setup-lab.mjs` starts Restful Booker (`booker-lab`), ParaBank (`parabank-lab`), and OWASP Juice Shop (`juice-shop-lab`) in Docker on this Mac. An `owner` authorisation covers them, so chaos is allowed and nothing touches a live service. Use made-up details only: `example.com` addresses, Testville, and test bank numbers. Juice Shop's scoreboard and challenge pages are out of scope, and its customer feedback form asks for a captcha, so that page is left out.

- Agents run chaos themselves: pass `chaos: { profile: "default", seed: "bank-2" }` to `run_suite` or `run_journey`. Profiles: `default`, `latency`, `drop`, `offline`, `double-click`, `history`, `slow-api`. The authorisation must list `chaos`; a public practice site never allows it. The same seed repeats the same pattern.
- Under chaos, compare with a normal run of the same journeys. Journeys that stopped at the same step with the same page words share one `Failed:` line, which is one finding, not several. Chaos never drops the page load itself; `drop:spared the page load` in the analysis records it. It never refreshes a half-filled form or a page that a sent form produced; the analysis records each skip.
- Under chaos, a journey that fails the same way on a normal run is a fault the site already has. Only a journey that passes normally and fails under chaos shows where the site does not recover. The analysis lists every chaos action, including those skipped because a form was half filled.

