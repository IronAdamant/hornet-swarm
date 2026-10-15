# Sample report: Juice Shop lab, 15 October 2026

A practice deliverable, written the way a client report would be, from runs against the local OWASP Juice Shop lab (image v20.3.0). The site runs on the tester's own Mac. No live service was touched. All accounts and details are made up. The shop's scoreboard and challenge pages were not opened. The customer feedback form asks for a captcha and was not submitted.

## Scope

| | |
|---|---|
| Site | OWASP Juice Shop, http://127.0.0.1:3010 (lab copy, this Mac only). Docker publishes that port on 127.0.0.1. |
| Authorisation | `lab-owner` (owner basis): sign-in checks, functional journeys, chaos, and access-control checks. The copy used for these runs covers this Mac only. Juice Shop's scoreboard and challenge pages are out of scope. |
| Accounts | Five made-up customers. A new address is signed up on the register journey, with `example.com` and a made-up security answer. |
| Runs | Two full suites without chaos, `run_20261015-213828_dab90f` and `run_20261015-214216_71fe63`, then one chaos suite, `run_20261015-214608_295e9d` (profile `default`, seed `lab-1`). Earlier single journeys proved each check before the suites. |
| Journeys | register, search, basket, checkout, order history, review, profile, and two accessibility journeys |

## Summary

On a quiet run the shop does the customer jobs it was asked to do. Both suites signed in all five accounts and passed all nine journeys. A new customer can register and sign in. Search finds Apple Juice. Two products can be added, a quantity changed, and the basket total becomes 5.97¤. Checkout with a made-up address and a made-up card ends on "Thank you for your purchase!" and the same 5.97¤. Order history then shows that order as "In Transit". A review is saved and shown. A username change sticks.

The faults on a quiet run are smaller. The card form's years start at 2080, so a current year cannot be chosen. The password rule and its counter disagree. The cookie notice stays after it is dismissed. A few labels and one confirmation sentence are worded wrongly. None of those stopped the two suites.

Under chaos, four journeys that had just passed stopped, and the page did not say the request had failed. Sign-in for the review stayed on Login and showed "TypeError: Failed to fetch". Sign-up stayed on the filled form. Apple Juice never appeared in the basket, which then showed only Banana Juice at 1.99¤. The new card was not saved, and the payment page showed no error. The orders already placed were still in history at 5.97¤. No second charge was taken, because the chaos checkout never reached "Place your order and pay".

## How severity is judged

The shared scale in `docs/severity.md`:

- **High:** a customer cannot complete something the site exists for, or money is wrong, a customer is locked out, or an order or payment is lost.
- **Medium:** the customer can carry on, but sees wrong data, is told something false, or is not told that something failed.
- **Low:** wording, spelling, labels, ordering, or layout that does not stop anyone.

Chaos adds the lost request or the delay. That disruption is not itself the finding. A chaos finding is what the customer is left with.

## Findings, worst first

| ID | Finding | Severity | Where | How often |
|---|---|---|---|---|
| J-01 | The card form offers no current year | Medium | Payment, new card | Every checkout that opened the form |
| J-02 | A lost request leaves the page as it was, with no error | Medium | Sign-in, sign-up, basket, payment | The one chaos suite. The two suites before it passed |
| J-03 | The password counter says 0/20 while the rule says 5 to 40 | Low | Sign-up | Every look at the empty form |
| J-04 | "Me want it!" does not dismiss the cookie notice | Low | Every fresh page | Every journey that clicked it |
| J-05 | Two continue buttons name the wrong next step | Low | Address, delivery | Every checkout |
| J-06 | A confirmation and a label are worded wrongly | Low | Review, order summary | Every review and every checkout |
| J-07 | Every fresh page says the language was changed | Low | Every page | Every run |

### J-01 The card form offers no current year

- **Steps:** sign in, add Apple Juice and Banana Juice, raise Apple Juice to two, go through address and Standard Delivery, open "Add new card", and open the control named Expiry Year.
- **Expected:** a customer can choose the current year. A test order can still be placed.
- **Actual:** the years on the control start at 2080. Choosing 2026 fails because that option is not there. Checkout completes only by choosing month 12 and year 2080. The saved row then reads `************1111`, Nia Peel, `12/2080`. The order confirmation still says "Thank you for your purchase!" and the total is 5.97¤.
- **Evidence:** `run_20261015-213158_0b6292`, journey `card-year`, step 11, select `role=combobox[name='Expiry Year']` with label 2026. The runner reported that it did not find some options. The saved page is "My Payment Options", with Expiry Year nothing chosen, and an older saved card already showing `12/2080`. The completed checkouts are `run_20261015-212441_ef0fd9` and `run_20261015-213723_57e18d`. `order-confirmed.txt` in the first of those says "Thank you for your purchase!", "Your order will be delivered in 5 days.", and 5.97¤. `order-summary.txt` says "Card ending in 1111".
- **Impact:** a real card that expires this decade cannot be entered. The made-up order still went through, and the money on the confirmation matched the basket, so this is not a lost payment.

### J-02 A lost request leaves the page as it was, with no error

The chaos suite used profile `default` and seed `lab-1`. Both suites before it, `run_20261015-213828_dab90f` and `run_20261015-214216_71fe63`, passed the same four journeys. The chaos action below is the one recorded for that step. Where the failed step itself has none, the note names the last action before it. `drop:spared the page load` means a lost page load was not applied, because dropping the page itself only shows the browser's error page.

| Where | What the customer was left with | Chaos action | Evidence |
|---|---|---|---|
| Sign-in, before a review | The page stays on Login. It says "TypeError: Failed to fetch", "Forgot your password?", and "Log in". The email is filled in. | `drop:twice` on step 3, filling the email. The Log in click at step 5 has none. Its console is `net::ERR_FAILED`. Step 7, the check for `/#/search`, has `slow-api:461ms`, which only waits. | `run_20261015-214608_295e9d`, qa-user-4 `review`, `failed-step-7.txt` |
| Sign-up | The page stays on "User Registration". The email, "Name of your favorite pet?", and Testville are still filled in. The counters read 19/20 and 19/40. There is no "Registration completed successfully. You can now log in." | `drop:twice` on step 6, filling the repeat password. The Register click at step 10 was `refresh:skipped (form in progress)`. Its console is `net::ERR_FAILED`. | Same run, qa-user-2 `register`, `failed-step-12.txt` |
| Add to basket | The basket shows only "Banana Juice (1000ml)", quantity 1, "Total Price: 1.99¤", and a basket count of 1. Apple Juice is absent. Nothing says the add failed. The 1.99¤ matches the one line that is there. | `drop:twice` on step 9, waiting for the Apple Juice button. The add click at step 10 has `slow-api:994ms` and console `net::ERR_FAILED`. The failed check at step 17 has none. | Same run, qa-user-3 `basket`, `failed-step-17.txt` |
| Save a card | The page stays on "My Payment Options". The new-card form is still open. Continue is disabled. There is no "Your card ending with 1111 has been saved for your convenience." Older saved rows still show `************1111` and `12/2080`. | `drop:once` on step 47, choosing the expiry month. The save click at step 49 has none. Its console is `net::ERR_FAILED`. The failed check at step 50 has none. | Same run, qa-user-1 `checkout`, `failed-step-50.txt` |

- **Expected:** a sentence such as "Something went wrong, please try again", and a way to retry.
- **Impact:** the customer cannot tell whether to wait or to press the button again. Nobody was locked out. The chaos checkout never placed the order, and order history in the same run still listed the earlier orders at 5.97¤ and "In Transit". After the leftover basket rows were removed, a later checkout completed again. That run is named under "What recovered".

### J-03 The password counter says 0/20 while the rule says 5 to 40

- **Steps:** open `/#/register` before typing.
- **Expected:** the counter matches the rule on the page.
- **Actual:** the page says "Password must be 5-40 characters long." The password counter reads 0/20. The repeat-password counter reads 0/40.
- **Evidence:** `run_20261015-210035_541325`, inspect of `/#/register`. The same two counters, filled to 19/20 and 19/40, are on the chaos sign-up page above. A 19-character password is accepted, and register then reaches "Registration completed successfully. You can now log in." (`run_20261015-211840_8eaa88`).

### J-04 "Me want it!" does not dismiss the cookie notice

- **Steps:** on a fresh page, click the control whose accessible name is "dismiss cookie message". The visible words are "Me want it!".
- **Expected:** the notice goes away, as the welcome banner does when "Dismiss" is clicked.
- **Actual:** the click is accepted, and the notice stays. The page still starts with "This website uses fruit cookies to ensure you get the juiciest tracking experience. But me wait!" and "Me want it!".
- **Evidence:** `run_20261015-212132_49a8a8`, `search-apple.txt`, after the journey had clicked the control. The same notice is still in the accessibility results for the catalogue. "But me wait!" is a link to a video and was not opened.
- **Impact:** the customer can keep shopping. The notice sits over the bottom of the page, and its text is too faint (A-01 in the accessibility report).

### J-05 Two continue buttons name the wrong next step

- **Steps:** at "Select an address", continue. At "Choose a delivery speed", continue again.
- **Expected:** the button names the page it opens.
- **Actual:** the address button's accessible name is "Proceed to payment selection", and the next heading is "Choose a delivery speed". The delivery button's accessible name is "Proceed to delivery method selection" while that heading is already on screen, and the next heading is "My Payment Options".
- **Evidence:** delivery inspect `run_20261015-210601_be8b8b` (heading "Choose a delivery speed", button "Proceed to delivery method selection", rows "One Day Delivery" 1 Days, "Fast Delivery" 3 Days, "Standard Delivery" 5 Days). Checkout `run_20261015-212441_ef0fd9` passed the address button and then showed "Choose a delivery speed", then "My Payment Options".

### J-06 A confirmation and a label are worded wrongly

- **Review:** after "Send the review", the page says "You review has been saved." The review itself is shown: "Tastes like apples. 438a6a". Evidence: `run_20261015-212403_438a6a`, `review-shown.txt`.
- **Order summary:** the card line reads `Card Holder" Nia Peel`, with a stray quote after Holder. The same page says "Card ending in 1111" and "Place your order and pay". Evidence: `run_20261015-212441_ef0fd9`, `order-summary.txt`.

### J-07 Every fresh page says the language was changed

- **Actual:** a page that was just opened says "Language has been changed to English" and "Force page reload", although the journey never changed the language.
- **Evidence:** `run_20261015-212132_49a8a8`, `search-apple.txt`, and the register inspect `run_20261015-210035_541325`.

## What passed

| Journey | What the page showed | Run |
|---|---|---|
| Register | "Registration completed successfully. You can now log in." Then the new email is in the account menu. | `run_20261015-211840_8eaa88`, and both suites |
| Search | "Search Results - Apple", "Apple Juice (1000ml)" 1.99¤, "Apple Pomace" 0.89¤, "Pineapple Juice (1000ml)" 2.99¤ | `run_20261015-212132_49a8a8` |
| Basket | "Total Price: 5.97" after Apple Juice quantity 2 and Banana Juice quantity 1, then the rows are removed and the total is 0 | `run_20261015-212403_66bbf7` |
| Checkout | "The address at Testville has been successfully added to your addresses." Then "Thank you for your purchase!" and 5.97¤ | `run_20261015-212441_ef0fd9`, `run_20261015-213723_57e18d` |
| Order history | "Order History", "In Transit", Apple Juice quantity 2, Banana Juice quantity 1, 5.97¤ | `run_20261015-212631_b3054c` |
| Review | "You review has been saved." and the review text in the list | `run_20261015-212403_438a6a` |
| Profile | "User Profile", "Set Username", and the new name after save | `run_20261015-212441_b863b0` |
| Both suites | 5 of 5 sign-ins, 9 of 9 journeys. Accessibility problems were recorded and did not fail the run. | `run_20261015-213828_dab90f`, `run_20261015-214216_71fe63` |

Search is opened as `/#/search?q=Apple`, which is the address the search box produces. The box itself submits only on Enter, and a journey has no Enter step.

The basket total is Apple Juice at 1.99¤ twice (3.98¤) plus Banana Juice at 1.99¤, with Standard Delivery at 0.00¤. The confirmation repeats 5.97¤ for the items and for the total.

## What recovered

Order history during the chaos suite (`run_20261015-214608_295e9d`, `order-history.txt`) still listed the earlier orders, each "In Transit" at 5.97¤, with Apple Juice quantity 2 and Banana Juice quantity 1. The chaos checkout did not add another order.

The failed chaos checkout left Apple Juice and Banana Juice in qa-user-1's basket, and the failed add left Banana Juice in qa-user-3's basket. Those rows were removed (`run_20261015-220624_a588b2` and `run_20261015-220646_81389a`). Each page then said "Total Price: 0". Checkout after that clear passed again: `run_20261015-220719_13a6de` reached "Thank you for your purchase!" with the same 5.97¤. The card-save failure did not stick.

Search, profile, order history, and both accessibility journeys passed inside the chaos suite. Phase-1 sign-in passed for all five accounts.

## What was not checked

- The customer feedback form at `/#/contact`. Inspect `run_20261015-210451_59c4bf` shows "Customer Feedback" and "Field for the result of the CAPTCHA code", with the submit control disabled. The form was not submitted. No captcha was solved.
- The scoreboard and the challenge pages. They were not opened.
- Deluxe membership, the wallet, coupons, the off-site card link, and the share link on the confirmation. None of those were clicked.
- A second chaos profile. This round is `default` with seed `lab-1` only.
- Whether the sign-up that stayed on the form had already created the account. The page did not say it had, and the new address was not used again.

## Reliability

`pnpm hornet-swarm stats --project juice-shop-lab` on 15 October, newest 20 runs without chaos, from 21:19 to 21:42. One chaos run was left out. Sign-in passed 32 of 32, median 2737 ms, 95th percentile 2922 ms.

Those 20 runs mix the two passing suites with earlier drafts of the journeys. The failed search, basket, and checkout attempts in that window were selector mistakes in the drafts (a card name that also matched Pineapple Juice, a quantity icon that was not in the page, and a second Testville address row). They were fixed before `run_20261015-213828_dab90f`. They are not shop faults. `card-year` failed both times because 2026 is not in the year list (J-01). `clear-basket` is the tidy-up after chaos, and it passed.

With `--chaos`: one run, `run_20261015-214608_295e9d`. Sign-in 5 of 5. Basket, checkout, register, and review failed once each. Search, profile, order history, and both accessibility journeys passed. The tool's note: fewer than five chaos runs, so the rates are this round only.

## How this was produced

Each page was opened with `inspect` before its journey was written. Selectors marked as checked were preferred. Role selectors use single quotes. The suites ran two browsers at a time. Quotes are from the `.txt` saved beside each screenshot, or from the inspect JSON. The accessibility grades are in `docs/accessibility-report-juice-shop-lab.md`. The light security pass is in `docs/security-report-juice-shop-lab.md`.
