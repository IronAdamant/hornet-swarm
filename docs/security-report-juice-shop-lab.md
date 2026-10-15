# Security report: Juice Shop lab, 15 October 2026

Written from the customer journeys on the local OWASP Juice Shop lab. The site is on this Mac only. No other host was opened. Customers and card details are made up. This is a light pass over the traffic those journeys already caused. It is not a penetration test, and the shop's scoreboard and challenge pages were not opened. The functional report is `docs/sample-report-juice-shop-lab.md`.

## Scope

| | |
|---|---|
| Site | OWASP Juice Shop, http://127.0.0.1:3010 (lab copy). Docker publishes that port on 127.0.0.1 only. |
| Authorisation | `lab-owner` (owner basis): sign-in checks, functional journeys, chaos, and access-control checks. These runs did not add an access-control journey. The scoreboard and the challenge pages are out of scope. |
| Accounts | The five made-up customers. Checkout used qa-user-1. The review used qa-user-4. |
| Runs used | Checkout `run_20261015-212441_ef0fd9` for the saved network log (102 entries). Review `run_20261015-212403_438a6a` for the review list. The chaos checkout `run_20261015-214608_295e9d` for the payment page text. |
| Not in this pass | Any request that was not already part of a customer journey. The feedback form. The scoreboard. |

## Summary

One credential finding. Saving a card sends the full card number as a bare JSON number, and the shop's 201 response sends it back. The page shows stars and the last four. The saved network log of the checkout kept the full number. The harness now masks that field, and a page-text line that reads `Card Number:` followed by 12 to 19 digits.

The other notes are hardening. Ordinary pages are sent the shop's configuration, including challenge settings, and they lack a content security policy and a referrer policy. A signed-in customer can read the email address of someone who reviewed a product. Login bodies and Authorization headers in the same log were already masked. No session token shaped like a JWT was left in that log.

## How severity is judged

- **High:** a control that can wipe or reconfigure the lab is reachable with no customer signed in, or a password or a live session token is written into a URL or a saved run.
- **Medium:** a credential or a control is exposed more narrowly, and using it still takes another step.
- **Low:** hardening that does not expose a credential or a destructive control.

## Findings, worst first

| ID | Finding | Severity | Where | How often |
|---|---|---|---|---|
| S-01 | Saving a card returns the full number, and the saved run kept it | Medium | `POST /api/Cards/`, payment page text | The checkout HAR. The chaos payment page text listed it again. |
| S-02 | Ordinary responses omit the usual browser policies | Low | Pages and API responses in the checkout HAR | Throughout that log |
| S-03 | Ordinary pages are sent the shop's challenge configuration | Low | `GET /rest/admin/application-configuration` | Nine times in the checkout HAR, the first of them before login |
| S-04 | A product review shows the author's email | Low | Apple Juice reviews | The review journey |

### S-01 Saving a card returns the full number, and the saved run kept it

- **Steps:** during checkout, open "Add new card", enter a made-up name and a made-up 16-digit number, choose month 12 and year 2080, and press the card form's Submit.
- **Expected:** the shop stores the number and shows it to the customer as stars and the last four. A saved HAR, trace, or page text does not keep the full number.
- **Actual:** the page does mask it. The payment rows read `************1111`, and the order summary says "Card ending in 1111" and "Your card ending with 1111 has been saved for your convenience." The request is `POST /api/Cards/` and the status is 201. Both the request and the response carry `cardNum` as a 16-digit JSON number, not a string of stars. A later `GET /api/Cards/` in the same log returns the starred form. The number is not printed here.
- **Evidence:** `run_20261015-212441_ef0fd9`, `qa-user-1/checkout/network.har`. The POST body is 83 characters and the 201 body is 204. Both match a `cardNum` of 16 digits. The page text is `order-summary.txt` in the same folder. The chaos failure `run_20261015-214608_295e9d`, `qa-user-1/checkout/failed-step-50.txt`, also listed the full number on the `Card Number:` form-field line, while the visible rows stayed starred. That file is the runner's copy of the field values. Password fields are not copied. Card fields were.
- **What was wrong in the harness:** redaction masked a quoted password-like JSON field. `cardNum` is a bare number, so it did not match, and `contains` was false. The form-field line is not JSON, so it did not match either.
- **What changed:** a JSON field named `cardNum`, `cardNumber`, or `card_number` is masked when the value is 12 to 19 digits, quoted or bare, including the escaped spelling. A bare number is saved as a quoted `[REDACTED:field]`, so the object still parses. A token saved earlier without those quotes is quoted the next time the run is packed. A line `Card Number:` followed by that many digits becomes `[REDACTED:field]`. The same length is masked in a Playwright trace: the fill call's `value`, the `fill("...")` log line, and a snapshot field `__playwright_value_`. `contains` is true before that mask and false after it. The older unquoted `cardNum` token is not a secret any more, because the digits are already gone, and packing quotes it. A year such as 2080, a price such as 1.99, "Card ending in 1111", and a starred number are left as they are. `SECURITY.md` states this. The test is `masks a card number in a checkout body, including a bare number` in `test/unit/redactor.test.ts`. The number in that test is a different made-up value from the lab card.
- **Impact:** the card is made up, and the lab is only on this Mac. The same shape on a shop with real cards would leave the number in the API response and in the run folder. The customer who is signed in can already see their own last four. Reading the full number back still takes the saved response, which is why this is Medium rather than a password left in a URL.

### S-02 Ordinary responses omit the usual browser policies

- **Actual:** HTML and API responses in the checkout HAR send `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, and `Access-Control-Allow-Origin: *`. They do not send `Content-Security-Policy`, `Referrer-Policy`, or `Strict-Transport-Security`. The lab is plain HTTP on 127.0.0.1, so HSTS would not apply the way it does on a public HTTPS site. One socket.io response allowed `http://localhost:4200` instead of `*`.
- **Evidence:** `run_20261015-212441_ef0fd9`, response headers on `GET /` and on the API calls in `network.har`.
- **Impact:** hardening only. Nothing in this pass showed a page loading another site's script because of the missing policy.

### S-03 Ordinary pages are sent the shop's challenge configuration

- **Actual:** `GET /rest/admin/application-configuration` returns 200. The checkout log contains it nine times. The first is before `POST /rest/user/login`. The JSON includes challenge settings (whether hints and solved notices are shown, and a challenge value of 301 characters), an OAuth client id of 73 characters, and the shop's security.txt fields. The same checkout also requested `GET /api/Challenges/?name=Score%20Board` twice. Each response was 200 and 476 characters. Those values are not quoted here. The scoreboard was not opened, and the challenge pages were not opened.
- **Evidence:** the same HAR. The configuration object's keys were listed without copying the values.
- **Impact:** any browser that loads the shop, including one that has not signed in, receives that configuration. This is how the practice application is built. It is recorded so the owner can see it in the customer traffic. It is not a recipe.

### S-04 A product review shows the author's email

- **Steps:** sign in, open Apple Juice, and expand Reviews.
- **Expected:** a review shows a display name, or the customer's own reviews only.
- **Actual:** the list shows `admin@juice-sh.op` ("One of my favorites!") and `basil@juice-sh.op` ("Great! We'll have an apple party. ..."). The lab customer's own address was masked in the saved text.
- **Evidence:** `run_20261015-212403_438a6a`, `review-shown.txt`. Those two addresses are the shop's seeded reviewers. They were not used to sign in.
- **Impact:** a signed-in customer learns the email address of a reviewer. On this lab those addresses belong to the practice data.

## What was already masked

In `run_20261015-212441_ef0fd9`:

- `POST /rest/user/login` request and response are redacted.
- All 40 `Authorization` headers are `[REDACTED:header]`.
- No JWT-shaped token remains in the HAR.
- `GET /rest/user/whoami` does not contain a password field. The email on the longer responses is redacted.
- The basket heading's email is redacted in the accessibility JSON. That heading is the customer's own address, so it is not a finding. The contrast of that line is A-01 in the accessibility report.

## What was not checked

- The scoreboard, the challenge pages, and any request made in order to solve a challenge. The shop's own checkout asked for challenge metadata (S-03). That response was not followed.
- The customer feedback form. Inspect `run_20261015-210451_59c4bf` shows "Customer Feedback" and "Field for the result of the CAPTCHA code". It was not submitted.
- Cross-account access. No access-control journey was added for this lab.
- Deluxe membership, the wallet, coupons, and the off-site card link.
- A fresh checkout after the redactor change. The unit test covers the mask. On this Mac the HAR files, the chaos page text, the Playwright traces, and each `evidence.zip` for the six checkout runs were packed again after the change. A later read does not show the number. The trace had kept it in the fill action, the fill log, and the input snapshot. Those shapes are masked now. The files are not in git.

## How this was produced

The header names, status codes, and field lengths are from `network.har` for `run_20261015-212441_ef0fd9`. The card number was counted and not copied. The review emails are the seeded ones printed on `review-shown.txt`. The harness change is the card-number mask in `packages/core/src/redactor.ts`. The six evidence zips were packed again with `export-evidence` after that mask covered the trace.
