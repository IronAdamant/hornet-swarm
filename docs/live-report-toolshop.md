# Live report: hosted Toolshop, 14 October 2026

The first run against a live site run by someone else, done the way a client job would start: a written permission, test accounts of our own, gentle limits, a watched first run, then the full suite. The site is the hosted Practice Software Testing app, sprint 5 with deliberate bugs, the same app as the local `toolshop-lab`. Comparing the two shows what live conditions change. All accounts and details are made up. Severity follows `docs/severity.md`.

## Scope

| | |
|---|---|
| Site | https://with-bugs.practicesoftwaretesting.com, API at https://api-with-bugs.practicesoftwaretesting.com |
| Permission | `toolshop-live-practice` (public practice). Every page's footer says: "This is a DEMO application, used for software testing training purpose." A dated copy of the page was saved. |
| Activities | Sign-in checks and functional journeys. Chaos, load, access-control probing, and the admin account are excluded. |
| Accounts | Three made-up customers signed up for this run (Mara Quill, Tobin Reyes, Iris Calloway), not the published accounts other testers share |
| Limits | Two browsers at a time, two requests a second each, four in total, at most one order per run |
| Runs | Claude: sign-in check `run_20261014-210517_026cbb`; watched run of three journeys `run_20261014-210554_a64497`; full suite `run_20261014-211103_baaa2c` and `run_20261014-211436_0139bb`. Grok's swarm, later the same evening: one agent per account, the same journeys (`run_20261014-214717_d49ec7` to `run_20261014-214853_5c19a7`) |
| Journeys | search, cart, checkout, cash on delivery, favourites, profile. Sign-up and contact were left out so the runs would not add accounts or messages to a shared site. |

## Summary

The harness worked on a live site. It signed in through Cloudflare's bot check, kept to its limits, and told the site's faults apart from the network's. Every planted bug seen in the lab showed up live with the same page words.

Three things differ from the lab. Confirming an order works only some of the time live, where in the lab it never did. The live API stalled for a few minutes, long enough to leave one sign-in hanging with no message. And everything is two to three times slower.

## Findings, worst first

| ID | Finding | Severity | How often |
|---|---|---|---|
| L-01 | An order is confirmed only some of the time | High | 1 of 3 checkouts failed |
| L-02 | During an API slowdown, a sign-in hangs with no message | Medium | Once, in a slowdown of a few minutes |
| L-03 | Pages are two to three times slower than in the lab | Low | Every run |

### L-01 An order is confirmed only some of the time

- **Steps:** sign in, add product 1, check out, pay by bank transfer, press Confirm twice.
- **Expected:** "Thanks for your order!" every time.
- **Actual:** in `run_20261014-211103_baaa2c` the invoice request (`POST /invoices`) answered 500 and the page stayed on "Payment was successful". In `run_20261014-211436_0139bb` the same request answered 201 and the page said "Thanks for your order! Your invoice number is INV-2026000005." Grok's later run `run_20261014-214836_1a79e8` also succeeded ("INV-2026000006").
- **Lab:** the same step failed with 500 on every run (F-01 in `docs/sample-report-toolshop-lab.md`).
- **Impact:** some customers pay and get no order. Because it sometimes works, it is harder to notice and to reproduce than a fault that always happens.

### L-02 During an API slowdown, a sign-in hangs with no message

- **What happened:** in `run_20261014-210554_a64497`, qa-user-3 pressed Login and the request got no answer within 10 seconds. The page stayed on the login form with no message (`failed-step-5.txt`). The same account had signed in two minutes earlier.
- **The site, not the harness:** timed directly from this Mac at the same time, without the harness, the API timed out at 30 seconds twice, took 20 seconds once, and answered the product list with 500 three times. A few minutes later it answered in about 1.2 seconds, every time.
- **Impact:** the customer is not told that anything is wrong. This matches the lab's F-03 (the shop never says when a request fails), seen here without any chaos.

### L-03 Pages are two to three times slower than in the lab

| | Lab | Live |
|---|---|---|
| Sign-in, median | about 1.5 s | 3.6 s |
| Sign-in, slowest 5% | about 1.8 s | 9.1 s |
| Favourites journey, median | 3.6 s | 8.0 s |
| Home page fully loaded (one probe) | | about 27 s |

Live slowness alone is not a fault, but a sign-in that sometimes takes 9 seconds sits close to where customers give up.

## Planted faults, confirmed live

Each failed at the same step with the same page words as in the lab:

- The search button reads "Serch" (search, step 8).
- The product heading reads "Reltded products" (cart, step 16).
- Cash on delivery leaves Confirm disabled (step 19).
- The profile shows the last name as the first name for all three customers ("Reyes", "Calloway"), and "City: City not found" (profile, step 9).
- "Out of stock" under Long Nose Pliers.
- The menu reads "Contakt" and the account menu "User Data not found", and the sort control reads "Sorth" (`run_20261014-211436_0139bb`, cart and search page text).

## What passed

- Sign-in: 12 of 12 attempts, through Cloudflare's invisible bot check, which the harness correctly did not treat as a captcha.
- Favourites: 2 of 2. On the second run the page said the product was already saved, and the summary noted that `POST /favorites` answered 409 on a passing step.
- Checkout: 2 of 3 (see L-01).

## Live conditions, and how the harness handled them

- **Bot protection:** Cloudflare's challenge script ran on every page and passed with no human check.
- **Third parties:** the icon stylesheet from cdnjs loaded as a display-only third party. Cloudflare's analytics beacon was blocked.
- **Shared data:** other testers use the same site. Our customers were our own, so their data stayed predictable.
- **Politeness:** two browsers at a time, two requests a second each. One test order was placed, within the one-per-run limit.
- **Stored logins:** a scan of every saved file from the four live runs, traces and evidence zips included, found none of the stored logins in plain, URL-encoded, base64, or JSON-escaped form (3,066 files and zip entries). That scan covered stored logins only. Grok's security pass found other values in the same folders that should have been masked, fixed the harness, and masked the saved runs; see `docs/security-report-toolshop-live.md`.

## What was not checked

- Chaos and load. A public practice permission refuses both, as a client's live site would.
- Security. Grok's swarm covers it in `docs/security-report-toolshop-live.md`, within what the public permission allows.
- The admin account, sign-up, and the contact form, to leave the shared site's data alone.
- Reliability over many runs. Four runs is fewer than the five the stats ask for; more runs on another day would show how often L-01 and L-02 happen.

## How this was produced

`node scripts/setup-practice.mjs toolshop-live`, then `pnpm hornet-swarm env up --project toolshop-live`, `pnpm hornet-swarm sign-in --project toolshop-live`, a watched suite of three journeys, two full suites, and `pnpm hornet-swarm stats --project toolshop-live`.

## Review

Grok's swarm re-ran the journeys the same evening, one agent per account, and checked this report against the page text. Its checkout succeeded too, so L-01 stays intermittent (1 of 3 failed). It added the "Contakt", "User Data not found", "Sorth", and "City not found" lines, which were already in `run_20261014-211436_0139bb`. It also pointed out that the secrets line covered stored logins only; the rest is in its security report.

