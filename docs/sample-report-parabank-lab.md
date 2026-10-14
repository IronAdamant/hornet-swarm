# Sample report: ParaBank lab, 14 October 2026

A practice deliverable, written the way a client report would be, from runs against the local ParaBank lab (Parasoft's demo online bank). The site runs on the tester's own Mac. No live service was touched. All customers and details are made up.

## Scope

| | |
|---|---|
| Site | ParaBank, http://127.0.0.1:8095/parabank/ (lab copy, this Mac only) |
| Authorisation | `lab-owner` (owner basis): sign-in checks, functional journeys, and chaos. From 14 October it also grants access-control checks, used by one read-only check of the Admin Page; that check's findings are in Grok's `docs/security-report-parabank-lab.md`. Cross-account checks were not run. |
| Accounts | Five made-up customers, each opened with $515.50 |
| Runs | Claude's first runs, then two re-tests by Grok's swarm through the MCP server, one agent per account; normal runs and chaos runs (profile `default`, seed `bank-1`) |
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
| P-03 | A lost request shows only "An internal error has occurred" | Low | Money adds up, transfer, bill pay, loan | Every chaos run |
| P-04 | The account order on Find Transactions is not stable | Low | Find Transactions | Seen once in two runs |

### P-01 Updating contact details breaks sign-in for a password with a symbol

- **Steps:** sign up with a password that contains `#`, open Update Contact Info, change the phone number, press Update Profile ("Profile Updated"), log out, and log in with the same password.
- **Expected:** the customer signs straight back in. Contact details have nothing to do with the password.
- **Actual:** "The username and password could not be verified." The customer is locked out.
- **Cause (found by Grok's swarm):** the Update Profile page sends the password in a web address without encoding it. A `#` ends the value there, so the bank saves only the part before it.
- **Evidence:** journey `profile-keeps-password` (qa-user-5), step 25, on every run: `run_20261014-163351_c2734b`, and Grok's `run_20261014-165938_fd3ea3`, `run_20261014-170017_580e8d`, `run_20261014-170115_d27842`, and chaos run `run_20261014-170308_52cc01`. Step 18 says "Profile Updated" and the update request answers 200, but the password it carries is 16 characters long: the part before the `#`. Grok's runs `run_20261014-151418_a9f7e2` (profile update) then `run_20261014-151437_ad352a` (sign-in refused) show the same for an existing customer. qa-user-4, whose password has only letters and digits, updated the phone three times and still signed in.
- **Impact:** customers who update their address or phone are locked out without warning.

### P-02 A new username over 20 characters is refused as "already exists"

- **Steps:** sign up with a new 21-character username that nobody has used.
- **Expected:** the account is created, or the page says the name is too long.
- **Actual:** "This username already exists." A 20-character name is accepted; 21 or more is refused the same way.
- **Evidence:** journey `long-username`, step 15, on every run, normal and chaos (`run_20261014-163351_c2734b`; Grok's `run_20261014-165729_298172`, `run_20261014-165747_ee0526`, `run_20261014-165804_6a90f0`, `run_20261014-170308_52cc01`). The field held a new name such as `longname298172abcdefg`.
- **The 20-character cutoff:** run `run_20261014-180803_ccd8d5` records both sides. Journey `twenty-char-username` signed up a new 20-character name ("Your account was created successfully"), and `long-username` was refused for 21 characters. A hand check of 15, 16, 22, and 23 characters, sent straight to the lab's form outside the harness, agreed.
- **Impact:** a customer tries other names believing theirs is taken.

### P-03 A lost request shows only "An internal error has occurred"

- **Seen in:** chaos runs `run_20261014-144734_2f5d66`, `run_20261014-152902_94f98d`, and `run_20261014-170308_52cc01`. When a request was lost, money adds up (step 46), transfer (step 16), bill pay (step 20), and loan (step 11) showed "Error!" and "An internal error has occurred and has been logged." Each of those passes without chaos. Profile and wrong password passed under chaos.
- **Good:** the customer is told something went wrong, and no money moved.
- **Could be better:** the message does not say whether to try again or whether money moved.

### P-04 The account order on Find Transactions is not stable

- **Run `run_20261014-144344_088009`:** the page's dropdown, in the network log, listed the new savings account `15342` before the main account `15231`, so it started on the savings account. A search for a bill payment from the main account found nothing.
- **Grok's run `run_20261014-170749_58cb0b`:** the page listed the older account `13566` before the new `18117`, and started on the older one.
- **So:** the order is not newest first every time; it changes between customers. Every other page lists the main account first. The journey `find-transactions-order` records which account the page starts on, so more runs will show how often it starts on the wrong one.
- **Impact:** a customer may search the wrong account and think a payment is missing. Low until it is seen more.

## What passed

- Money adds up: after opening a savings account with $100, a $25 transfer, and a $30 bill payment, the balances read $360.50 and $125.00 and the total reads $485.50, every run.
- Transfer: "$1.00 has been transferred from account #... to account #...".
- Bill pay: mismatched account numbers are refused ("The account numbers do not match.", in the bill pay page's response at step 17); matching ones go through ("Bill Payment to Testville Water in the amount of $5.00 ... was successful.").
- Loan: a $1,000 loan with $100 down gets a decision on screen ("Approved").
- Contact details: a new phone number is saved and still shown after reloading the page.
- Wrong password: refused with "The username and password could not be verified.", and no account page opens.

## What was not checked

- Cross-account access. Not run.
- Security. Grok's swarm reports its own security findings separately, including on the Admin Page, which it viewed without using.
- The bank's web services, and the Admin Page's Initialize, Clean, and JMS controls, which were not pressed.
- Find Transactions by date or transaction id.

## How this was produced

`node scripts/setup-lab.mjs`, then `pnpm hornet-swarm env up --project parabank-lab` and `pnpm hornet-swarm suite --project parabank-lab`, normally and with `--chaos default --seed bank-1`. Grok's swarm re-ran every journey through the MCP server twice, found the cause of P-01, and checked this report against the page text. The made-up customers' passwords are letters and digits, except qa-user-5's, which keeps a symbol so the `profile-keeps-password` journey shows P-01 until it is fixed.

## Review

Grok's second re-test checked every finding against its own runs. P-01, P-02, and P-03 held, and their evidence now cites those runs. Two corrections were made. Grok pointed out that no saved run recorded the 20-character cutoff; the `twenty-char-username` journey now does. P-04 was first written as "newest first"; Grok's run showed the opposite order, so it now says the order is not stable. Grok's reading that the first run had no dropdown came from the page text, which leaves dropdown options out by design; the network log of that run has them.

