# Sample report: Toolshop lab, 14 October 2026

A practice deliverable, written the way a client report would be, from runs against the local Toolshop lab (Practice Software Testing, sprint 5 with deliberate bugs). The site runs on the tester's own Mac. No live service was touched. All accounts and details are made up.

## Scope

| | |
|---|---|
| Site | Toolshop, http://127.0.0.1:4300 (lab copy, this Mac only) |
| Authorisation | `lab-owner` (owner basis): sign-in checks, functional journeys, and chaos. Cross-account checks were out of scope. |
| Accounts | Five made-up customers and the seeded shop admin |
| Runs | Claude's first pass, then three re-tests and a chaos round by Grok's swarm on 14 October; normal runs and chaos runs (seed `lab-1` with profile `default`; seeds `shop-2` with `default` and `shop-3` with `slow-api`) |
| Journeys | search, cart, checkout, cash on delivery, favourites, profile, contact, sign-up |

## Summary

Sign-in works: every customer account signed in on every run without chaos when the lab ran one or two browsers at a time, with a median of about 1.5 seconds. With three at once, the lab on this Mac (Toolshop runs under emulation) loaded the login page too slowly, so the project now runs two at a time. Three journeys work every time: contact, favourites, and sign-up. Five journeys fail every time, each at the same step, so each is a real and repeatable fault. The most serious is that a customer can pay and never get a confirmed order, and that cash on delivery cannot be completed at all.

Under chaos, the shop never tells the customer when a request fails. A lost sign-in, sign-up, message, or payment check leaves the page as it was, with no error.

## How severity is judged

The shared scale in `docs/severity.md`:

- **High:** a customer cannot complete something the site exists for, or money is wrong, a customer is locked out, or an order or payment is lost.
- **Medium:** the customer can carry on, but sees wrong data, is told something false, or is not told that something failed.
- **Low:** wording, spelling, labels, ordering, or layout that does not stop anyone.

## Findings, worst first

| ID | Finding | Severity | Where | How often |
|---|---|---|---|---|
| F-01 | An order is paid but never confirmed | High | Checkout, after payment | Every checkout run, 2 accounts |
| F-02 | Cash on delivery cannot be confirmed | High | Checkout, payment step | Every run |
| F-03 | The shop never says when a request fails | Medium | Sign-in, sign-up, contact, payment | Every chaos run; sign-in reproduced by hand |
| F-04 | The profile shows the wrong name and city | Medium | My account, profile | Every run, 2 accounts |
| F-08 | The cart shows a line total of $00.00 | Medium | Cart | Every cart run |
| F-05 | The search button says "Serch" | Low | Home page | Every run |
| F-06 | The product page heading says "Reltded products" | Low | Product page | Every run |
| F-09 | The menu's Home link opens the Contact page | Low | Top menu, every page | Every run |
| F-07 | Other text, label, and display faults | Low | Several pages | Every run |

### F-01 An order is paid but never confirmed

- **Steps:** sign in, open product 1, add to cart, open the cart, proceed twice, add the postcode and state, choose Bank Transfer, enter an account name and number, press Confirm, see "Payment was successful", press Confirm again.
- **Expected:** "Thanks for your order!" and an invoice number.
- **Actual:** the page stays on "Payment was successful". The request that creates the invoice (`POST /invoices`) returns 500.
- **Evidence:** run `run_20261014-082202_2a2c2b`, step 25 failed with `(page said: "Payment was successful")`. The network log shows `POST /payment/check` 200, then `POST /invoices` 500. The same in every run since, including Grok's `run_20261014-140940_8776ca` and `run_20261014-141715_7e59d7`.
- **Not every time:** every normal checkout in the lab failed this way, but the admin's order list shows two lab orders that did go through, `INV-2026000005` and `INV-2026000006`, created at 19:43 and 19:48 on 14 October, during Grok's chaos round. The hosted site also confirms some orders and not others (L-01 in `docs/live-report-toolshop.md`). The fault is intermittent, not total.
- **Impact:** some customers believe they have paid and receive no order. Because some orders do go through, the fault is harder to notice.

### F-02 Cash on delivery cannot be confirmed

- **Steps:** as F-01 up to the payment step, then choose Cash on Delivery.
- **Expected:** Confirm can be pressed. Cash on delivery needs no extra details.
- **Actual:** Confirm stays disabled. The bank-transfer fields "Your Account name *" and "Your Account number *" stay on the form, empty, as if they were still required.
- **Evidence:** run `run_20261014-141815_3b7810`, `qa-user-3/cash-on-delivery/failed-step-19.txt`: `payment-method: Cash on Delivery`, both account fields `(empty)`, and `Confirm (disabled)`. The screenshot beside it shows the same.

### F-03 The shop never says when a request fails

When the network loses a request, the shop never says so. Either the page stays as it was, or it loads half empty and carries on as if nothing were wrong. The customer cannot tell whether to wait, retry, or give up. Seen these ways:

| Where | What happened | Evidence |
|---|---|---|
| Sign-in | Login pressed, request lost: the customer stays on the login page, form filled in, no message | Reproduced by hand by aborting one `POST /users/login`. In Grok's chaos run `run_20261014-142116_7f1685`, five journeys stopped at the same sign-in step |
| Sign-up | The form stays up after Register, with no message | Same chaos run, `qa-user-2` register, step 14 |
| Contact | No thanks message and no error; the form stays up with the message typed in. In another run, the form instead asked for "First name is required", "Last name is required", and "Email is required", details the shop already holds for a signed-in customer | `qa-user-5` contact, step 11, in `run_20261014-142116_7f1685` and `run_20261014-195137_188041` |
| Payment | "Payment was successful" never appears, and the payment form stays as filled in | `qa-user-1` checkout, step 23, in `run_20261014-194501_35477e` |
| Billing address | The billing step loads with address, city, and country empty and the next button disabled | `qa-user-3` checkout, step 18, in `run_20261014-193940_322e9f` |
| Favourites | "There are no favorites yet." for a customer who has one | `qa-user-4` favourites, step 11, in `run_20261014-193327_dfa864` |

Only the sign-in case has been reproduced by hand. The others come from chaos runs, where a lost or slow request is the likely cause. In every case the next normal run worked, and no saved page showed a second payment or a lost total.

- **Expected:** a message such as "Something went wrong, please try again", and a way to retry.

### F-04 The profile shows the wrong name and city

- **Steps:** sign in as a customer who signed up as Dev Okafor in Testville, open My account, then Profile.
- **Expected:** first name "Dev", last name "Okafor", city "Testville".
- **Actual:** the first name field holds "Okafor", the last name field holds "Dev", and the city reads "City not found". The same for Lena Marsh.
- **Evidence:** run `run_20261014-140851_5c437e`, step 9: `field held "Okafor"`; `run_20261014-141549_0d26ec`: `field held "Marsh"`.

### F-08 The cart shows a line total of $00.00

- **Steps:** sign in, open product 1 (Combination Pliers, $14.15), add to cart, open the cart.
- **Expected:** a line total of $14.15.
- **Actual:** the line total reads `$00.00` while the order total reads `$14.15`. Two columns are both headed "Total".
- **Evidence:** `qa-user-1/cart/cart.txt`, runs `run_20261014-104252_bd81c7` and `run_20261014-140819_bcbd04` (found by Grok's swarm). No journey checks it yet.

### F-05 and F-06 Text faults that are checked every run

- The search button reads "Serch". The step error quotes it: `it reads "Serch"`.
- The product page heading reads "Reltded products". The step error quotes it: `closest text on the page: "Reltded products"`.

### F-09 The menu's Home link opens the Contact page

- **Steps:** open the catalogue, filter to hammers, press Home in the top menu.
- **Expected:** the catalogue, with its sort control.
- **Actual:** the contact form. The link's address is `/#/contact`.
- **Evidence:** run `run_20261015-180940_a45183` (journey `browse`), step 7 failed with `nothing on the page matches [data-test='sort']`, and `failed-step-7.txt` shows the contact form's fields. The filter steps before it passed.
- **How it was found:** no journey covered the menu. An `inspect_page` map of the home page listed the link as `"Home" -> /#/contact`, and the journey drafted from that map caught it on its first run.
- **Impact:** a customer who wants the catalogue lands on a form instead. The logo and Categories still lead back, so nobody is stuck.

### F-07 Other text, label, and display faults

- The top menu reads "Contakt". The account menu reads "User Data not found" instead of the customer's name.
- The billing step's heading reads "Blliling Adress", and the sort control reads "Sorth".
- At checkout, the postcode field holds the words `missing value` instead of the postcode given at sign-up (`billing-address.txt`: `Your Postcode *: missing value`).
- The sign-up form attaches the label "Country" to the state field and "State" to the country field, so screen readers and autofill get them the wrong way round.
- The payment-method dropdown lists a misspelled option, "Errror 304 - Missing Payment Gateway". It is a choice in the list, not a message on the page.
- The contact form's subject dropdown lists "Error 101: Subject not found" and "Error 202: Translation error" as choices.
- A toast reading "Oeps, something went wrong." appears on product, cart, checkout, and favourites pages, even when the step passed.
- The shop logo does not load.

These are worth journeys of their own before a client report relies on them.

## What passed

- Every customer account signed in on every run without chaos, two browsers at a time.
- Contact: the message is sent and the page thanks the customer.
- Favourites: a saved product appears in the favourites list.
- Sign-up: a new customer signs up with a fresh address and signs straight in.
- Admin: the dashboard, products, orders, and brands pages load, and the admin can add a brand made for the run, find it, and delete it again (`run_20261014-231046_c9f0a7`).

## What was not checked

- Cross-account access ("can one customer see another's invoice?"). Left out of this authorisation on purpose.
- Editing products and orders as the admin. The admin journeys add and delete only a brand made for the run.
- Price filters and sorting.
- The stylesheet the page loads from a public CDN, which stayed blocked to keep the lab offline. Icons from it do not show on the screenshots.
- Restful Booker, the second lab, which is guest-only for now.

## How this was produced

`node scripts/setup-lab.mjs`, then `pnpm hornet-swarm suite --project toolshop-lab` several times and with `--chaos default --seed lab-1`, then `pnpm hornet-swarm stats --project toolshop-lab`. Grok's swarm re-ran every journey three times through the MCP server, one agent per account. Every saved file, including traces and evidence zips, was scanned for the stored logins in plain, URL-encoded, base64, and JSON-escaped form, with no hits.

## Review

Grok's swarm checked this report against the page text in three re-tests. It added F-08 and the exact spellings above.

Corrections made along the way:

- Grok's first re-test doubted the cash-on-delivery account fields and the `missing value` postcode. Both hold. The page text of that time left out form-field values; the harness now records them.
- An earlier version of this report said the cash-on-delivery page showed "Errror 304 - Missing Payment Gateway" as an error. It is an option in the payment-method dropdown. The page text of that time included every dropdown option, so it read like a message. The harness now leaves options out, and F-02 rests on the disabled Confirm and the empty account fields alone.
- Chaos failures in many journeys at the same sign-in step are one finding (F-03), not several. Chaos summaries now group them.
- Grok's chaos round (seeds `shop-2` and `shop-3`, `docs/chaos-report-toolshop-lab.md`) added the billing, favourites, and contact cases to F-03, and showed that three browsers at once overload the lab on this Mac. The project now runs two at a time.
- Every report now uses the scale in `docs/severity.md`.

