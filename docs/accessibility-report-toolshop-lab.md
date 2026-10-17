# Accessibility report: Toolshop lab, 15 October 2026

> **Checked at WCAG 2.1 AA, before the WCAG 2.2 AA upgrade.** These runs used the old default standard, so this report does not cover the 2.2 criteria (2.4.11, 2.5.7, 2.5.8, 3.2.6, 3.3.7, 3.3.8). Its results are left as recorded. To check the same pages against WCAG 2.2 AA, run `pnpm hornet-swarm suite --project toolshop-lab --journey accessibility-visitor accessibility-customer` on the Mac with the lab up.

A practice deliverable, written the way a client report would be. Nine pages of the local Toolshop lab (Practice Software Testing, sprint 5 with deliberate bugs) were checked against WCAG 2.1 AA, the standard Australian clients usually name. The site runs on the tester's own Mac. No live service was touched. All accounts are made up. Severity follows `docs/severity.md`.

## Scope

| | |
|---|---|
| Site | Toolshop, http://127.0.0.1:4300 (lab copy, this Mac only) |
| Authorisation | `lab-owner` (owner basis), functional journeys |
| Standard | WCAG 2.1 AA, checked with axe-core 4.10.2 inside each runner |
| Pages | As a visitor: catalogue, product, sign-in, sign-up, contact. Signed in as a customer: my account, profile, cart, checkout |
| Runs | `run_20261015-181043_1b03ae` and `run_20261015-181429_96207d`, journeys `accessibility-visitor` (qa-user-2) and `accessibility-customer` (qa-user-1). Both runs found the same problems on every page. |

## Summary

Every page has at least two problems, and four faults repeat across the site: images with no description, controls with no name, faint text, and a broken logo. None stops a customer outright, because the words a screen reader needs are usually somewhere nearby, such as a product's name beside its picture. But on the product page and in the cart, a customer using a screen reader cannot tell what the quantity controls do. Most of these fixes are a missing attribute.

axe-core rates most of the problems "critical". That is its starting grade for the kind of problem. The grades below follow the shared scale instead: what a customer can still do once they meet it.

## Findings, worst first

| ID | Finding | Severity | Where | axe rules |
|---|---|---|---|---|
| A-01 | The quantity controls have no name | Medium | Product page, cart | `button-name`, `label` |
| A-02 | The search box and the sort control have no name | Medium | Catalogue | `label`, `select-name` |
| A-03 | Images have no description, and the logo is a broken image | Medium | Every page | `image-alt` |
| A-04 | Some text is too faint to read, including "Out of stock" | Medium | Every page | `color-contrast` |
| A-05 | The show-password button has no name | Low | Sign-in, sign-up | `button-name` |
| A-06 | Two filter lists are built in a way screen readers misread | Low | Catalogue | `list` |

### A-01 The quantity controls have no name

- **What a customer meets:** on the product page, the minus and plus buttons around the quantity contain only an icon, so a screen reader announces "button" twice and nothing more. The quantity field beside them has no label. In the cart, each line's quantity field has no label either.
- **Evidence:** `accessibility-product-page.json`: `#btn-decrease-quantity` and `#btn-increase-quantity` (`button-name`), and the field `[data-test="quantity"]` (`label`). `accessibility-cart.json`: `[data-test="product-quantity"]` (`label`).
- **Impact:** a blind customer can still add one of something, but can't knowingly change how many. Ordering the wrong quantity is a real risk.
- **Fix:** an `aria-label` on each button ("Decrease quantity", "Increase quantity") and a label on each quantity field.

### A-02 The search box and the sort control have no name

- **What a customer meets:** the search box has no label and no placeholder, and the sort dropdown has no name, so a screen reader announces "edit text" and "combo box" with nothing to say what they are for.
- **Evidence:** `accessibility-catalogue.json`: `[data-test="search-query"]` (`label`) and `[data-test="sort"]` (`select-name`).
- **Impact:** searching is the quickest way to a product, and a screen-reader customer has to guess which field does it.
- **Fix:** a label on each, which can be visually hidden.

### A-03 Images have no description, and the logo is a broken image

- **What a customer meets:** no image on the site has alternative text: the logo, the banner, and every product picture (11 on the catalogue page alone). The logo's source is `broken.png`, so sighted customers see a broken image too (F-07 in `docs/sample-report-toolshop-lab.md`).
- **Evidence:** `image-alt` on every checked page. For example, `.navbar-brand > img[src$="broken.png"]` and `a[href$="#/product/2"] .card-img-top`.
- **Impact:** each product's name is written beside its picture, so customers aren't left guessing about the products. The logo link is still announced by its title, "Practice Software Testing - Toolshop", but sighted customers see a broken image where the logo should be.
- **Fix:** `alt` text naming each product, `alt=""` on the decorative banner, and a working logo with `alt="Toolshop home"`.

### A-04 Some text is too faint to read, including "Out of stock"

- **What a customer meets:** red "Out of stock" labels on the catalogue, the category badge on the product page, the step names along the top of checkout, and the footer links all fall below the contrast WCAG asks for.
- **Evidence:** `color-contrast` on every page. For example, `[data-test="out-of-stock"]` on the catalogue and `.current > a > .label` at checkout.
- **Impact:** a customer with low vision can miss that a product is out of stock, or lose track of where they are in checkout.
- **Fix:** darker colours. The contrast ratios needed are in each page's accessibility file.

### A-05 The show-password button has no name

- **Evidence:** `accessibility-sign-in.json` and `accessibility-sign-up.json`: a button holding only an eye icon (`button-name`).
- **Impact:** small. The password field still works. A screen-reader customer just doesn't learn that the button can reveal what they typed.

### A-06 Two filter lists are built in a way screen readers misread

- **Evidence:** `accessibility-catalogue.json`: two filter lists (`.checkbox:nth-child(13) > ul`, `.checkbox:nth-child(14) > ul`) contain something other than list items (`list`).
- **Impact:** a screen reader may count the items wrongly. The checkboxes themselves are labelled.

## What a person should still check

axe-core flagged 1 or 2 checks per page that it cannot decide alone, usually contrast over an image or a gradient. Automated checks catch only some WCAG problems. A full audit adds:

- keyboard-only use of checkout
- a screen-reader pass of sign-up and checkout
- a look at focus order and error messages

## Comparison with the functional report

The broken logo (F-07) and the swapped Country and State labels on sign-up (F-07) were already known from the functional runs. axe-core didn't flag the swapped labels, because each field does have a label; it's just the wrong one. That needs a person or a journey assertion, not an automated rule.

## How this was produced

The two journeys `accessibility-visitor` and `accessibility-customer` in `examples/projects/toolshop-lab/journeys/` add an `accessibility` step on each page. `pnpm hornet-swarm suite --project toolshop-lab --journey accessibility-visitor --journey accessibility-customer` runs them. Each page's full findings, with the markup of up to 20 elements per problem, are in `accessibility-<page>.json` in the run folder.
