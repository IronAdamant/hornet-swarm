# Security report: hosted Toolshop, 14 October 2026

Written from saved runs of the hosted Practice Software Testing app (sprint 5 with deliberate bugs). No request in this pass was sent to look for a security fault. Customers and details are made up. This is the security write-up. The functional report is `docs/live-report-toolshop.md`, and it was not changed.

## Scope

| | |
|---|---|
| Site | https://with-bugs.practicesoftwaretesting.com, API at https://api-with-bugs.practicesoftwaretesting.com. A public site run by Testsmith and shared with other testers. |
| Authorisation | `toolshop-live-practice` (public practice). The footer says: "This is a DEMO application, used for software testing training purpose." Activities are `signin_smoke` and `functional_e2e` only. The file was not widened. |
| Accounts | qa-user-1, qa-user-2, and qa-user-3. Made-up customers of our own. No admin account. |
| Runs read | Claude's four: `run_20261014-210517_026cbb`, `run_20261014-210554_a64497`, `run_20261014-211103_baaa2c`, `run_20261014-211436_0139bb`. Later functional runs by three tester sub-agents are listed under corrections. |
| Not in this pass | Chaos, load, access-control checks, admin, sign-up, contact, and any probe of the servers. ParaBank and Restful Booker were not part of this pass. |

## Approach

This is the model for a client's live site as well as for this one.

Before a signed contract lists security work, the only site activity is what the written permission already allows. Here that is sign-in and the functional journeys. The harness may also be checked and fixed on our own saved runs: cookies, tokens, session values, stored passwords, and challenge values must not sit in the run folder. A fact that is already in those saved pages or network logs may be reported. It is not a reason to send a new request. Do not add activities, do not use an admin account, do not load the site, do not solve a captcha or a challenge, and do not probe the servers. If a check would need a wider permission, stop and ask the owner.

After a signed contract lists security work, the named activities are in bounds. `access_control_checks` is in bounds only when the contract lists it. Chaos and load stay out unless the contract lists them too. Accounts stay the ones created for the work. Real customer passwords, real card numbers, and published shared accounts stay out. Captchas and second codes are still not solved. Anything the contract does not name is still a question for the owner.

`public_practice` is the before case. The harness already refuses chaos and access-control checks on that basis, and that refusal is right for a site we do not own.

## Summary

Three gaps in what the saved runs kept. None of them is a stored login: cookie and session headers were already masked, login bodies in the HAR were already dropped, and the stored usernames and passwords were already replaced. Left in the folder were a bearer token in a trace resource, a 64-character password field on the signed-in profile response, and a Cloudflare challenge token in a URL path.

The harness now masks all three. The saved run folders on this Mac, including the later tester runs, were rewritten. A second scan of each folder found nothing left. Those folders are not in git.

The one site fact, read from traffic the functional journeys had already saved: `GET /users/me` includes a `password` field. It was not followed up.

## How severity is judged

Security reports use this scale. Functional reports use `docs/severity.md`.

- **High:** a control that can wipe or reconfigure a system is reachable with no customer signed in, or a password or a live session token is written into a URL or a saved run.
- **Medium:** a credential or a control is exposed more narrowly, and using it still takes another step.
- **Low:** hardening that does not expose a customer credential or a destructive control.

## Findings, worst first

| ID | Finding | Severity | Where | How often |
|---|---|---|---|---|
| H-01 | The trace keeps a bearer token after the login body is dropped from the HAR | High | `access_token` in a trace resource | Every sign-in in the four runs |
| H-02 | The profile response includes a password field, and the saved run kept it | Medium | `GET /users/me` | 38 responses in the four runs' HAR files |
| H-03 | A Cloudflare challenge URL keeps a token segment | Low | `/cdn-cgi/challenge-platform/` oneshot path | Every run |

### H-01 The trace keeps a bearer token after the login body is dropped from the HAR

- **Steps:** sign in. The project's auth endpoints are `**/users/login` and `**/users/register`, so the login body is dropped from the HAR and from the trace network snapshot.
- **Expected:** the bearer token is not left in any other file in the run.
- **Actual:** the login snapshot's body is `[REDACTED:auth_endpoint]` and has no `_sha1`. A separate `resources/<sha1>.json` in the same trace zip still holds `access_token`, `token_type`, and `expires_in`. No other file in the zip names that sha1, so deleting auth-endpoint resources by `_sha1` never removed it. The token is a JWT of 375 characters. Its header has `typ` and `alg`. Its payload has `iss`, `iat`, `exp`, `nbf`, `jti`, `sub`, `prv`, and `role`. The values are not quoted. The login request resource in the same zip already had the email and password replaced with the stored-login labels.
- **Evidence:** 26 copies of that JWT across the four runs (3 in `run_20261014-210517_026cbb`, 5 in `run_20261014-210554_a64497`, 9 in `run_20261014-211103_baaa2c`, 9 in `run_20261014-211436_0139bb`), counting copies inside evidence zips. One example path, before it was masked: `run_20261014-210517_026cbb/qa-user-1/phase1/trace.zip`, entry `resources/ac86076d694ee9721d3e7ad528806321a5125051.json`. The HAR files themselves did not contain a JWT. Session headers in those files were already `[REDACTED:header]` (200 of them) and the cookie arrays were already empty (3,732 of them).
- **Impact:** someone with the run folder could call the API as that made-up customer until the token expired. The accounts are made up. The same shape on a client site would be a live session in the evidence pack.
- **What changed:** after stored spellings and credential query values are removed, a JWT-shaped token becomes `[REDACTED:jwt]`. A JSON `access_token` (and the other credential field names below) is masked the same way. `redactTree` now applies that to a zip stored inside another zip, and `scanTree` reads those nested zips. `SECURITY.md` states this.
- **Test:** `test/unit/redactor.test.ts`, `masks a session token, a password hash, and a challenge value that are not stored logins`. `test/unit/review-gaps.test.ts`, `masks a session token inside a trace that is itself inside an evidence zip`. The token in the tests is made up.

### H-02 The profile response includes a password field, and the saved run kept it

- **Steps:** sign in and open a page that calls `GET /users/me`. This already happens in the functional journeys. No extra request was sent.
- **Expected:** a profile response does not include a password, and a saved HAR does not keep one.
- **Actual:** the response is HTTP 200 and the JSON includes `password` as 64 hexadecimal characters, next to `id`, `first_name`, `last_name`, `address`, `city`, `state`, `country`, `postcode`, `phone`, `dob`, `email`, `role`, `enabled`, and `failed_login_attempts`. That value is not the stored password. A scan that only looked for stored logins, which is what the functional report describes, did not see it. The email in the same body was already `[REDACTED:<label>.username]`.
- **Evidence:** 38 such responses in the HAR files of the four runs, all `GET /users/me`. The same field is in the trace resource for that response. Inside the HAR the field is also stored with escaped quotes, so a search for a raw `"password"` misses some copies.
- **Impact:** the value is the signed-in customer's own profile field, not another customer's, and it is not the plaintext password. Using it still takes another step. It was not checked whether the value can be reversed, and another customer's `/users/me` was not requested. On a client site this would be reported and then left until the contract lists that follow-up.
- **What was wrong in the harness:** redaction removed a stored secret, and it removed a password in a query string. It did not remove a JSON `password` whose value was not one of those spellings.
- **What changed:** a JSON field named `password`, `passwd`, `pwd`, `secret`, `totp`, `totp_secret`, `api_key`, `access_token`, `refresh_token`, or `id_token` is masked when the value is at least 8 characters. A hash becomes `[REDACTED:field]`. A value that is already `[REDACTED:...]` is left as it is. A short value is left. The same test as H-01 covers the hash, including the escaped spelling inside a HAR string. The profile's other fields are not masked by this rule.
- **Follow-up:** none on this site unless the owner widens the permission.

### H-03 A Cloudflare challenge URL keeps a token segment

- **Steps:** open any page. Cloudflare's challenge script runs. The functional report already records that the harness did not treat it as a captcha.
- **Expected:** a challenge token is not left in the saved URL.
- **Actual:** cookie headers were already masked, and the four runs contain no `cf_clearance`, `__cf_bm`, or `_cfuvid` name. The oneshot URL under `/cdn-cgi/challenge-platform/` still had a path segment that contains a colon. The script URL ending in `main.js` does not, and it is not a per-run token.
- **Evidence:** 90 copies of that oneshot path across the four runs, including copies inside zips. The token is not quoted.
- **Impact:** the value is a bot-check token, not a customer password. The clearance cookie was already gone. Keeping the path segment is still more than the run folder needs.
- **What changed:** a path segment of `/cdn-cgi/challenge-platform/` that contains a colon becomes `[REDACTED:challenge]`. The `main.js` script path is unchanged. Values of `cf_clearance`, `__cf_bm`, `_cfuvid`, and `cf_chl_*`, when they appear outside a header, are masked the same way. A short value is left. The H-01 test covers a made-up oneshot token and a made-up `cf_clearance`.

## Corrections for the functional report

The secrets paragraph is right about stored logins. A scan for those spellings, in the 190 files and 2,876 zip entries of the four runs (3,066 altogether), found none. It does not cover H-01, H-02, or H-03. Those were in the same folders.

The planted-fault list left out words that are already in `run_20261014-211436_0139bb`: `Contakt` and `User Data not found` on the signed-in pages, `Sorth` in `qa-user-2/search/failed-step-8.txt`, and `City: City not found` in `qa-user-2/profile/failed-step-9.txt` and `qa-user-3/profile/failed-step-9.txt`.

A later checkout, outside those four runs, succeeded. `run_20261014-214836_1a79e8`, file `qa-user-1/checkout/order-confirmed.txt`, says `Thanks for your order! Your invoice number is INV-2026000006.` L-01 stays intermittent. That run placed the one order this later pass was allowed.

## What was not checked

- Access control, another customer's data, and the admin account. The permission does not allow them.
- Whether the 64-character field is reversible, and whether the bearer token still works. Both would mean using the saved credential. They were masked instead.
- Chaos and load. Public practice refuses both.
- Sign-up and the contact form.
- Captchas and second codes. None were solved. The invisible challenge script is H-03, not a captcha the harness tried to pass.
- Any host other than the two origins named in the authorisation.
- A fresh suite after the redactor change. The runs above were masked in place. A new run is the check that a future trace is clean, and that run was not started after the fix.

## How this was produced

The four run folders were read on disk. Stored logins were loaded only as search needles and were not printed. Cookie headers, cookie arrays, auth-endpoint bodies, JWT strings, JSON credential fields, and challenge URL paths were counted. The harness change is in `packages/core/src/redactor.ts` and in the zip walk in `packages/report/src/artifacts.ts`.

The same scan was then run again with the new rules, the folders were rewritten, and the scan was repeated. Hits before the rewrite, then none after:

| Run | Hits before | Hits after |
|---|---|---|
| `run_20261014-210517_026cbb` | 25 | 0 |
| `run_20261014-210554_a64497` | 49 | 0 |
| `run_20261014-211103_baaa2c` | 77 | 0 |
| `run_20261014-211436_0139bb` | 77 | 0 |
| `run_20261014-214717_d49ec7` | 9 | 0 |
| `run_20261014-214719_5c3f6c` | 9 | 0 |
| `run_20261014-214719_ab8c0c` | 9 | 0 |
| `run_20261014-214728_884cfe` | 17 | 0 |
| `run_20261014-214729_ae0832` | 13 | 0 |
| `run_20261014-214732_1ac5f6` | 17 | 0 |
| `run_20261014-214755_824c38` | 17 | 0 |
| `run_20261014-214804_d1a296` | 17 | 0 |
| `run_20261014-214836_1a79e8` | 17 | 0 |
| `run_20261014-214853_5c19a7` | 17 | 0 |

The later runs are the functional pass from the three tester sub-agents: sign-in for each label, then cart and one checkout (qa-user-1), search and profile (qa-user-2), favourites, cash on delivery, and profile (qa-user-3). No chaos, no new journey, no admin. They used the harness from before this fix, so they had the same gaps until the rewrite.
