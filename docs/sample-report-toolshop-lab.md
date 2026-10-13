# Sample report: Toolshop lab, 14 October 2026

A practice deliverable, written the way a client report would be, from runs against the local Toolshop lab (Practice Software Testing, sprint 5 with deliberate bugs). The site runs on the tester's own Mac. No live service was touched. All accounts and details are made up.

## Scope

| | |
|---|---|
| Site | Toolshop, http://127.0.0.1:4300 (lab copy, this Mac only) |
| Authorisation | `lab-owner` (owner basis): sign-in checks, functional journeys, and chaos. Cross-account checks were out of scope. |
| Accounts | Five made-up customers and the seeded shop admin |
| Runs | 5 full suite runs without chaos, 1 chaos run (profile `default`, seed `lab-1`) |
| Journeys | search, cart, checkout, cash on delivery, favourites, profile, contact, sign-up |

## Summary

Sign-in works: 31 of 32 sign-ins passed (97%), with a median of 1.6 seconds. The one failure was a setup mistake in the first run, not the site. Three journeys work every time: contact, favourites, and sign-up. Five journeys fail every time, each at the same step, so each is a real and repeatable fault. The most serious is that a customer can pay and never get a confirmed order.

Under chaos, a sign-in request lost once leaves the customer on the login page with no error message.

## Findings, worst first

| ID | Finding | Severity | Where | How often |
|---|---|---|---|---|
| F-01 | An order is paid but never confirmed | High | Checkout, after payment | 10 of 10 attempts, 2 accounts |
| F-02 | Cash on delivery cannot be confirmed | High | Checkout, payment step | 5 of 5 |
| F-03 | A lost sign-in request shows no error | Medium | Login page | Seen under chaos, reproduced by hand |
| F-04 | The profile shows the last name as the first name | Medium | My account, profile | 10 of 10, 2 accounts |
| F-05 | The search button says "Serch" | Low | Home page | 5 of 5 |
| F-06 | The product page heading says "Reltded products" | Low | Product page | 10 of 10 |
| F-07 | Other text and display faults seen on screenshots | Low | Several pages | Every run |

### F-01 An order is paid but never confirmed

- **Steps:** sign in, open product 1, add to cart, open the cart, proceed twice, add the postcode and state, choose Bank Transfer, enter an account name and number, press Confirm, see "Payment was successful", press Confirm again.
- **Expected:** "Thanks for your order!" and an invoice number.
- **Actual:** the page stays on "Payment was successful". The request that creates the invoice (`POST /invoices`) returns 500.
- **Evidence:** run `run_20261014-082202_2a2c2b`, `qa-user-1/checkout/order-confirmed` was never reached; step 25 failed with `(page said: "Payment was successful")`. The same in every run since.
- **Impact:** customers believe they have paid and receive no order.

### F-02 Cash on delivery cannot be confirmed

- **Steps:** as F-01 up to the payment step, then choose Cash on Delivery.
- **Expected:** Confirm can be pressed. Cash on delivery needs no extra details.
- **Actual:** Confirm stays disabled. The bank account fields stay on screen.
- **Evidence:** `qa-user-3/cash-on-delivery/cash-on-delivery-chosen.png`, step 19.

### F-03 A lost sign-in request shows no error

- **Steps:** enter an email and password, press Login, and lose the network request once (a dropped connection on a mobile network has the same effect).
- **Expected:** a message such as "Could not sign in, please try again".
- **Actual:** nothing happens. The customer stays on the login page with the form filled in and no message.
- **Evidence:** chaos run `run_20261014-083903_e82cd0`, `qa-user-1` cart journey (drop at step 3, sign-in never completed). Reproduced by hand on this Mac by aborting one `POST /users/login`.

### F-04 The profile shows the last name as the first name

- **Steps:** sign in as a customer who signed up as Dev Okafor, open My account, then Profile.
- **Expected:** First name "Dev", last name "Okafor".
- **Actual:** the first name field holds "Okafor" and the last name field holds "Dev". The city field also shows "City not found" for a customer who signed up in Testville.
- **Evidence:** `qa-user-4/profile/profile.png`, step 9: `field held "Okafor"`.

### F-05 and F-06 Text faults that are checked every run

- The search button reads "Serch" (`qa-user-2/search/search-pliers.png`, step 8).
- The product page heading reads "Reltded products" (`qa-user-1/cart/product-page.png`, step 16).

### F-07 Seen on screenshots, not yet checked by a journey

- The top menu reads "Contakt".
- The account menu reads "User Data not found" instead of the customer's name (`qa-user-4/profile/profile.png`).
- The shop logo does not load.
- At checkout, the postcode given at sign-up is missing from the billing address.
- The contact form offers the subject "Error 101: Subject not found".

These are worth journeys of their own before a client report relies on them.

## What passed

- Every customer account signed in on every run without chaos.
- Contact: the message is sent and the page thanks the customer (5 of 5).
- Favourites: a saved product appears in the favourites list (5 of 5).
- Sign-up: a new customer signs up with a fresh address and signs straight in (5 of 5).

## What was not checked

- Cross-account access ("can one customer see another's invoice?"). Left out of this authorisation on purpose.
- The admin's catalogue and order pages. The admin signs in, but no admin journey was run yet.
- The stylesheet the page loads from a public CDN, which stayed blocked to keep the lab offline. Icons from it do not show on the screenshots.
- Restful Booker, the second lab, whose admin login is not stored yet.

## How this was produced

`node scripts/setup-lab.mjs`, then `pnpm hornet-swarm suite --project toolshop-lab` five times and once with `--chaos default --seed lab-1`, then `pnpm hornet-swarm stats --project toolshop-lab`. Every saved file, including traces and evidence zips, was scanned for the stored passwords in plain, URL-encoded, base64, and JSON-escaped form: 9 runs, 9,828 files and zip entries, no hits.
