# Chaos report: ParaBank lab, 14 October 2026

Normal runs and chaos runs of the local ParaBank lab, compared through the Hornet Swarm MCP server. The site runs on this Mac only. No live service was touched. Every customer and detail is made up. The lab was not reset. ParaBank's Initialize, Clean, and JMS controls were not pressed.

## Scope

| | |
|---|---|
| Site | ParaBank, http://127.0.0.1:8095/parabank/ (lab copy, this Mac only) |
| Authorisation | `lab-owner` (owner basis), valid 2026-10-14 to 2027-01-12. Activities include sign-in checks, functional journeys, chaos, and access-control checks. Domains are localhost and host.docker.internal. Environment is test. |
| Accounts | qa-user-1 through qa-user-5, one MCP agent id per label |
| Runs | Four suites per label, in order: normal, chaos profile `default` seed `bank-2`, chaos profile `slow-api` seed `bank-3`, normal again |
| Journeys | admin page (read only), find transactions, long username, twenty-character username, money adds up, transfer, bill pay, loan, profile, wrong password, profile keeps the password |

## Summary

The two failures that are already planted still fail on every normal run, and chaos does not change them. A 21-character username is refused with "This username already exists." Updating contact details still locks out the customer whose password contains a symbol.

Chaos adds six recovery problems. None of the saved overview pages shows money that moved twice or disappeared. Two of the chaos failures tell the customer something that is not true: a finished sign-up is shown again as "this username already exists", and Update Profile opens as a blank form while the customer is still signed in. A third leaves the transfer form with no accounts to choose. The other three are the same vague internal-error page, at three different steps.

After each chaos pair, the following normal suite passed every journey that had passed before chaos. The two planted failures failed again in the same place.

## How severity is judged

The shared scale in `docs/severity.md`:

- **High:** a customer cannot complete something the site exists for, or money is wrong, a customer is locked out, or an order or payment is lost.
- **Medium:** the customer can carry on, but sees wrong data, is told something false, or is not told that something failed.
- **Low:** wording, spelling, labels, ordering, or layout that does not stop anyone.

Chaos findings are rated by what the customer is left with once the disruption has happened.

## Journeys, normal beside chaos

Pass means every step passed. A failure names the step and the words on the saved page text.

| Journey | Normal | Chaos `default` / `bank-2` | Chaos `slow-api` / `bank-3` | Normal again |
|---|---|---|---|---|
| admin-page-readonly | Pass. `run_20261014-184639_6a8cac` | Pass. `run_20261014-185311_c36359` | Pass. `run_20261014-185549_e3ccd5` | Pass. `run_20261014-185930_d33966` |
| find-transactions-order | Pass. `run_20261014-184639_6a8cac` | Fail step 10. Internal error. `run_20261014-185311_c36359` | Pass. `run_20261014-185549_e3ccd5` | Pass. `run_20261014-185930_d33966` |
| long-username | Fail step 15. "This username already exists." `run_20261014-184639_6a8cac` | Fail step 15. Same words. `run_20261014-185311_c36359` | Fail step 15. Same words. `run_20261014-185549_e3ccd5` | Fail step 15. Same words. `run_20261014-185930_d33966` |
| twenty-char-username | Pass. `run_20261014-184639_6a8cac` | Pass. `run_20261014-185311_c36359` | Pass. `run_20261014-185549_e3ccd5` | Pass. `run_20261014-185930_d33966` |
| money-adds-up | Pass. Total $485.50. `run_20261014-184639_6a8cac` | Fail step 13. "This username already exists." `run_20261014-185311_c36359` | Fail step 26. Transfer form, no account chosen. `run_20261014-185549_e3ccd5` | Pass. Total $485.50. `run_20261014-185930_d33966` |
| bill-pay | Pass. $5.00 from account 16119. `run_20261014-184639_4c92d0` | Fail step 20. Internal error. `run_20261014-185311_d126ca` | Fail step 20. Internal error. `run_20261014-185549_8c3e89` | Pass. $5.00 from account 16452. `run_20261014-185930_a50274` |
| transfer | Pass. $1.00 from 13677 to 14010. `run_20261014-184639_4c92d0` | Pass. Same transfer. `run_20261014-185311_d126ca` | Fail step 10. Internal error. `run_20261014-185549_8c3e89` | Pass. Same transfer. `run_20261014-185930_a50274` |
| loan | Pass. Approved, account 19116. `run_20261014-184639_43ad18` | Pass. Approved, account 19782. `run_20261014-185311_934215` | Fail step 11. Internal error. `run_20261014-185549_58fd38` | Pass. Approved, account 20670. `run_20261014-185930_57faec` |
| profile | Pass. `run_20261014-190140_1aef8b` | Pass. `run_20261014-190234_0d87ac` | Fail step 7. Contact fields empty. `run_20261014-190335_cb2069` | Pass. `run_20261014-190413_020c4f` |
| wrong-password | Pass. `run_20261014-190140_1aef8b` | Pass. `run_20261014-190234_0d87ac` | Pass. `run_20261014-190335_cb2069` | Pass. `run_20261014-190413_020c4f` |
| profile-keeps-password | Fail step 25. "The username and password could not be verified." `run_20261014-190140_484a18` | Fail step 25. Same words. `run_20261014-190234_1403f8` | Fail step 25. Same words. `run_20261014-190335_6d4005` | Fail step 25. Same words. `run_20261014-190413_bb56dd` |

Sign-in passed on all twenty suites. No normal journey failed except `long-username` and `profile-keeps-password`.

## Balances after a chaos failure

No saved overview shows a balance that doubled or disappeared.

`money-adds-up` signs up a new customer on every run, so the recovery overview is a different customer from the one whose chaos run failed. The first normal overview (`run_20261014-184639_6a8cac`, `balances-after-payment.txt`) reads:

```
19449	$360.50	$360.50
19560	$125.00	$125.00
Total	$485.50
```

The recovery overview (`run_20261014-185930_d33966`, `balances-after-payment.txt`) reads:

```
21003	$360.50	$360.50
21114	$125.00	$125.00
Total	$485.50
```

That total is the $515.50 opening balance after $100 moved to savings, $25 moved back, and a $30 bill left. The activity page lists one $100 transfer, one $25 transfer, and one $30 bill payment.

On the slow-api failure, the same new customer had already passed the checks for total $515.50, then $415.50 and $100.00, before the transfer form failed. The journey stopped before it pressed Transfer, so that $25 was not sent.

Bill pay, transfer, and loan do not save an accounts-overview page. What they do save:

- Bill pay, next normal run: "Bill Payment to Testville Water in the amount of $5.00 from account 16452 was successful." The first normal run used account 16119. Each line is one payment. The page does not show a second copy of either payment.
- Transfer, default chaos and both normal runs: "$1.00 has been transferred from account #13677 to account #14010." The slow-api run stopped while opening an account, before this transfer.
- Loan: three passing runs approved three different accounts, 19116, 19782, and 20670. The failed run's page has no new account number.

## Findings, worst first

These are journeys that passed on the normal runs and failed under chaos. Failures that stop at the same step with the same page words are one finding. The chaos action is the one the run's analysis recorded for that step. Where the failed step itself has no chaos action, the finding names the last analysis action before it.

### C-01 A finished sign-up is shown again as "this username already exists"

- **Severity:** Medium. The customer is told something false. No balance page for this customer was saved, and the journey stopped before it moved money.
- **Where:** `money-adds-up`, step 13, the check for "Your account was created successfully".
- **Chaos action:** `refresh:refresh` on step 13. The Register click at step 12 had `refresh:skipped (form in progress)`, so the form was not wiped before it was sent.
- **Page text** (`run_20261014-185311_c36359`, `qa-user-1/money-adds-up/failed-step-13.txt`): the header says "Welcome Nova Ledger", and the form says "This username already exists."
- **Run:** `run_20261014-185311_c36359` (profile `default`, seed `bank-2`). The normal runs `run_20261014-184639_6a8cac` and `run_20261014-185930_d33966` passed this journey.
- **Impact:** the account exists (the customer is signed in) and the page says the name is taken. A person retries with other names.

This is separate from `long-username`, which fails at step 15 on normal runs as well.

### C-02 Update Profile opens blank while the customer is signed in

- **Severity:** Medium. The form shows empty contact details. The customer is not locked out.
- **Where:** `profile`, step 7, the check that the first name is still there.
- **Chaos action:** `slow-api:652ms` on step 7. The navigation to the profile page at step 6 was `fail-api:once`. That navigation's console log is "Failed to load resource: net::ERR_FAILED" three times, then "$ is not defined".
- **Page text** (`run_20261014-190335_cb2069`, `qa-user-4/profile/failed-step-7.txt`): "Welcome Kai Mint" and "Update Profile", with First Name, Last Name, Address, City, State, Zip Code, and Phone shown and every one of those fields empty. The step error is `field held ""`.
- **Run:** `run_20261014-190335_cb2069` (profile `slow-api`, seed `bank-3`). Profile passed on `run_20261014-190140_1aef8b`, `run_20261014-190234_0d87ac`, and `run_20261014-190413_020c4f`.
- **Impact:** a signed-in customer sees a blank profile. Saving it would wipe the address and phone. This run stopped on the empty check and did not press Update Profile.

The recovery page (`run_20261014-190413_020c4f`, `profile-after-update.txt`) shows first name Kai, last name Mint, and phone 0499999999.

### C-03 The transfer form has no accounts to choose

- **Severity:** Medium. The page does not say that the account list failed.
- **Where:** `money-adds-up`, step 26, waiting for a second account in the transfer list.
- **Chaos action:** `fail-api:once` on step 26. The navigation to the transfer page at step 25 was `fail-api:twice`.
- **Page text** (`run_20261014-185549_e3ccd5`, `qa-user-1/money-adds-up/failed-step-26.txt`): "Welcome Nova Ledger", "Transfer Funds", and "Amount: $". The account fields `fromAccountId` and `toAccountId` have nothing chosen.
- **Run:** `run_20261014-185549_e3ccd5` (profile `slow-api`, seed `bank-3`).
- **Earlier in the same run:** the new account was created, the total $515.50 check passed, the savings account opened, and the checks for $415.50, $100.00, and total $515.50 passed. The $25 transfer was not sent.
- **Impact:** the customer reaches Transfer Funds and cannot pick an account. The balances checked before that page still added up.

### C-04 Bill pay ends on an internal error after Send Payment

- **Severity:** Low. The wording names an internal error and does not say whether the $5.00 payment was sent. The following normal run's bill-pay page shows one successful payment and no second copy. There is no accounts-overview page for this customer in these runs, so a hidden debit would not appear here.
- **Where:** `bill-pay`, step 20, the check for "Bill Payment Complete". Both chaos runs stop here with the same words.
- **Chaos action:**
  - `run_20261014-185311_d126ca` (profile `default`, seed `bank-2`): step 20 has no chaos action. The last one before it is `latency:747ms` on step 18, filling the account number. The Send Payment click at step 19 has none.
  - `run_20261014-185549_8c3e89` (profile `slow-api`, seed `bank-3`): `fail-api:once` on step 20. The Send Payment click at step 19 was also `fail-api:once`.
- **Page text** (both `qa-user-2/bill-pay/failed-step-20.txt` files): "Welcome Omar Penny", "Error!", "An internal error has occurred and has been logged."
- **Impact:** the customer is told only that an internal error was logged. The recovery page says "Bill Payment to Testville Water in the amount of $5.00 from account 16452 was successful."

### C-05 A loan application ends on the same internal error

- **Severity:** Low, on the same wording. The error page has no new account number. The three passing loan runs each show one Approved decision and one new account (19116, 19782, 20670).
- **Where:** `loan`, step 11, the check for "Loan Request Processed".
- **Chaos action:** step 11 has no chaos action. The last one before it is `slow-api:930ms` on step 10, the Apply Now click.
- **Page text** (`run_20261014-185549_58fd38`, `qa-user-3/loan/failed-step-11.txt`): "Welcome Ruth Sterling", "Error!", "An internal error has occurred and has been logged."
- **Run:** `run_20261014-185549_58fd38` (profile `slow-api`, seed `bank-3`). The loan passed on `run_20261014-184639_43ad18`, `run_20261014-185311_934215` ("Your new account number: 19782", "Status: Approved"), and `run_20261014-185930_57faec` ("Your new account number: 20670").
- **Impact:** after Apply Now, the customer sees the generic error and no decision.

### C-06 Opening an account ends on the same internal error

- **Severity:** Low. Both journeys stop before any transfer or search. The page is the same generic error.
- **Where:** step 10, the check for "Account Opened!", on two journeys.
- **Chaos action:**
  - `find-transactions-order`, `run_20261014-185311_c36359` (profile `default`, seed `bank-2`): step 10 has no chaos action. The last one before it is `drop:once` on step 9, the Open New Account click.
  - `transfer`, `run_20261014-185549_8c3e89` (profile `slow-api`, seed `bank-3`): step 10 has no chaos action. The last one before it is `fail-api:once` on step 8, choosing the account type. The Open New Account click at step 9 has none.
- **Page text** (`qa-user-1/find-transactions-order/failed-step-10.txt` and `qa-user-2/transfer/failed-step-10.txt`): "Error!" and "An internal error has occurred and has been logged." The find-transactions page also says "Welcome Nova Ledger". The transfer page also says "Welcome Omar Penny".
- **Impact:** the new account is not confirmed. Find Transactions is never opened on the failed run. The $1.00 transfer is never started on the failed run. Both journeys passed on the surrounding normal runs, and transfer also passed under `default`.

## Failures that chaos did not change

- `long-username` step 15, every suite, normal and chaos. The page text is "This username already exists." `twenty-char-username` passed on all four qa-user-1 suites.
- `profile-keeps-password` step 25, every suite. The page text is "Error!" and "The username and password could not be verified."
- `wrong-password` passed on all four qa-user-4 suites. That journey expects the refusal.

## What recovered

On the normal suite after each label's two chaos suites:

- Find transactions, the twenty-character username, money adds up, bill pay, transfer, the loan, profile, the wrong-password check, and the read-only Admin Page all passed.
- Money adds up again showed total $485.50 for its new customer.
- Profile again showed Kai, Mint, and phone 0499999999.
- The loan was Approved again, account 20670.
- Bill pay and the $1.00 transfer each succeeded once on the recovery pages quoted above.
- The long username and the symbol-password profile update failed in the same place as before.

The kill switch stayed off. The lab was not reset.

## What was not checked

- Chaos profiles other than `default` and `slow-api`: latency, drop, offline, double-click, and history.
- An accounts overview for qa-user-2 or qa-user-3 after the internal-error pages. Those journeys do not save one.
- The `money-adds-up` customer from the `default` chaos run, after the sign-up page came back. That run saved no overview.
- Find Transactions by date or by transaction id. The failed chaos run never reached that page. The passing runs were not re-read for account order.
- Cross-account access.
- ParaBank's Initialize, Clean, and JMS controls.
- Restful Booker.

## Reliability

`get_reliability` for `parabank-lab`. The default window is the newest 20 runs of the chosen kind, so these figures include earlier ParaBank runs from today as well as this matrix. This matrix is 10 normal suites and 10 chaos suites. Every phase-1 sign-in in this matrix passed.

Without chaos (newest 20 non-chaos runs, from 16:59 to 19:04, 11 passed and 9 failed; 13 chaos runs left out):

| Journey | Attempts | Passed | Pass rate | Last |
|---|---|---|---|---|
| Sign-in | 20 | 20 | 1 | pass |
| long-username | 5 | 0 | 0 | fail, 5 in a row |
| profile-keeps-password | 4 | 0 | 0 | fail, 4 in a row |
| admin-page-readonly | 4 | 4 | 1 | pass |
| bill-pay | 2 | 2 | 1 | pass |
| find-transactions-order | 4 | 4 | 1 | pass |
| loan | 2 | 2 | 1 | pass |
| money-adds-up | 5 | 5 | 1 | pass |
| profile | 4 | 4 | 1 | pass |
| transfer | 2 | 2 | 1 | pass |
| twenty-char-username | 3 | 3 | 1 | pass |
| wrong-password | 5 | 5 | 1 | pass |

Sign-in p50 1825 ms, p95 2718 ms. The tool's note: long-username has failed 5 times in a row, profile-keeps-password has failed 4 times in a row.

With `chaos: true` (all 13 chaos runs, from 14:47 to 19:03, 11 failed and 2 passed; 71 runs without chaos left out):

| Journey | Attempts | Passed | Failed | Pass rate | Last |
|---|---|---|---|---|---|
| Sign-in | 23 | 22 | 1 | 0.957 | pass |
| bill-pay | 5 | 0 | 5 | 0 | fail, 5 in a row |
| long-username | 5 | 0 | 5 | 0 | fail, 5 in a row |
| money-adds-up | 5 | 0 | 5 | 0 | fail, 5 in a row |
| profile-keeps-password | 3 | 0 | 3 | 0 | fail, 3 in a row |
| loan | 5 | 1 | 4 | 0.2 | fail |
| transfer | 5 | 1 | 4 | 0.2 | fail |
| find-transactions-order | 2 | 1 | 1 | 0.5 | pass |
| profile | 5 | 3 | 1 (1 skipped) | 0.75 | fail |
| admin-page-readonly | 2 | 2 | 0 | 1 | pass |
| twenty-char-username | 2 | 2 | 0 | 1 | pass |
| wrong-password | 5 | 5 | 0 | 1 | pass |

Sign-in p50 1952 ms, p95 2655 ms. The one sign-in failure is outside this matrix. The tool's note: bill-pay, long-username, and money-adds-up have each failed 5 chaos runs in a row, and profile-keeps-password has failed 3.

## How this was produced

HEAD `17b5990`. Each label used its own `register_agent` id on `run_suite`, three labels at a time. Chaos was requested as `{ profile, seed }` on `run_suite`. Quotes are from the `.txt` page text saved beside each screenshot. The chaos action named for a failed step is the matching string in that run's `analysis.json` `chaos.actions` list.

## Review by Claude

- **C-01** came from the harness more than the bank. Chaos refreshed the page straight after Register was pressed (step 12), and reloading that page sent the sign-up a second time, which a browser does only after asking. The first sign-up had already worked ("Welcome Nova Ledger"). The bank's "This username already exists." on a resent form is at most Low, since a site that redirects after a form is sent avoids it. From 14 October the harness skips a refresh or back on a page that a sent form produced, and logs `refresh:skipped (the page came from a sent form)`.
- C-02 and C-03 are in the sample report as P-05. The scale above is the shared one in `docs/severity.md`.
