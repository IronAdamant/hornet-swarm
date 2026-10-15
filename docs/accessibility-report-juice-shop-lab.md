# Accessibility report: Juice Shop lab, 15 October 2026

A practice deliverable, written the way a client report would be. Nine pages of the local OWASP Juice Shop lab (v20.3.0) were checked against WCAG 2.1 AA. The site runs on the tester's own Mac. No live service was touched. All accounts are made up. Severity follows `docs/severity.md`.

The customer feedback form was left out. It asks for a captcha, and that page was not submitted.

## Scope

| | |
|---|---|
| Site | OWASP Juice Shop, http://127.0.0.1:3010 (lab copy, this Mac only) |
| Authorisation | `lab-owner` (owner basis), functional journeys |
| Standard | WCAG 2.1 AA, checked with axe-core 4.10.2 inside each runner |
| Pages | As a visitor: catalogue, product details (a dialog on the search page), sign-in, sign-up. Signed in: basket, new address, delivery, payment, profile |
| Runs | `run_20261015-213828_dab90f` and `run_20261015-214216_71fe63`, journeys `accessibility-visitor` (qa-user-2) and `accessibility-customer` (qa-user-1). The same problems are in the single runs `run_20261015-212631_341e09` and `run_20261015-212704_16bdd9`. The chaos suite recorded them again. |

## Summary

Eight of the nine pages have at least one problem. Profile has none. The ones that matter to a customer are the delivery and payment radios, which have no name, the basket's quantity buttons, which axe did not see because that basket was empty, and text that is too faint to read: the cookie notice, "Only 1 left", and the email in the basket heading.

axe-core rates several of these "critical". That is its starting grade for a missing label. The grades below follow the shared scale: what a customer using a screen reader, a keyboard, or magnification can still do. `fail_on` was not set, so the journeys pass while recording the problems.

## Findings, worst first

| ID | Finding | Severity | Where | axe rules |
|---|---|---|---|---|
| A-01 | The cookie notice, "Only 1 left", and the basket email are too faint | Medium | Catalogue, product, basket | `color-contrast` |
| A-02 | Delivery and payment choices have no name | Medium | Delivery, payment | `label` |
| A-03 | The basket's minus, plus, and remove buttons have no name | Medium | Basket, once it has a product | Not flagged by axe on the empty basket. Seen on the page map. |
| A-04 | A hidden search field has no label | Low | Every Angular page checked | `label` |
| A-05 | The basket header row is missing its cells | Low | Basket | `aria-required-children` |
| A-06 | An empty button sits in the product dialog | Low | Product details | `button-name` |

### A-01 The cookie notice, "Only 1 left", and the basket email are too faint

- **What a customer meets:** the cookie bar is still on the page after "Me want it!" is clicked (J-04 in the sample report). Its message, the "But me wait!" link, and the "Me want it!" control are all far below the contrast WCAG asks for. "Only 1 left" on a product is pale text on a green shadow. In the basket heading, the signed-in email is dark text on a dark bar.
- **Evidence:** `accessibility-catalogue.json` in `run_20261015-213828_dab90f`. The cookie message is about 1.38 (`#444548` on `#1d304c`, 16px). "But me wait!" is about 1.05. "Me want it!" is about 1.86. "Only 1 left" is 2.86 (`#e3e2e6` against shadow `#4a9700`, 18px bold). An earlier catalogue check, `run_20261015-212631_341e09`, measured the same notice at 1.19, 1.03, and 1.39. `accessibility-basket.json`: the email in `<small>` is 1.64 (`#191919` on `#3e3e3e`, 25.6px bold), where 3:1 was expected. The saved text masks the address as `[REDACTED:qa-user-1.username]`.
- **Impact:** a customer with low vision can miss the notice, miss that a product is almost gone, or be unable to read which account the basket belongs to. Shopping still works.
- **Fix:** darker text on the notice and the email, and a stronger colour for "Only 1 left".

### A-02 Delivery and payment choices have no name

- **What a customer meets:** each delivery speed is a radio whose input has no label. The row beside it has the words ("Standard Delivery", "Fast Delivery", "One Day Delivery"), but the input itself does not. The same is true of each saved card on the payment page. The row shows `************1111` and the name. The radio does not.
- **Evidence:** `accessibility-delivery.json`: `label`, four places. One is the hidden search field in A-04. The other three are `#mat-radio-43-input`, `#mat-radio-44-input`, and `#mat-radio-45-input`. `accessibility-payment.json` in the same suite: the hidden field plus two card radios. The next suite, `run_20261015-214216_71fe63`, reported four payment labels, and the chaos suite reported five, because each new saved card adds another unnamed radio.
- **Impact:** a screen reader can still read the row text, so the customer is not blocked. They cannot tell from the radio alone which speed or which card it is.
- **Fix:** an accessible name on each radio, taken from the row.

### A-03 The basket's minus, plus, and remove buttons have no name

- **What a customer meets:** with products in the basket, each row has three icon buttons and no visible word on them. A page map lists them as `button` with empty text. Minus, plus, and remove are only distinguishable by position.
- **Evidence:** inspect `run_20261015-212253_d1bddf` of a basket that held both juices: six buttons whose selector is `button` and whose text is empty. The accessibility journey opens an empty basket, so axe did not flag `button-name` there. The functional basket journey uses those buttons and checks "Total Price: 5.97" (`run_20261015-212403_66bbf7`).
- **Impact:** a blind customer can still hear the product name and the total, but cannot tell which button changes the quantity and which removes the line. The wrong one changes the order.
- **Fix:** `aria-label` values such as "Increase quantity", "Decrease quantity", and "Remove".

### A-04 A hidden search field has no label

- **What a customer meets:** nothing, if they are sighted. The input has `tabindex="-1"`, an empty placeholder, and no label. It is the closed search field, not the search box a customer opens from "Open search".
- **Evidence:** `label` on the catalogue, the product dialog's page, sign-in, sign-up, address, delivery, payment, and the basket. The node is `<input type="text" placeholder="" tabindex="-1">`.
- **Impact:** it is not in the tab order. Searching still works from the search button. This is recorded because axe flags it, and it is not what stops anyone.
- **Fix:** a name on the field, or hide it from the accessibility tree while it is closed.

### A-05 The basket header row is missing its cells

- **Evidence:** `accessibility-basket.json`, `aria-required-children` on `mat-header-row`. The row's role expects a cell or a column header, and those cells are not present.
- **Impact:** the product names, quantities, and "Total Price" are still on the page. A screen reader gets a broken table, not a blank basket.

### A-06 An empty button sits in the product dialog

- **Evidence:** `accessibility-product.json`, `button-name` on a button with class `auto-focus-absorber`. It has no text.
- **Impact:** small. It takes focus when the dialog opens and says nothing. The product name and "Write a review" are elsewhere in the dialog.

## Profile

`accessibility-profile.json` for `/profile` lists no violations. One check needs a person to look. The page shows "User Profile", "Set Username", and the username field.

## What a person should still check

axe-core flagged one to three checks per page that it cannot decide alone. Automated checks catch only some WCAG problems. A full audit adds:

- keyboard-only use of the basket, including the unnamed icon buttons
- a screen-reader pass of delivery and payment, to confirm the radios are only named by the row
- the cookie notice after "Me want it!", including whether it traps the bottom of the page
- focus order in the product dialog, starting at the empty button

## Comparison with the functional report

J-04 is the cookie notice that stays, and it is also the faint text in A-01. J-05 is the continue buttons whose accessible names point at the wrong page. Those buttons do have names, so axe did not flag them. The password counter (J-03) and "You review has been saved." (J-06) are wording, not missing labels.
