# Running a client engagement

How to take a testing job, such as a site owner asking you to check their site, from first contact to the report you hand back. Security testing is a separate item and is not covered here yet.

## 1. Agree the scope in writing

Nothing runs against a client's site until they have signed. Send them these questions and put the answers in the engagement letter.

| Question | Why it matters | Where it goes |
|---|---|---|
| Which site addresses and which environment (staging, test, production)? | The harness refuses any other host, and asks for an extra confirmation before a production-looking one. | `scope.domains`, `scope.environments` |
| Who is signing, with what role and email? | The authorisation names the person who allowed the work. | `authoriser` |
| Which dates? | Runs outside the window are refused. | `valid_from`, `valid_until` |
| What may be tested: sign-in, user journeys, resilience (chaos)? | Each activity is checked before a run starts. | `activities` |
| What is off limits? For example production data, payments, emails to real customers. | Agents read the exclusions before they start. | `exclusions` |
| Which test accounts will they create, with what roles? | You never use a real customer's login. One label per account. | project `users` |
| How hard may the site be pushed: requests per second, how many accounts at once, and when? | The limits and the time window protect their servers. | project `limits` |
| Who do you call if something looks wrong, and how fast can they reply? | You stop the run with the kill switch and tell them. | engagement letter |
| Which journeys matter most to them? For example sign-up, checkout, booking. | Those become the first journeys. | journey files |

Ask the client to create the test accounts and send the logins through the private login page (`hornet-swarm creds serve`), not by email or chat.

## 2. Set it up

1. Save the signed letter as `~/.hornet-swarm/authorisations/docs/<client>-signed.pdf`.
2. Copy `examples/authorisations/client-staging-contract.yaml` to `~/.hornet-swarm/authorisations/<id>.yaml`. Fill it in from the letter, and set `document.sha256` to the output of `shasum -a 256 <the pdf>`.
3. Run `pnpm hornet-swarm auth check <id>`. It confirms the record is in force and that the PDF is the one it names.
4. Write the project file: base address, allowed origins, sign-in selectors and success check, limits, and one user per test account. Start from `examples/projects/juice-shop-lab/project.yaml`.
5. Store the logins: `pnpm hornet-swarm creds serve`, or `pnpm hornet-swarm creds add <project> <label>`.
6. Write the journeys. Assert what a working site does. Use `self.username` and `self.password`, `example.com` addresses, and test card or bank numbers the client gives you. If a journey does not use an inbox step, ask the client to pre-verify the test accounts and to turn captcha off on staging. The harness does not solve a captcha, and it does not read a verification email unless the journey has an inbox step that names a test inbox.
7. `pnpm hornet-swarm env up --project <id>`, then `pnpm hornet-swarm sign-in --project <id>` to prove every account gets in before anything else runs.

Rehearse each new kind of site on the local labs first (`node scripts/setup-lab.mjs`).

## 3. Run it

- `suite` for the journeys. Run it several times across the agreed window, not once, so `stats` can give pass rates, p50 and p95 timings, retries, and failing streaks.
- `suite --chaos default --seed <name>`, only if resilience testing is in `activities`. Run the same journeys without chaos too, and compare.
- An `accessibility` step on each key page, if the client wants accessibility in scope. It needs no extra activity, because it only reads the page. Agree the standard first: WCAG 2.2 AA unless they name another. Say in the report that automated checks catch only some problems, and offer a keyboard and screen-reader pass for a full audit. The client report marks every criterion a person has to judge as needs manual review. `docs/accessibility-report-juice-shop-lab.md` is the form.
- For pages no journey covers yet, `pnpm hornet-swarm inspect --project <id> --user <label> --url <path>` maps the page, and the journey is drafted from the map.
- Watch the first run. If the site answers 429 or 503, or anything looks wrong on their side, stop with `pnpm hornet-swarm kill --project <id>` and tell your contact.
- Check every failure's screenshot before you call it a bug. Rehearse that on the local labs first.

## 4. What to hand back

Each run folder in `~/.hornet-swarm/runs/<run id>/` holds:

| File | Use it for |
|---|---|
| `summary.md` | The plain-English result: how many accounts got in, how many journeys passed, and every failure with its step and what the page said. |
| `report.html` | The same with screenshots, for the client to open in a browser. |
| `analysis.md` | Step-by-step detail, timings, console and network errors, and the chaos actions. For their developers. |
| `junit.xml` | For the client's CI or test-management tool. |
| `evidence.zip` | Redacted screenshots, network logs, and traces. Every run checks that no password or code is left in them. Never share a run marked `redaction_failure`. |

`pnpm hornet-swarm stats --project <id>` gives the reliability figures across runs.

For a business owner, or an agency reselling under its own name, save the job as a job file and run `pnpm hornet-swarm client-report --job <file> --run <run id>`. It writes `client-report.md` and `client-report.html` into the run folder: a plain-English summary, each issue with where it happens, why it matters to customers, and how to fix it, the sign-up, log in, cart, and checkout results, the WCAG 2.2 criteria table, the scope and limits, and an evidence appendix, under the agency's brand by default. Read it, grade or withdraw issues in the job file where your judgement differs, and run it again. `docs/fixture-sample-client-report.md` is the form. For a monthly subscription, `pnpm hornet-swarm retest --job <file> --if-due` runs the job again and writes `retest-diff.md`: new, fixed, and still-open issues, and journeys that stopped working. See "Client reports and monthly re-tests" in `docs/reference.md`.

Never write that a site is compliant, certified, or meets WCAG. Write "issues found against WCAG 2.2 AA in tested pages", and say what was not tested. The client report enforces this, and refuses to save a report that breaks it.

Write the report as a findings table, worst first. For each finding:

| Field | Example |
|---|---|
| ID and title | P-01 · Updating contact details breaks sign-in for a password with a symbol |
| Severity | High: the customer is locked out |
| Where | Update Contact Info |
| Steps to reproduce | From `analysis.md`: sign up with a password that contains `#`, open Update Contact Info, change the phone number, press Update Profile, then sign in again |
| Expected and actual | Expected the same password still signs in; the page says "The username and password could not be verified." |
| How often | Every run (from `stats`) |
| Evidence | Run id, screenshot name, network entry |

Finish with what you could not check and why, such as an exclusion, a captcha, or a page the test accounts could not reach. Say plainly what passed.
