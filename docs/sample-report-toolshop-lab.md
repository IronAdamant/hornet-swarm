# Sample report: Toolshop lab, 14 October 2026

A practice deliverable, written the way a client report would be, from runs against the local Toolshop lab (Practice Software Testing, sprint 5 with deliberate bugs). The site runs on the tester's own Mac. No live service was touched. All accounts and details are made up.

## Scope

| | |
|---|---|
| Site | Toolshop, http://127.0.0.1:4300 (lab copy, this Mac only) |
| Authorisation | `lab-owner` (owner basis): sign-in checks, functional journeys, and chaos. Cross-account checks were out of scope. |
| Accounts | Five made-up customers and the seeded shop admin |
| Runs | Claude's first pass, then three re-tests by Grok's swarm on 14 October; normal runs and chaos runs (profile `default`, seed `lab-1`) |
| Journeys | search, cart, checkout, cash on delivery, favourites, profile, contact, sign-up |

## Summary

Sign-in works: every customer account signed in on every run without chaos, with a median of about 1.5 seconds. Three journeys work every time: contact, favourites, and sign-up. Five journeys fail every time, each at the same step, so each is a real and repeatable fault. The most serious is that a customer can pay and never get a confirmed order, and that cash on delivery cannot be completed at all.

Under chaos, the shop never tells the customer when a request fails. A lost sign-in, sign-up, message, or payment check leaves the page as it was, with no error.

## How severity is judged

- **High:** a customer cannot complete something the site exists for, such as paying for an order.
- **Medium:** a customer can carry on, but sees wrong data or is left without feedback.
- **Low:** wording, spelling, layout, or labels that do not stop anyone.

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
| F-07 | Other text, label, and display faults | Low | Several pages | Every run |

### F-01 An order is paid but never confirmed

- **Steps:** sign in, open product 1, add to cart, open the cart, proceed twice, add the postcode and state, choose Bank Transfer, enter an account name and number, press Confirm, see "Payment was successful", press Confirm again.
- **Expected:** "Thanks for your order!" and an invoice number.
- **Actual:** the page stays on "Payment was successful". The request that creates the invoice (`POST /invoices`) returns 500.
- **Evidence:** run `run_20261014-082202_2a2c2b`, step 25 failed with `(page said: "Payment was successful")`. The network log shows `POST /payment/check` 200, then `POST /invoices` 500. The same in every run since, including Grok's `run_20261014-140940_8776ca` and `run_20261014-141715_7e59d7`.
- **Impact:** customers believe they have paid and receive no order.

### F-02 Cash on delivery cannot be confirmed

- **Steps:** as F-01 up to the payment step, then choose Cash on Delivery.
- **Expected:** Confirm can be pressed. Cash on delivery needs no extra details.
- **Actual:** Confirm stays disabled. The bank-transfer fields "Your Account name *" and "Your Account number *" stay on the form, empty, as if they were still required.
- **Evidence:** run `run_20261014-141815_3b7810`, `qa-user-3/cash-on-delivery/failed-step-19.txt`: `payment-method: Cash on Delivery`, both account fields `(empty)`, and `Confirm (disabled)`. The screenshot beside it shows the same.

### F-03 The shop never says when a request fails

When the network loses one request, the page stays as it was and shows nothing. The customer cannot tell whether to wait, retry, or give up. Seen four ways:

| Where | What happened | Evidence |
|---|---|---|
| Sign-in | Login pressed, request lost: the customer stays on the login page, form filled in, no message | Reproduced by hand by aborting one `POST /users/login`. In Grok's chaos run `run_20261014-142116_7f1685`, five journeys stopped at the same sign-in step |
| Sign-up | The form stays up after Register, with no message | Same chaos run, `qa-user-2` register, step 14 |
| Contact | No thanks message and no error; the form stays up with the message typed in | Same chaos run, `qa-user-5` contact, step 11 |
| Payment | "Payment was successful" never appears, and the payment form stays as filled in | Same chaos run, `qa-user-3` checkout, step 23 |

Only the sign-in case has been reproduced by hand. The other three come from chaos runs, where a dropped request is the likely cause.

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

- Every customer account signed in on every run without chaos.
- Contact: the message is sent and the page thanks the customer.
- Favourites: a saved product appears in the favourites list.
- Sign-up: a new customer signs up with a fresh address and signs straight in.

## What was not checked

- Cross-account access ("can one customer see another's invoice?"). Left out of this authorisation on purpose.
- The admin's catalogue and order pages. The admin signs in, but no admin journey was run yet.
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
