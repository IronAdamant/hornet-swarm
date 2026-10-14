# Sample report: ParaBank lab, 14 October 2026

A practice deliverable, written the way a client report would be, from runs against the local ParaBank lab (Parasoft's demo online bank). The site runs on the tester's own Mac. No live service was touched. All customers and details are made up.

## Scope

| | |
|---|---|
| Site | ParaBank, http://127.0.0.1:8095/parabank/ (lab copy, this Mac only) |
| Authorisation | `lab-owner` (owner basis): sign-in checks, functional journeys, and chaos. Cross-account checks and security testing were out of scope. |
| Accounts | Five made-up customers, each opened with $515.50 |
| Runs | Claude's first runs, then a re-test by Grok's swarm through the MCP server, one agent per account; normal runs and chaos runs (profile `default`, seed `bank-1`) |
| Journeys | money adds up, transfer, bill pay, loan, profile, wrong password, long username, profile keeps the password |

## Summary

The money is right. A new customer opens a savings account, moves money into it, and pays a bill, and every balance and the total match what moved, on every run. Transfers, bill payments (including refusing mismatched account numbers), loan decisions, contact-detail updates, and the wrong-password message all work.

Two faults stand out. Updating contact details breaks sign-in for a customer whose password contains a symbol, and a long new username is refused with a message that is not true.

## How severity is judged

- **High:** a customer cannot do something the site exists for, or is locked out.
- **Medium:** a customer can carry on, but is misled or left without feedback.
- **Low:** wording, ordering, or layout that does not stop anyone.

## Findings, worst first

| ID | Finding | Severity | Where | How often |
|---|---|---|---|---|
| P-01 | Updating contact details breaks sign-in for a password with a symbol | High | Update Contact Info | Every run |
| P-02 | A new username over 20 characters is refused as "already exists" | Medium | Register | Every run |
| P-03 | A lost request shows only "An internal error has occurred" | Low | Transfer, bill pay, loan | Under chaos |
| P-04 | Find Transactions lists accounts newest first and defaults to the wrong one | Low | Find Transactions | Seen once |

### P-01 Updating contact details breaks sign-in for a password with a symbol

- **Steps:** sign up with a password that contains `#`, open Update Contact Info, change the phone number, press Update Profile ("Profile Updated"), log out, and log in with the same password.
- **Expected:** the customer signs straight back in. Contact details have nothing to do with the password.
- **Actual:** "The username and password could not be verified." The customer is locked out.
- **Cause (found by Grok's swarm):** the Update Profile page sends the password in a web address without encoding it. A `#` ends the value there, so the bank saves only the part before it.
- **Evidence:** journey `profile-keeps-password` (qa-user-5), run `run_20261014-163351_c2734b`, step 25. Grok's runs `run_20261014-151418_a9f7e2` (profile update) then `run_20261014-151437_ad352a` (sign-in refused) show the same for an existing customer. A customer whose password has only letters and digits is not affected.
- **Impact:** customers who update their address or phone are locked out without warning.

### P-02 A new username over 20 characters is refused as "already exists"

- **Steps:** sign up with a new 21-character username that nobody has used.
- **Expected:** the account is created, or the page says the name is too long.
- **Actual:** "This username already exists." A 20-character name is accepted; 21 or more is refused the same way.
- **Evidence:** journey `long-username`, every run, step 15 (`run_20261014-163351_c2734b`). The cutoff was confirmed by signing up names of 15, 16, 20, 21, 22, and 23 characters.
- **Impact:** a customer tries other names believing theirs is taken.

### P-03 A lost request shows only "An internal error has occurred"

- **Seen in:** chaos runs `run_20261014-144734_2f5d66` and `run_20261014-152902_94f98d`. When a request was lost, transfer, bill pay, and loan pages showed "Error!" and "An internal error has occurred and has been logged."
- **Good:** the customer is told something went wrong, and no money moved.
- **Could be better:** the message does not say whether to try again or whether money moved.

### P-04 Find Transactions lists accounts newest first

- **Seen in:** run `run_20261014-144344_088009`. The Find Transactions page listed the new savings account before the main account, while every other page lists the main account first, so a search for a bill payment looked in the wrong account and found nothing.
- **Impact:** a customer may think a payment is missing. Seen once; not yet checked by its own journey.

## What passed

- Money adds up: after opening a savings account with $100, a $25 transfer, and a $30 bill payment, the balances read $360.50 and $125.00 and the total reads $485.50, every run.
- Transfer: "$1.00 has been transferred from account #... to account #...".
- Bill pay: mismatched account numbers are refused ("The account numbers do not match."); matching ones go through.
- Loan: a $1,000 loan with $100 down gets a decision on screen ("Approved").
- Contact details: a new phone number is saved and still shown after reloading the page.
- Wrong password: refused with "The username and password could not be verified.", and no account page opens.

## What was not checked

- Cross-account access and any other security testing. Out of scope for this authorisation; covered separately.
- The Admin Page and the bank's web services.
- Find Transactions by date or transaction id.

## How this was produced

`node scripts/setup-lab.mjs`, then `pnpm hornet-swarm env up --project parabank-lab` and `pnpm hornet-swarm suite --project parabank-lab`, normally and with `--chaos default --seed bank-1`. Grok's swarm re-ran every journey through the MCP server and found the cause of P-01. The made-up customers' passwords are letters and digits, except qa-user-5's, which keeps a symbol so the `profile-keeps-password` journey shows P-01 until it is fixed.
