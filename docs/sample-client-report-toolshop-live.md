![Harbour Lane Digital](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTAiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCAyNTAgNDgiIHJvbGU9ImltZyIgYXJpYS1sYWJlbD0iSGFyYm91ciBMYW5lIERpZ2l0YWwiPjxyZWN0IHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgcng9IjgiIGZpbGw9IiMwYjRmNmMiLz48cGF0aCBkPSJNMTAgMzJjNi02IDEwLTYgMTQgMHM4IDYgMTQgMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjMiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjx0ZXh0IHg9IjU4IiB5PSIzMCIgZm9udC1mYW1pbHk9IkhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMwYjRmNmMiPkhhcmJvdXIgTGFuZSBEaWdpdGFsPC90ZXh0Pjwvc3ZnPgo=)

# Accessibility and journey test: Toolshop (sprint 5 with deliberate bugs)

Prepared by Harbour Lane Digital for Practice Software Testing (Testsmith) · Tested 17 October 2026 · Run run_20261017-185139_0923c8

## Summary

**8 issues found against WCAG 2.2 AA in tested pages, 2 of them high severity.**

On 17 October 2026 we tested 9 pages of Toolshop (sprint 5 with deliberate bugs), at https://with-bugs.practicesoftwaretesting.com, with 2 test accounts. We checked the pages against WCAG 2.2 level AA, the current accessibility guidelines, and checked whether customers can sign up, log in, add to cart, and check out.

Log in worked. Add to cart did not work for the test account: at step 17 of 17, the page should have said "Related products" but said "Reltded products" instead. Checkout did not work for the test account: at step 26 of 26, the page should have said "Thanks for your order!" but did not, after the site's server answered 500 (an error on its side) to POST /invoices. Sign-up was not tested this round.

We found 8 issues: 2 high, 6 medium, and 0 low. Fix these first: add to cart did not work (high), checkout did not work (high) and text is too faint to read easily (medium). Each issue below says where it happens, why it matters to your customers, and how to fix it.

Automated checks find only some accessibility problems. 50 of the 55 WCAG 2.2 A and AA criteria need a person to review, such as keyboard use and whether image descriptions make sense. They are marked "Needs manual review" in the criteria table, and none of them is counted as passed.

## Journey results

| Journey | Result | What happened |
|---|---|---|
| Sign-up | Left out on purpose | Left out of this round on purpose: Toolshop live is shared with other testers. Signing up a new account every month would fill it with test accounts, so sign-up is checked on the local lab copy instead. |
| Log in | Worked | Worked for all 2 test accounts, checked by the sign-in that starts every run. |
| Add to cart | Did not work | Did not work for the test account: at step 17 of 17, the page should have said "Related products" but said "Reltded products" instead. |
| Checkout | Did not work | Did not work for the test account: at step 26 of 26, the page should have said "Thanks for your order!" but did not, after the site's server answered 500 (an error on its side) to POST /invoices. |
| Pages a visitor sees, checked against WCAG 2.2 AA | Worked | Worked for the test account. |
| Pages a signed-in customer sees, checked against WCAG 2.2 AA | Worked | Worked for the test account. |

## Issues, most important first

### J-01 · High · Add to cart did not work

- **Where:** A product goes into the cart, such as `at step 17 of 17, the page should have said "Related products" but said "Reltded products" instead`
- **Why it matters to your customers:** Customers who cannot add products to the cart cannot buy anything.
- **How to fix it:** Open the screenshot and page text saved for the failed step, listed under Evidence, and fix the cause. The next re-test confirms the fix.
- **Severity:** High. A customer cannot complete something the site exists for.
- **WCAG 2.2 criteria:** None. This is a journey that did not work, not an accessibility criterion.
- **Evidence:** `qa-user-1/cart/failed-step-16.png`, `qa-user-1/cart/failed-step-16.txt`
- **Re-test key:** `journey:cart`

### J-02 · High · Checkout did not work

- **Where:** A signed-in customer pays by bank transfer and gets an invoice, such as `at step 26 of 26, the page should have said "Thanks for your order!" but did not, after the site's server answered 500 (an error on its side) to POST /invoices`
- **Why it matters to your customers:** Customers who cannot finish checkout cannot pay, so the shop loses the sale.
- **How to fix it:** Open the screenshot and page text saved for the failed step, listed under Evidence, and fix the cause. The next re-test confirms the fix.
- **Severity:** High. A customer cannot complete something the site exists for.
- **WCAG 2.2 criteria:** None. This is a journey that did not work, not an accessibility criterion.
- **Evidence:** `qa-user-1/checkout/failed-step-25.png`, `qa-user-1/checkout/failed-step-25.txt`
- **Re-test key:** `journey:checkout`

### A-01 · Medium · Text is too faint to read easily

- **Where:**
  - catalogue (/#/), 3 places, such as `.float-start`
  - product-page (/#/product/1), 3 places, such as `.text-reset`
  - sign-in (/#/auth/login), 2 places, such as `p > a[target="_blank"]:nth-child(1)`
  - sign-up (/#/auth/register), 2 places, such as `p > a[target="_blank"]:nth-child(1)`
  - contact (/#/contact), 2 places, such as `p > a[target="_blank"]:nth-child(1)`
  - my-account (/#/account), 2 places, such as `p > a[target="_blank"]:nth-child(1)`
  - profile (/#/account/profile), 2 places, such as `p > a[target="_blank"]:nth-child(1)`
  - cart (/#/checkout), 6 places, such as `li:nth-child(2) > a > .label`
  - checkout-signed-in (/#/checkout), 5 places, such as `.current > a > .label`
- **Why it matters to your customers:** Customers with low vision, older customers, and anyone on a phone in sunlight struggle to read pale text, including prices and stock levels.
- **How to fix it:** Darken the text or lighten the background until the contrast is at least 4.5 to 1 (3 to 1 for large text). The saved results give each ratio.
- **Severity:** Medium. Starting grade from the automated check, which rates it serious.
- **WCAG 2.2 criteria:** 1.4.3 (AA)
- **Evidence:** `qa-user-2/accessibility-visitor/accessibility-catalogue.json`, `qa-user-2/accessibility-visitor/accessibility-product-page.json`, `qa-user-2/accessibility-visitor/accessibility-sign-in.json`, `qa-user-2/accessibility-visitor/accessibility-sign-up.json`, `qa-user-2/accessibility-visitor/accessibility-contact.json`, `qa-user-1/accessibility-customer/accessibility-my-account.json`, `qa-user-1/accessibility-customer/accessibility-profile.json`, `qa-user-1/accessibility-customer/accessibility-cart.json`, `qa-user-1/accessibility-customer/accessibility-checkout-signed-in.json`
- **Re-test key:** `a11y:color-contrast`

### A-02 · Medium · Images have no description

- **Where:**
  - catalogue (/#/), 11 places, such as `.navbar-brand > img[src$="broken.png"]`
  - product-page (/#/product/1), 5 places, such as `img[src$="broken.png"]`
  - sign-in (/#/auth/login), 1 place, such as `img`
  - sign-up (/#/auth/register), 1 place, such as `img`
  - contact (/#/contact), 1 place, such as `img`
  - my-account (/#/account), 1 place, such as `img`
  - profile (/#/account/profile), 1 place, such as `img`
  - cart (/#/checkout), 1 place, such as `img`
  - checkout-signed-in (/#/checkout), 1 place, such as `img`
- **Why it matters to your customers:** Customers who use a screen reader hear nothing, or a file name, where a product photo or a button image is.
- **How to fix it:** Give each meaningful image an alt text that says what it shows or does. Give decorative images an empty alt (alt="").
- **Severity:** Medium. Graded by the reviewer: Each product's name is written beside its picture, so customers are not left guessing which product it is.
- **WCAG 2.2 criteria:** 1.1.1 (A)
- **Evidence:** `qa-user-2/accessibility-visitor/accessibility-catalogue.json`, `qa-user-2/accessibility-visitor/accessibility-product-page.json`, `qa-user-2/accessibility-visitor/accessibility-sign-in.json`, `qa-user-2/accessibility-visitor/accessibility-sign-up.json`, `qa-user-2/accessibility-visitor/accessibility-contact.json`, `qa-user-1/accessibility-customer/accessibility-my-account.json`, `qa-user-1/accessibility-customer/accessibility-profile.json`, `qa-user-1/accessibility-customer/accessibility-cart.json`, `qa-user-1/accessibility-customer/accessibility-checkout-signed-in.json`
- **Re-test key:** `a11y:image-alt`

### A-03 · Medium · Buttons have no name

- **Where:**
  - product-page (/#/product/1), 2 places, such as `#btn-decrease-quantity`
  - sign-in (/#/auth/login), 1 place, such as `.btn`
  - sign-up (/#/auth/register), 1 place, such as `.btn`
- **Why it matters to your customers:** A screen reader announces only "button", so customers cannot tell which one adds to cart, removes an item, or shows a password.
- **How to fix it:** Give each button visible text, or an aria-label for icon-only buttons, such as aria-label="Increase quantity".
- **Severity:** Medium. Graded by the reviewer: A screen-reader customer can still add one of something, but cannot knowingly change the quantity.
- **WCAG 2.2 criteria:** 4.1.2 (A)
- **Evidence:** `qa-user-2/accessibility-visitor/accessibility-product-page.json`, `qa-user-2/accessibility-visitor/accessibility-sign-in.json`, `qa-user-2/accessibility-visitor/accessibility-sign-up.json`
- **Re-test key:** `a11y:button-name`

### A-04 · Medium · Form fields have no label

- **Where:**
  - catalogue (/#/), 1 place, such as `.form-control`
  - product-page (/#/product/1), 1 place, such as `input`
  - cart (/#/checkout), 1 place, such as `.quantity`
- **Why it matters to your customers:** Screen reader users hear "edit text" with no idea what to type, so forms such as checkout or sign-up become guesswork.
- **How to fix it:** Connect a visible label to each field with <label for="...">, or give the field an aria-label.
- **Severity:** Medium. Graded by the reviewer: The fields can still be used, but a screen-reader customer has to guess which one searches or sets the quantity.
- **WCAG 2.2 criteria:** 4.1.2 (A)
- **Evidence:** `qa-user-2/accessibility-visitor/accessibility-catalogue.json`, `qa-user-2/accessibility-visitor/accessibility-product-page.json`, `qa-user-1/accessibility-customer/accessibility-cart.json`
- **Re-test key:** `a11y:label`

### A-05 · Medium · Lists are built incorrectly

- **Where:** catalogue (/#/), 2 places, such as `.checkbox:nth-child(13) > ul`
- **Why it matters to your customers:** A screen reader cannot say how many items a list has, such as filter options, so customers lose their place.
- **How to fix it:** Put only <li> elements directly inside <ul> or <ol>.
- **Severity:** Medium. Starting grade from the automated check, which rates it serious.
- **WCAG 2.2 criteria:** 1.3.1 (A)
- **Evidence:** `qa-user-2/accessibility-visitor/accessibility-catalogue.json`
- **Re-test key:** `a11y:list`

### A-06 · Medium · Dropdowns have no label

- **Where:** catalogue (/#/), 1 place, such as `select`
- **Why it matters to your customers:** Customers using a screen reader cannot tell what a dropdown chooses, such as sort order or country.
- **How to fix it:** Connect a visible label to each dropdown, or give it an aria-label.
- **Severity:** Medium. Graded by the reviewer: Sorting is a convenience. Customers can still browse and search without it.
- **WCAG 2.2 criteria:** 4.1.2 (A)
- **Evidence:** `qa-user-2/accessibility-visitor/accessibility-catalogue.json`
- **Re-test key:** `a11y:select-name`

## Needs a person to review

| WCAG 2.2 criterion | What to check | Where |
|---|---|---|
| 4.1.2 | The automated check could not decide 4 places for "aria-prohibited-attr". A person should look at each one. | catalogue, product-page |
| 1.4.3 | The automated check could not decide 79 places for "Text is too faint to read easily". A person should look at each one. | catalogue, product-page, sign-in, sign-up, contact, my-account, profile, cart, checkout-signed-in |
| 4.1.2 | The automated check could not decide 1 place for "duplicate-id-aria". A person should look at each one. | sign-up |
| 2.4.1 | The automated check could not decide 2 places for "There is no way to skip the menu". A person should look at each one. | cart, checkout-signed-in |
| 2.5.7 | 2 elements look like they are moved by dragging, such as div:nth-of-type(1) > ngx-slider > span:nth-of-type(5) (a custom slider). Check each can also be used with single clicks or taps. | catalogue |
| 3.3.8 | The password field turns autocomplete off, which can stop some password managers from filling it. Check that a password manager can still sign in. | sign-in |
| 3.3.8 | The password field turns autocomplete off, which can stop some password managers from filling it. Check that a password manager can still sign in. | profile |

## What was tested

- **Site:** https://with-bugs.practicesoftwaretesting.com
- **Standard:** WCAG 2.2 level AA
- **Test accounts:** 2
- **Pages checked for accessibility:**
  - catalogue (/#/)
  - product-page (/#/product/1)
  - sign-in (/#/auth/login)
  - sign-up (/#/auth/register)
  - contact (/#/contact)
  - my-account (/#/account)
  - profile (/#/account/profile)
  - cart (/#/checkout)
  - checkout-signed-in (/#/checkout)

## WCAG 2.2 A and AA criteria

How each criterion was checked, and what was found. "Partly automated" and "Manual" criteria are never marked as clear.

| Criterion | Level | How it was checked | Result | What a person checks |
|---|---|---|---|---|
| 1.1.1 Non-text Content | A | Partly automated | Issues found (1) | Whether each image description says what the image is for. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | Manual | Needs manual review | A transcript or description for any audio-only or video-only media. |
| 1.2.2 Captions (Prerecorded) | A | Partly automated | Needs manual review | Whether captions are present, accurate, and in sync. |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | A | Manual | Needs manual review | An audio description or text alternative for video. |
| 1.2.4 Captions (Live) | AA | Manual | Needs manual review | Captions on any live video. |
| 1.2.5 Audio Description (Prerecorded) | AA | Manual | Needs manual review | An audio description track for video. |
| 1.3.1 Info and Relationships | A | Partly automated | Issues found (1) | Whether headings, lists, tables, and form groups are marked up as what they look like. |
| 1.3.2 Meaningful Sequence | A | Manual | Needs manual review | Whether the reading order makes sense with styles turned off. |
| 1.3.3 Sensory Characteristics | A | Manual | Needs manual review | Instructions that rely only on shape, colour, size, or position. |
| 1.3.4 Orientation | AA | Manual | Needs manual review | Whether the site works in both portrait and landscape. |
| 1.3.5 Identify Input Purpose | AA | Partly automated | Needs manual review | Whether fields asking for the customer's own details say what they are for, so a browser can fill them in. |
| 1.4.1 Use of Color | A | Partly automated | Needs manual review | Information shown only by colour, such as a red field with no message. |
| 1.4.2 Audio Control | A | Partly automated | Needs manual review | A way to stop sound that plays by itself. |
| 1.4.3 Contrast (Minimum) | AA | Automated | Issues found (1) | Text over images or gradients, which the automated check hands to a person. |
| 1.4.4 Resize Text | AA | Partly automated | Needs manual review | Whether the page still works zoomed to 200%. |
| 1.4.5 Images of Text | AA | Manual | Needs manual review | Text shown as a picture instead of real text. |
| 1.4.10 Reflow | AA | Manual | Needs manual review | Whether the page works at 320 pixels wide without scrolling sideways. |
| 1.4.11 Non-text Contrast | AA | Manual | Needs manual review | The contrast of field borders, icons, and focus outlines. |
| 1.4.12 Text Spacing | AA | Partly automated | Needs manual review | Whether text still fits when a reader widens the spacing. |
| 1.4.13 Content on Hover or Focus | AA | Manual | Needs manual review | Tooltips and pop-ups that can be dismissed and stay while read. |
| 2.1.1 Keyboard | A | Partly automated | Needs manual review | Whether every control works with the keyboard alone. |
| 2.1.2 No Keyboard Trap | A | Manual | Needs manual review | Whether keyboard focus can always leave a widget. |
| 2.1.4 Character Key Shortcuts | A | Manual | Needs manual review | Single-key shortcuts that can be turned off or changed. |
| 2.2.1 Timing Adjustable | A | Partly automated | Needs manual review | Time limits, such as a checkout session, that can be extended. |
| 2.2.2 Pause, Stop, Hide | A | Partly automated | Needs manual review | Moving content, such as a carousel, that can be paused. |
| 2.3.1 Three Flashes or Below Threshold | A | Manual | Needs manual review | Content that flashes more than three times a second. |
| 2.4.1 Bypass Blocks | A | Partly automated | Needs manual review | A working skip link or landmarks to jump past the menu. |
| 2.4.2 Page Titled | A | Partly automated | Needs manual review | Whether each page title says what the page is. |
| 2.4.3 Focus Order | A | Manual | Needs manual review | Whether keyboard focus moves in an order that makes sense. |
| 2.4.4 Link Purpose (In Context) | A | Partly automated | Needs manual review | Whether each link says where it goes, such as no lone "click here". |
| 2.4.5 Multiple Ways | AA | Manual | Needs manual review | More than one way to find a page, such as a menu and a search. |
| 2.4.6 Headings and Labels | AA | Manual | Needs manual review | Whether headings and labels describe what follows them. |
| 2.4.7 Focus Visible | AA | Manual | Needs manual review | A visible outline on whatever has keyboard focus. |
| 2.4.11 Focus Not Obscured (Minimum) (new in 2.2) | AA | Partly automated | Needs manual review | Focus hidden by a banner or chat window that only appears after interaction. |
| 2.5.1 Pointer Gestures | A | Manual | Needs manual review | Pinch, swipe, or multi-finger gestures with a single-tap alternative. |
| 2.5.2 Pointer Cancellation | A | Manual | Needs manual review | Actions that happen on release, so a slip can be cancelled. |
| 2.5.3 Label in Name | A | Manual | Needs manual review | Whether a control's spoken name includes the words shown on it. |
| 2.5.4 Motion Actuation | A | Manual | Needs manual review | Shake or tilt actions with an on-screen alternative. |
| 2.5.7 Dragging Movements (new in 2.2) | AA | Partly automated | Needs manual review | Whether everything done by dragging, such as a slider or a sortable list, can also be done with single clicks or taps. |
| 2.5.8 Target Size (Minimum) (new in 2.2) | AA | Automated | No issues found by automated checks on the tested pages | Small targets the automated check could not measure, and targets the reviewer judges essential or duplicated elsewhere. |
| 3.1.1 Language of Page | A | Partly automated | Needs manual review | Whether the declared language is the one the page is written in. |
| 3.1.2 Language of Parts | AA | Partly automated | Needs manual review | Passages in another language marked as such. |
| 3.2.1 On Focus | A | Manual | Needs manual review | Whether focusing a control changes the page by surprise. |
| 3.2.2 On Input | A | Manual | Needs manual review | Whether changing a field changes the page by surprise. |
| 3.2.3 Consistent Navigation | AA | Manual | Needs manual review | Menus in the same order on every page. |
| 3.2.4 Consistent Identification | AA | Manual | Needs manual review | The same thing named the same way on every page. |
| 3.2.6 Consistent Help (new in 2.2) | A | Partly automated | Needs manual review | Help such as a phone number, contact page, or chat in the same place on every page that has it. |
| 3.3.1 Error Identification | A | Manual | Needs manual review | Whether a form says which field is wrong, in words. |
| 3.3.2 Labels or Instructions | A | Partly automated | Needs manual review | Whether fields explain the format they expect. |
| 3.3.3 Error Suggestion | AA | Manual | Needs manual review | Whether an error message says how to fix it. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | Manual | Needs manual review | A chance to review, correct, or cancel an order before it is placed. |
| 3.3.7 Redundant Entry (new in 2.2) | A | Partly automated | Needs manual review | Details asked for twice in one process, such as a delivery address typed again for billing with no "same as" option. |
| 3.3.8 Accessible Authentication (Minimum) (new in 2.2) | AA | Partly automated | Needs manual review | Puzzles or memory tests at sign-in, and whether a password manager or pasting can fill the password. |
| 4.1.2 Name, Role, Value | A | Partly automated | Issues found (3) | Custom controls, such as dropdowns built from divs, that a screen reader cannot use. |
| 4.1.3 Status Messages | AA | Manual | Needs manual review | Messages such as "Added to cart" announced without moving focus. |

4.1.1 Parsing is not part of WCAG 2.2 and is not checked.

## Scope and limits

- This report lists issues found against WCAG 2.2 AA in tested pages. It covers only the pages and journeys named in it, as they were on 17 October 2026. Pages that are not listed were not tested, and later changes to the site are not covered.
- It is not a statement that the site has no other accessibility issues, and it is not legal advice.
- Automated checks plus a 1-2 hour manual pass cover roughly 50-55% of WCAG 2.2 AA.
- No screen-reader testing was done.
- This report is not a compliance certificate.
- This is not a security test. Nothing was done to look for vulnerabilities or to break into the site, and the results say nothing about how secure it is.
- This site publicly invites test practice ("This is a DEMO application, used for software testing training purpose.", https://with-bugs.practicesoftwaretesting.com/). It was tested under that published permission (record toolshop-live-practice), with no owner's written authorisation needed.
- Only test accounts were used. Passwords, codes, and personal details are hidden in every saved file.
- 50 criteria marked "Needs manual review" were not checked by a person in this round. No criterion is marked as passed: where the automated checks found nothing, the report says only that.
- Left out on purpose: sign-up (Toolshop live is shared with other testers. Signing up a new account every month would fill it with test accounts, so sign-up is checked on the local lab copy instead.).
- Agreed exclusions: No chaos, load, or access-control probing. No admin account. The shared catalogue and other testers' data are left alone. At most one order per run. Never type a real name, address, or card number.

## Evidence appendix

Every file is inside the run folder `run_20261017-185139_0923c8`, kept by Harbour Lane Digital. Ask for any of them.

| File | What it holds |
|---|---|
| `run.json` | Every account, journey, and step in this run, with its result. |
| `summary.md` | The run's own short summary. |
| `evidence.zip` | Screenshots, page text, network logs, and browser traces, with passwords and personal details hidden. |
| `qa-user-2/accessibility-visitor/accessibility-catalogue.json` | Full accessibility results for catalogue (/#/), with the markup of each place found. |
| `qa-user-2/accessibility-visitor/accessibility-product-page.json` | Full accessibility results for product-page (/#/product/1), with the markup of each place found. |
| `qa-user-2/accessibility-visitor/accessibility-sign-in.json` | Full accessibility results for sign-in (/#/auth/login), with the markup of each place found. |
| `qa-user-2/accessibility-visitor/accessibility-sign-up.json` | Full accessibility results for sign-up (/#/auth/register), with the markup of each place found. |
| `qa-user-2/accessibility-visitor/accessibility-contact.json` | Full accessibility results for contact (/#/contact), with the markup of each place found. |
| `qa-user-1/accessibility-customer/accessibility-my-account.json` | Full accessibility results for my-account (/#/account), with the markup of each place found. |
| `qa-user-1/accessibility-customer/accessibility-profile.json` | Full accessibility results for profile (/#/account/profile), with the markup of each place found. |
| `qa-user-1/accessibility-customer/accessibility-cart.json` | Full accessibility results for cart (/#/checkout), with the markup of each place found. |
| `qa-user-1/accessibility-customer/accessibility-checkout-signed-in.json` | Full accessibility results for checkout-signed-in (/#/checkout), with the markup of each place found. |
| `qa-user-1/cart/failed-step-16.png` | Evidence for J-01. |
| `qa-user-1/cart/failed-step-16.txt` | Evidence for J-01. |
| `qa-user-1/checkout/failed-step-25.png` | Evidence for J-02. |
| `qa-user-1/checkout/failed-step-25.txt` | Evidence for J-02. |

---

Harbour Lane Digital · https://harbourlane.example · hello@harbourlane.example
