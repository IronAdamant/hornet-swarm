# Hornet Swarm

Hornet Swarm tests a website the way its customers use it, with many accounts at once, and writes the report a site owner can act on. Each test account gets its own real Chromium browser in its own container. You drive it from the `hornet-swarm` command, or let AI agents (Claude, Grok) run it through its MCP server, one agent per account.

It is for sites you own, or sites someone has authorised you in writing to test. It is not a load tester, and it does not try to break into sites. If a page asks for a human check or a second code, it stops and tells you.

## What it does

- **Signs every account in, then runs journeys.** A journey is a short YAML script: search, add to cart, check out, update a profile, book a room. Each account runs it in a fresh browser, so a fault that hits one kind of customer shows up as that customer.
- **Quotes the page when something fails.** A failed step names what the customer would have seen ("page said: Sorry, this user has been locked out.", "it reads Seach", "closest text on the page: Releated items") and saves a screenshot and the page's words.
- **Tells the site's faults from its own.** A crashed browser, a deleted account, a rate limit, and a stalled API each get their own verdict, so a report never blames the site for the harness.
- **Measures reliability over time.** `stats` gives pass rates, median and slowest timings, retries, and failing streaks per journey. Failed journeys keep running in later suites until they pass three times in a row.
- **Checks accessibility inside the journeys.** An `accessibility` step checks the page against WCAG 2.1 AA with axe-core, including pages behind the login that most scanners never reach. Each problem is named in plain words, with how many places it occurs and an example.
- **Tests recovery with chaos.** Optional delays, lost requests, refreshes, back presses, and double clicks, repeatable by seed, show where a site leaves a customer stuck with no message.
- **Lets AI agents run the swarm.** Agents see account labels such as `qa-user-3`, never passwords. Each agent plays one account, with its own personality and rules, and leaves notes for the others.
- **Drafts journeys from a look at the page.** `inspect_page` (or `hornet-swarm inspect`) opens one page as an account and returns its headings, links, buttons, and fields, each with a selector a journey can use. It clicks nothing. An agent drafts the journey from the map, runs it, and fixes it from the failure clues.

## Built to be safe on someone else's site

- **Nothing runs without written permission.** Every project names an authorisation file: the domains, dates, activities, and signed document. A run refuses any other host, an expired record, or a changed document.
- **Logins stay out of reach.** Passwords live in an encrypted store (sops and age, with the key in the macOS Keychain). Agents get labels only. Saved runs are scanned and masked, and a leak check covers screenshots too.
- **Polite by default.** Requests are paced per browser and in total, sign-in attempts are capped, and a public practice site gets lower limits and no chaos.
- **One switch stops everything.** Any agent can engage the kill switch. Only the owner can release it.

## Sample reports

Every report below came from real runs. The labs run on one Mac. All accounts are made up. Findings use one severity scale, [docs/severity.md](docs/severity.md).

| Report | What it shows |
|---|---|
| [ParaBank lab](docs/sample-report-parabank-lab.md) | An online bank: a profile update that breaks sign-in for passwords with a symbol, and checks that every balance adds up after transfers and bill payments |
| [Chaos: ParaBank](docs/chaos-report-parabank-lab.md) | How the bank recovers when requests are lost or slow |
| [Juice Shop lab](docs/sample-report-juice-shop-lab.md) | A local shop: sign-up, search, basket, checkout, order history, a review, and a username. The feedback form is left out because it asks for a captcha |
| [Accessibility: Juice Shop](docs/accessibility-report-juice-shop-lab.md) | The shop front, a product, sign-in, sign-up, and the signed-in basket, checkout, and profile, against WCAG 2.1 AA |
| [Security: Juice Shop](docs/security-report-juice-shop-lab.md) | A light pass over the same customer journeys, on the security scale |
| [Security: ParaBank](docs/security-report-parabank-lab.md) | A security pass run by a separate swarm, on its own severity scale |

## Quick start

You need macOS on Apple Silicon, Node.js 22, pnpm 9, Docker Desktop or OrbStack, and `brew install sops age tesseract`.

```bash
pnpm install
pnpm build
pnpm image
pnpm hornet-swarm doctor
```

Then try it on the offline fixture that ships with the repo:

```bash
pnpm --filter @hornet-swarm/fixture-app start
node test/e2e/prepare-fixture.mjs
pnpm hornet-swarm env up --project fixture --count 1
pnpm hornet-swarm suite --project fixture \
  --journey examples/journeys/example-app/01-signin-dashboard.journey.yaml \
  --journey examples/journeys/example-app/02-tenant-isolation.journey.yaml
```

Or run it hard against a local lab, with made-up customers it creates itself. `setup-lab` starts Restful Booker, ParaBank, and OWASP Juice Shop, all on this Mac:

```bash
node scripts/setup-lab.mjs
pnpm hornet-swarm env up --project juice-shop-lab
pnpm hornet-swarm suite --project juice-shop-lab
pnpm hornet-swarm stats --project juice-shop-lab
```

Reports land in `~/.hornet-swarm/runs/<run id>/`: `summary.md` for a person, `analysis.json` for an agent.

## Documentation

- [docs/reference.md](docs/reference.md): the full manual. Setup, the practice sites and labs, every command, agents, journeys, and how checks wait.
- [docs/client-engagement.md](docs/client-engagement.md): taking a testing job from first contact to the report you hand back.
- [docs/agents.md](docs/agents.md): the playbook for an AI parent running one sub-agent per account.
- [docs/severity.md](docs/severity.md): how findings are graded.
- [SECURITY.md](SECURITY.md): the rules on secrets.
- [docs/history/](docs/history/README.md): build notes, kept as the record.

## Tests

```bash
pnpm test
pnpm test:e2e
```

`pnpm test` is the unit suite. `pnpm test:e2e` is the end-to-end suite. Both use the offline fixture in `test/fixture-app` only. Do not point them at a live site.

End-to-end tests need Docker or OrbStack, sops, age, and tesseract. GitHub Actions runs build, lint, unit tests, and a coverage gate on the redactor and policy code on Linux for every push and pull request (`.github/workflows/ci.yml`). That Linux job does not run `pnpm test:e2e`. GitHub-hosted macOS runners do not provide Docker or OrbStack, so the end-to-end command stays manual.

On 15 October 2026, 207 unit tests and 58 end-to-end tests passed on this Mac.

## Licence

See [LICENSE](LICENSE) and [NOTICE](NOTICE). Built by Aron Amos (Iron Adamant).
