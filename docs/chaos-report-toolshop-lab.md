# Chaos report: Toolshop lab, 14 October 2026

Normal runs and chaos runs of the local Toolshop lab, compared through the Hornet Swarm MCP server. The site runs on this Mac only. No live service was touched. Every customer and detail is made up. The lab was not reset.

## Scope

| | |
|---|---|
| Site | Toolshop, http://127.0.0.1:4300 (lab copy, this Mac only). The API is on port 8091. |
| Authorisation | `lab-owner` (owner basis), valid 2026-10-14 to 2027-01-12. Activities include sign-in checks, functional journeys, chaos, and access-control checks. Domains are localhost and host.docker.internal. Environment is test. |
| Accounts | qa-user-1 through qa-user-5, one MCP agent id per label. qa-user-6 (admin) signed in only. |
| Runs | Four suites per customer label, in order: normal, chaos profile `default` seed `shop-2`, chaos profile `slow-api` seed `shop-3`, normal again. |
| Journeys | cart and checkout (qa-user-1), register and search (qa-user-2), cart, cash on delivery, and checkout (qa-user-3), favourites and profile (qa-user-4), contact and profile (qa-user-5). |

Docker had about 2.11 GB free before the Toolshop runners started (about 5773 MiB in use of 7934 MiB), so Part 2 ran. After the runs, the six `hornet-swarm-toolshop-lab-*` runner containers were stopped. The lab's own api, ui, and database containers were left running.

The task asked for three labels at a time. The first wave of three normal suites, and a later wave of three, did not finish loading the login page within 15 seconds. Those runs were kept. Later suites were run one label at a time so the journeys could actually start. One pair (qa-user-3 and qa-user-4, default chaos) ran together and did sign in, with slow pages.

## Summary

The planted faults still fail when a journey is allowed to run: the search button reads "Serch", the product heading reads "Reltded products", the cart line total is $00.00, the profile swaps the name and shows "City not found", cash on delivery leaves Confirm disabled, and a bank payment says "Payment was successful" and then never says thanks. Long Nose Pliers still reads "Out of stock". That is the known seed line. The lab was not reset.

Chaos adds failures on journeys that pass, or that get further, without it. The most serious is a Confirm click that leaves the customer on the payment form with no success sentence and no error. Empty billing fields can also disable the next step. A contact form says first name, last name, and email are required after the message was typed. A favourites page says the list is empty. A sign-up stays on the filled form. Several journeys never leave the login page. None of these is a saved page that shows two payments or a missing total. Order history was not opened after the unconfirmed Confirm click.

After the chaos runs, a solo normal suite for each label signed in and reached the same planted failure it reaches when the shop is quiet. The chaos-only stops did not stick.

## How severity is judged

- **High:** money is wrong, a customer is locked out, or an order is lost.
- **Medium:** the customer is not told that something failed, or is told something false.
- **Low:** vague wording.

This scale is the one for this comparison. The sample report uses a different scale.

## Journeys, normal beside chaos

Pass means every step passed. A failure names the step and the words on the saved page text. "Not started" means the sign-in gate timed out and that journey was skipped.

| Journey | Normal | Chaos `default` / `shop-2` | Chaos `slow-api` / `shop-3` | Normal again |
|---|---|---|---|---|
| cart (qa-user-1) | Not started. `run_20261014-192145_79d55d` | Not started. `run_20261014-192520_7b0ec1` | Fail step 7. No add-to-cart. Page has "Reltded products". `run_20261014-194501_35477e` | Fail step 16. "Reltded products". `run_20261014-194652_08e372` |
| checkout (qa-user-1) | Not started. Same run. | Not started. Same run. | Fail step 23. Payment form still up. No "Payment was successful". `run_20261014-194501_35477e` | Fail step 25. "Payment was successful". No thanks. `run_20261014-194652_08e372` |
| register (qa-user-2) | Pass. `run_20261014-192145_945f64` | Pass. `run_20261014-192520_f396e3` | Fail step 14. Still on the registration form. `run_20261014-193736_3ce1da` | Pass. `run_20261014-193838_e31a86` |
| search (qa-user-2) | Fail step 8. "Serch". "Out of stock". `run_20261014-192145_945f64` | Fail step 8. Same words. `run_20261014-192520_f396e3` | Fail step 8. Same words. `run_20261014-193736_3ce1da` | Fail step 8. Same words. `run_20261014-193838_e31a86` |
| cart (qa-user-3) | Not started. `run_20261014-192145_cf73c6` | Fail step 16. "Reltded products". `run_20261014-192902_cb4bd1` | Fail step 5. Still on Login. `run_20261014-193940_322e9f` | Fail step 16. "Reltded products". `run_20261014-194217_2c5bbb` |
| cash-on-delivery (qa-user-3) | Not started. Same run. | Fail step 5. Still on Login. `run_20261014-192902_cb4bd1` | Fail step 16. Billing fields empty. Continue disabled. `run_20261014-193940_322e9f` | Fail step 19. Confirm disabled. `run_20261014-194217_2c5bbb` |
| checkout (qa-user-3) | Not started. Same run. | Fail step 7. No add-to-cart. "Reltded products". `run_20261014-192902_cb4bd1` | Fail step 18. Billing fields empty. Continue disabled. `run_20261014-193940_322e9f` | Fail step 25. "Payment was successful". No thanks. `run_20261014-194217_2c5bbb` |
| favourites (qa-user-4) | Pass. Combination Pliers listed. `run_20261014-192428_0a8b28` | Pass. `run_20261014-192902_644a91` | Fail step 11. "There are no favorites yet." `run_20261014-193327_dfa864` | Pass. Combination Pliers listed. `run_20261014-193637_b5c14b` |
| profile (qa-user-4) | Fail step 9. First name "Okafor". `run_20261014-192428_0a8b28` | Fail step 0. Login page did not finish loading. `run_20261014-192902_644a91` | Fail step 5. Still on Login. `run_20261014-193327_dfa864` | Fail step 9. First name "Okafor". `run_20261014-193637_b5c14b` |
| contact (qa-user-5) | Not started. `run_20261014-192520_2e5107` | Pass. "Thanks for your message! We will contact you shortly." `run_20261014-195008_dd75bb` | Fail step 11. "First name is required." `run_20261014-195137_188041` | Pass. Same thanks sentence. `run_20261014-195252_9386b2` |
| profile (qa-user-5) | Not started. Same run. | Fail step 9. First name "Marsh". `run_20261014-195008_dd75bb` | Fail step 5. Still on Login. `run_20261014-195137_188041` | Fail step 9. First name "Marsh". `run_20261014-195252_9386b2` |

qa-user-6 signed in only, on `run_20261014-195543_80a20c` (18 seconds). No journey was run for that label.

## Orders and payments after a chaos failure

No saved page shows two payments, a doubled total, or an order that disappeared.

The slow-api checkout for qa-user-1 clicked Confirm and stayed on the payment form. The next normal checkout (`run_20261014-194652_08e372`, `qa-user-1/checkout/failed-step-25.txt`) is a new checkout. It says "Payment was successful" and does not say "Thanks for your order!" `POST /invoices` returned 500. That is the planted missing confirmation, once, for that new checkout. The page does not list an earlier order.

qa-user-3's chaos checkouts never reached Confirm. The next normal checkout (`run_20261014-194217_2c5bbb`) shows the same single "Payment was successful" line and the same invoice 500.

Cart totals on the two recovery carts (`cart.txt` for both of those runs) read price $14.15, line total $00.00, order total $14.15. That $00.00 line is the planted cart display. It is the same on a normal run. It is not a second charge.

## Findings, worst first

These are journeys that get through on a quiet normal run and stop earlier, or stop on different words, under chaos. The chaos action is the one the analysis recorded for that step. Where the failed step has no chaos action, the finding names the last analysis action in that journey before it. The alignment matched every chaos run's action list, with `drop:spared the page load` as the only extra line.

### T-01 Confirm leaves the payment form up, with no success line and no error

- **Severity:** Medium. The customer is not told whether the payment went through. No saved page shows a second payment or a missing total, so this is not recorded as money that moved twice. Order history was not opened, so a silent order is not proven either.
- **Where:** qa-user-1 checkout, step 23, the check for "Payment was successful".
- **Chaos action:** `fail-api:twice` on step 23.
- **Page text** (`run_20261014-194501_35477e`, `qa-user-1/checkout/failed-step-23.txt`): "Payment" and "Confirm". The method is Bank Transfer. The account name is Lab Tester. The account number is 12345678. The words "Payment was successful" are not on the page.
- **Run:** `run_20261014-194501_35477e` (profile `slow-api`, seed `shop-3`). The following normal run `run_20261014-194652_08e372` does show "Payment was successful", then fails the planted thanks check at step 25.
- **Impact:** the customer has pressed Confirm and is still looking at the same payment form.

### T-02 Billing opens with an empty address, and the next step stays disabled

- **Severity:** Medium. The customer is not told that the address failed to load. They cannot continue.
- **Where:** qa-user-3 cash on delivery, step 16, and qa-user-3 checkout, step 18. The step numbers differ because the two journeys reach billing at different indexes. The page words match.
- **Chaos action:** cash on delivery has no action on step 16. The last one before it is `fail-api:once` on step 14, filling the postcode. Checkout has `fail-api:once` on step 18.
- **Page text** (both `failed-step-16.txt` and `failed-step-18.txt` in `run_20261014-193940_322e9f`): "Blliling Adress". Address empty, city empty, country empty, state NSW, postcode 2000. The disabled control has no name in the saved text.
- **Run:** `run_20261014-193940_322e9f` (profile `slow-api`, seed `shop-3`).
- **Recovery** (`run_20261014-194217_2c5bbb`, `checkout/billing-address.txt`): address "1 Test Street", city Testville, state NSW, country AU, postcode "missing value". Proceed worked. Cash on delivery then stopped at the planted disabled Confirm (step 19). Checkout then stopped at the planted missing thanks (step 25).
- **Impact:** under chaos the customer cannot leave billing. On the next normal run they can, and they then hit the planted payment faults.

### T-03 The contact form says the name and email are required

- **Severity:** Medium. The customer is told something false. The message was already typed.
- **Where:** qa-user-5 contact, step 11, the check for the thanks sentence.
- **Chaos action:** `slow-api:594ms` on step 11.
- **Page text** (`run_20261014-195137_188041`, `qa-user-5/contact/failed-step-11.txt`): "First name is required", "Last name is required", and "Email is required". First name, last name, and email are empty. Subject is "Customer service". The message is "Hello, this is a lab test message. My order arrived and I would like to ask about delivery times."
- **Runs:** failed on `run_20261014-195137_188041` (profile `slow-api`, seed `shop-3`). Passed on `run_20261014-195008_dd75bb` and `run_20261014-195252_9386b2`, both of which show "Thanks for your message! We will contact you shortly."
- **Impact:** a message that goes through on a quiet run is rejected with errors about fields this form did not use.

### T-04 Favourites says the list is empty

- **Severity:** Medium. The customer is told something false. The later normal run still lists the pliers, so the saved item was not deleted.
- **Where:** qa-user-4 favourites, step 11, the check for "Combination Pliers".
- **Chaos action:** step 11 has none. The last one before it is `fail-api:twice` on step 10, the navigation to the favourites page. That navigation's console log is `net::ERR_FAILED` twice.
- **Page text** (`run_20261014-193327_dfa864`, `qa-user-4/favourites/failed-step-11.txt`): "There are no favorites yet. In order to add favorites, please go to the product listing and mark some products as your favorite."
- **Runs:** failed on `run_20261014-193327_dfa864` (profile `slow-api`, seed `shop-3`). Favourites passed on `run_20261014-192428_0a8b28`, `run_20261014-192902_644a91`, and `run_20261014-193637_b5c14b`. The recovery list showed Combination Pliers. Adding it again returned HTTP 409, which also happens on the passing runs.
- **Impact:** the customer is told they have no favourites. The item is still there afterwards.

### T-05 Sign-up stays on the filled form

- **Severity:** Medium. The customer is not told that Register failed.
- **Where:** qa-user-2 register, step 14, the check that the URL contains `/auth/login`.
- **Chaos action:** step 14 has none. The last one before it is `fail-api:twice` on step 10, filling the phone. The Register click at step 13 has no chaos action. Its console log is `net::ERR_FAILED`.
- **Page text** (`run_20261014-193736_3ce1da`, `qa-user-2/register/failed-step-14.txt`): "Customer registration" is still the heading. The fields still hold Nova, Lab, 1991-03-09, 1 Test Street, postcode 2000, Testville, phone 0412345678. Country shows NSW. State shows Australia. The journey entered state NSW and then chose country Australia. The saved text does not contain a password value.
- **Runs:** failed on `run_20261014-193736_3ce1da` (profile `slow-api`, seed `shop-3`). Register passed on `run_20261014-192145_945f64`, `run_20261014-192520_f396e3`, and `run_20261014-193838_e31a86`.
- **Impact:** the form looks unsent. Whether that click also created an account was not checked. The next register run signed a new customer in.

### T-06 The signed-in menu never appears, and the page still says Login

- **Severity:** Medium. The customer is not told that sign-in failed. Nobody stayed locked out: each of these labels signed in on a later solo run, and qa-user-6 signed in on `run_20261014-195543_80a20c`.
- **Where:** the check for the signed-in menu, or the login navigation itself.
- **Page text:** "Login", "Sign in", and "Not yet an account? Register your account". The email field is filled on the step 5 pages (the saved text redacts it) and empty on the step 0 page.
- **Chaos action and run:**
  - qa-user-3 cash on delivery, step 5, `refresh:skipped (form in progress)` on that step. `run_20261014-192902_cb4bd1` (profile `default`, seed `shop-2`).
  - qa-user-3 cart, step 5, `fail-api:twice` on that step. `run_20261014-193940_322e9f` (profile `slow-api`, seed `shop-3`).
  - qa-user-4 profile, step 5, `slow-api:329ms` on that step. `run_20261014-193327_dfa864`.
  - qa-user-5 profile, step 5, `fail-api:once` on that step. `run_20261014-195137_188041`.
  - qa-user-4 profile, step 0, no chaos action on that step or earlier in the journey. The step is a navigation timeout. The saved text is the login page with an empty email. `run_20261014-192902_644a91`. Favourites in that same run passed.
- **Impact:** the journey stops on the login page. The same account gets in when the shop is not under that chaos step.

### T-07 The product page has the related-products heading and no product

- **Severity:** Medium. The page does not say the product failed to load, and there is no add-to-cart control.
- **Where:** step 7, waiting for add-to-cart. qa-user-1 cart and qa-user-3 checkout.
- **Chaos action:** qa-user-1 cart has `slow-api:951ms` on step 7 (`run_20261014-194501_35477e`). qa-user-3 checkout has no action on step 7. The last one before it is `drop:twice` on step 6 (`run_20261014-192902_cb4bd1`).
- **Page text** (`qa-user-1/cart/failed-step-7.txt` and `qa-user-3/checkout/failed-step-7.txt`): "User Data not found" and "Reltded products". No price and no "Add to cart".
- **Recovery:** both labels later opened the product, added it to the cart, and failed the planted heading check at step 16, where the full product is on the page and the heading is still "Reltded products".
- **Impact:** under chaos the customer never reaches the product. The misspelled heading on a fully loaded product page is the planted fault, and it still fails without chaos.

### T-08 Three runners together do not finish loading the login page

- **Severity:** Low. The saved text is the login page, so the site answered. The suite stopped because the page had not finished loading in 15 seconds. A single runner signs in in about 2 to 4 seconds (qa-user-4's first normal was 2.4 seconds). This is not a lockout.
- **Where:** the sign-in gate, before the journeys. qa-user-2's own register and search still ran, because those journeys sign in inside the journey. Cart, checkout, cash on delivery, contact, and profile were skipped when the gate failed.
- **Runs:** `run_20261014-192145_79d55d` (qa-user-1), `run_20261014-192145_945f64` (qa-user-2), `run_20261014-192145_cf73c6` (qa-user-3), `run_20261014-192520_7b0ec1` (qa-user-1, and this one was a chaos run with no journey actions), `run_20261014-192520_2e5107` (qa-user-5), `run_20261014-192520_f396e3` (qa-user-2).
- **Page text** (`run_20261014-192145_79d55d`, `qa-user-1/phase1/failed-step-0.txt`, same shape on the others): "Login", "Sign in", "Contakt", "Register".
- **Impact:** a quiet shop lets one customer in. Three browsers opening the login URL together stall the gate. The journeys were not weakened to get past it.

## Planted faults seen again

These fail on the normal runs that actually reach the step. Chaos does not create them. They match the sample report.

- Search step 8: the button reads "Serch", the sort reads "Sorth", and Long Nose Pliers reads "Out of stock" at $14.24. The other three pliers have prices. Seen on all four qa-user-2 search runs.
- Cart step 16, once the product page has loaded: "Related products" is missing and the closest text is "Reltded products". qa-user-1 `run_20261014-194652_08e372` and qa-user-3 `run_20261014-194217_2c5bbb` and `run_20261014-192902_cb4bd1`.
- Cart line: Combination Pliers, quantity 1, price $14.15, line total $00.00, order total $14.15. Two columns are headed Total. Both recovery `cart.txt` files.
- Profile step 9: qa-user-4 first name "Okafor", last name "Dev", city "City not found". qa-user-5 first name "Marsh". The nav reads "User Data not found" and the link reads "Contakt".
- Billing: heading "Blliling Adress", postcode "missing value", with the street and city filled in on the normal runs.
- Cash on delivery step 19: payment method Cash on Delivery, account name and number empty, "Confirm (disabled)". `run_20261014-194217_2c5bbb`.
- Checkout step 25: "Payment was successful", "Thanks for your order!" absent, `POST /invoices` 500. qa-user-1 `run_20261014-194652_08e372` and qa-user-3 `run_20261014-194217_2c5bbb`.
- The product page text on the qa-user-3 recovery cart contains "Oeps".

`GET /users/me` returns 401 on login and on several later pages. That 401 was already recorded and was not investigated again. No saved page text in these runs holds a password. Emails are redacted. No page opened a private area without the login form. Nothing new was added to a security report.

## What recovered

- Register, after the stuck form: the next normal run signed a new customer in.
- Favourites, after the empty list: the next normal run listed Combination Pliers.
- Contact, after the false required-field errors: the next normal run showed the thanks sentence.
- Sign-in, after the login-page stalls: each label signed in on a later solo suite. qa-user-6 signed in as well.
- The product page, after the empty related-products shell: later runs added Combination Pliers to the cart.
- Billing, after the empty address: the next normal run showed 1 Test Street and Testville and continued.
- Checkout, after the silent Confirm: the next normal run showed one "Payment was successful".

The planted faults did not recover. They failed again at the same step.

## What was not checked

- The customer's order list after the Confirm click that never showed "Payment was successful".
- Whether the stuck registration created an account as well as leaving the form up.
- qa-user-1 and qa-user-3's first normal suites never started their journeys, because three runners stalled the login page. The solo run afterwards is the normal comparison for those journeys.
- qa-user-6's admin journeys. That label signed in only.
- A hand abort of one request, separate from these chaos profiles.
- Restful Booker.
- No reset was run. Initialize, Clean, and JMS were not pressed. Those controls belong to ParaBank.

## Reliability

`get_reliability` for `toolshop-lab`, last 40 runs.

Without chaos: 40 runs, 12:57 to 19:52, 15 passed and 25 failed. 16 chaos runs were left out. Sign-in passed 36 of 40 (0.90), median 1551 ms, 95th percentile 7533 ms, last status pass. Contact, favourites, and register passed every attempt in the window (contact 3, one skipped; favourites 3; register 4). Cart, cash on delivery, checkout, profile, and search failed every attempt that ran. That is the planted faults, not a new outage. The window is wider than this matrix.

With `chaos: true`: 16 chaos runs, 08:31 to 19:51, all 16 failed. 74 runs without chaos were left out. This window includes older chaos runs from earlier the same day, not only seeds `shop-2` and `shop-3`. Sign-in passed 38 of 40 attempts (0.95), median 1627 ms, 95th percentile 22118 ms, last status pass. Contact, favourites, and register each passed 1 of 8. Cart failed 15 in a row, checkout 15, profile 16, cash on delivery 8, search 8. Those streaks mix the planted faults with the chaos-only stops above.
