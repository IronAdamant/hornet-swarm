# Running a swarm as an agent

This is for the parent agent and its sub-agents: a Grok Build session, Grok Bot, Claude Code, or any other MCP client. The harness signs in, drives the browser, and writes evidence. The agents decide what to test and judge the results.

## Before you start

The owner does these. An agent does not.

1. An authorisation file covers the site: `owner`, `contract`, or `public_practice`.
2. The project exists with its logins stored. For the practice sites: `node scripts/setup-practice.mjs the-internet` or `saucedemo`.
3. `hornet-swarm env up --project <id>` has started one healthy runner per label.

Connect to the MCP server: `node packages/mcp-server/dist/main.js` over stdio. In Claude Code, `.mcp.json` in this repo registers it as `hornet-swarm`, and `.claude/agents/hornet-swarm-tester.md` defines a sub-agent for one label.

## The parent

1. `get_swarm` for the project. Check `ready` is true, `kill_switch` is false, and each label's runner is healthy. Read each label's `personality`, `rules`, and latest `notes`.
2. Give each sub-agent one label, that label's personality and rules, the website, and the task. Give no passwords. There are none to give.
3. If the sub-agents share your MCP connection, each one calls `register_agent` and uses its own id. One id holds one login at a time.
4. Every result is a packet with `validation_required: true`. Check each sub-agent's report against its packet: the status, the first problem in `analysis`, and the screenshots. Then tell the owner the outcome with the run ids.
5. After several runs, `get_reliability` gives pass rates, p50 and p95 timings, retries, and failing streaks. Call a site reliable only from that, not from one run.

## A sub-agent

1. `register_agent`, then pass `agent_id` on every call.
2. `run_signin_check` with `users: [<label>]`.
3. `run_journey` with `users: [<label>]`, and `journey_id` or `journey_yaml`.
4. Open the screenshots and check them before reporting anything as broken.
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
  - fill: { selector: "#q", value: "backpack" }
  - click: { selector: "role=button[name='Search']" }
  - assert: { type: text_visible, value: "results" }
  - screenshot: { name: "search" }
```

- `self.username` and `self.password` mean the label running the journey. One journey can serve every label.
- Each journey runs in a fresh browser, so it signs in itself.
- Steps: `navigate`, `click`, `fill`, `wait` (`navigation`, `selector`, `timeout`), `assert`, `upload`, `screenshot`.
- Assertions: `url_contains`, `text_visible`, `selector_visible`, `selector_absent`, `http_status`, `access_denied`. The first four wait up to 10 seconds.
- A selector is CSS, or `role=button[name='Sign in']` for an accessible name.
- `validate_journey` checks a journey without running it. A journey that navigates off the allowed site, fills a passive third party, or contains a literal password is refused.

## Practice sites

The Internet and Sauce Demo are public sites built for test-automation practice. Other people use them too.

- Keep the project's limits. A `public_practice` authorisation refuses more than 10 requests a second in total, 5 per runner, 6 runners, chaos, and access-control probing.
- Sauce Demo's accounts misbehave on purpose. `problem_user`, `error_user`, and `locked_out_user` are expected to fail somewhere. The useful result is the exact step and what the page did.
- Never type real personal details into a checkout. The journeys use placeholders.
