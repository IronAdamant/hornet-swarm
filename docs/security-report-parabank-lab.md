# Security report: ParaBank lab, 14 October 2026

Written from runs on the local ParaBank lab. The site is on this Mac only. No other host was opened. Customers and details are made up. This is the security write-up. The functional report is `docs/sample-report-parabank-lab.md`, and it was not changed.

## Scope

| | |
|---|---|
| Site | ParaBank, http://127.0.0.1:8095/parabank/ (lab copy). Docker publishes that port on 127.0.0.1 only. |
| Authorisation | `lab-owner` (owner basis): `signin_smoke`, `functional_e2e`, `chaos`, and, since the owner's written approval on 14 October 2026, `access_control_checks`. The approval covers reading the Admin Page. It does not cover pressing Initialize, Clean, or JMS, or cross-account checks. |
| Accounts | Five made-up customers. qa-user-5 is the one whose password contains a symbol, so the profile journey can show the update fault. |
| Runs used | `run_20261014-170842_e1c117` for the Admin Page. Profile runs `run_20261014-165938_fd3ea3`, `run_20261014-170017_580e8d`, `run_20261014-170115_d27842`, and chaos run `run_20261014-170308_52cc01`. An earlier profile run, `run_20261014-163126_a9b11a`, has the same saved-request shape. |
| Not in this pass | Restful Booker. Its runners were stopped. No security pass was made on it. |

## Summary

Two security findings. The Admin Page is linked from the public header and loads with no customer signed in, including the database and JMS controls. Update Profile puts the password in the request URL without encoding it, and the saved network log kept a 16-character prefix of that password. The functional report already covers the lock-out that follows. This report covers the credential in the URL and in the saved run.

The harness now masks a credential query value of at least 8 characters, including a prefix of a stored secret. The test is `masks a password query that a hash cut down to a prefix` in `test/unit/redactor.test.ts`.

## How severity is judged

- **High:** a control that can wipe or reconfigure the lab is reachable with no customer signed in, or a password is written into a URL or a saved run.
- **Medium:** a credential or a control is exposed more narrowly, and using it still takes another step.
- **Low:** hardening that does not expose a credential or a destructive control.

## Findings, worst first

| ID | Finding | Severity | Where | How often |
|---|---|---|---|---|
| S-01 | Admin Page loads with no customer signed in | High | Public header, Admin Page | The one read-only run |
| S-02 | Update Profile sends the password in the URL, and the saved run kept a prefix | High | Update Contact Info, saved network log | Every profile-keeps-password run checked |

### S-01 Admin Page loads with no customer signed in

- **Steps:** from the public home page, with the customer login username empty, open Admin Page from the header. Do not press Initialize, Clean, or the JMS control.
- **Expected:** administration of the database and the message service would require a signed-in staff user. A customer who is not signed in would not see those controls.
- **Actual:** the page loads. It shows Administration, Database, INITIALIZE, CLEAN, and JMS Service with status Running. The customer login username on that page is empty.
- **Evidence:** `run_20261014-170842_e1c117`, journey `admin-page-readonly`, file `qa-user-1/admin-page-readonly/admin-page.txt`. The page text includes `Admin Page`, `Customer Login`, `Username`, `Administration`, `Database`, `INITIALIZE`, `CLEAN`, `JMS Service`, and `Status: Running`. Form fields recorded there: `username: (empty)`, `initialBalance: 515.50`, `minimumBalance: 100.00`, `loanProvider: Web Service`, `loanProcessor: Available Funds`, `loanProcessorThreshold: 20`. The buttons were not pressed.
- **Impact:** anyone who can open the lab on this Mac can reach controls that initialise or clean the database, and can see the service endpoints and loan settings. The port is bound to 127.0.0.1, so this is not reachable from another machine. It is still a missing access check on the lab. Initialize and Clean were not used, so the lab data was not wiped by this check.
- **Follow-up:** the owner then granted `access_control_checks` in writing and asked for this read to join the suite. The journey is tagged `access-control`, so the suite runs it under that activity. Its only click is the Admin Page link. The signed statement says the check must not press Initialize, Clean, or the JMS control.

### S-02 Update Profile sends the password in the URL, and the saved run kept a prefix

- **Steps:** sign up a new customer whose password contains `#`, open Update Contact Info, change the phone number, and press Update Profile.
- **Expected:** the password stays in the request body, or the query value is encoded. A saved HAR, trace, or report does not contain the password or a prefix of it.
- **Actual:** the update page builds the customers update URL with the password in the query string and does not encode it. A `#` ends the query value in the browser, so the request carries only the characters before the `#`. The lab answers 200. The functional effect is the lock-out in P-01 of the sample report. On the security side, the saved `network.har` for each of these runs still contained that password parameter in the clear.
- **Evidence:** journey `profile-keeps-password` (qa-user-5), step 25, page text in `failed-step-25.txt`: `Error!` and `The username and password could not be verified.` Runs: `run_20261014-165938_fd3ea3`, `run_20261014-170017_580e8d`, `run_20261014-170115_d27842`, and chaos run `run_20261014-170308_52cc01`. In each, the update URL's password parameter is 16 characters, letters and digits only, and the query string does not contain `#`. The completed update requests are HTTP 200. The chaos run also saved a second update URL of the same shape whose response did not complete. The same 16-character parameter is in `run_20261014-163126_a9b11a`. The value is not quoted here. qa-user-5's stored login still signs in, because this journey updates a new customer and not the stored qa-user-5 password. A wrong-password journey in the chaos run also saved a password query of 27 characters that is not only letters and digits. That value is a made-up wrong password, not the stored one, and it is not quoted here.
- **What was wrong in the harness:** redaction replaced a stored secret only where the whole value was present. The 16-character prefix is not one of those spellings, so it stayed in the HAR. `contains` was false for that prefix, so a caller that redacts only when `contains` is true skipped it. Someone who received the run folder would have most of the password.
- **What changed:** after the stored spellings are removed, a query parameter named `password`, `passwd`, `pwd`, `secret`, `totp`, `totp_secret`, `api_key`, `api-key`, `access_token`, or `refresh_token` has its value masked when the decoded value is at least 8 characters. A prefix of a stored password becomes `[REDACTED:<label>]`. Any other value of that length becomes `[REDACTED:query]`. A value that is already `[REDACTED:...]` is left alone, so an existing label token stays. `contains` is true for the unmasked parameter and false after masking. `SECURITY.md` states this. Bodies of ordinary search requests are unchanged: `sanitizeNetworkLogs` still does not run the redactor, and its test still expects a search body to keep its text.
- **Test:** `test/unit/redactor.test.ts`, `masks a password query that a hash cut down to a prefix`. The password in that test is made up (`Abcdefghijklmnop#7a`). It checks the `&amp;password=` spelling, a URL that still contains the `#`, an already-redacted label token, a short value, a non-password query, and an unknown password query.
- **Impact:** the lab password is made up, so this did not expose a real customer's password. The same shape on a site with real passwords would leave a usable prefix in browser history, proxy logs, and the run folder. The saved run files on this Mac, including these HARs and the text inside run zips, then had every credential query value of at least 8 characters masked. A second pass found none left. Those files are not in git.

## Corrections for the functional report

None on the findings. P-01 already says the update request carries a 16-character password and that the customer is locked out. It does not claim the saved network log was clean. The saved-prefix fact is S-02 here. P-04's corrected wording was left as Claude wrote it. The sample report's scope line still says cross-account checks were not run, which remains true. `lab-owner` now also lists `access_control_checks`. That line in the sample report was not edited.

## What was not checked

- Cross-account access, access-denied paths, and expected 401 or 403 responses. The new activity allows them to be written as journeys. None were added.
- Pressing Initialize, Clean, or the JMS control. Those can wipe or restart the lab. Reset remains `node scripts/setup-lab.mjs --reset`.
- Any host other than this lab on 127.0.0.1.
- Captchas and second codes. None were solved.
- Whether a staff login exists that would be the right gate for the Admin Page. The page was only read.
- Restful Booker.
- A fresh suite after the redactor change. Existing run files were masked in place. A new run is the check that a future HAR is clean, and that run was not started in this pass.

## How this was produced

The Admin Page text is from the read-only journey in `run_20261014-170842_e1c117`. The password-in-URL facts are from the `network.har` files of the profile runs above: response status, and the length and character class of the password parameter. The parameter values were not copied into this report. The harness change is the credential-query mask in `packages/core/src/redactor.ts`.
