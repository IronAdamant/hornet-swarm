![Harbour Lane Digital](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTAiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCAyNTAgNDgiIHJvbGU9ImltZyIgYXJpYS1sYWJlbD0iSGFyYm91ciBMYW5lIERpZ2l0YWwiPjxyZWN0IHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgcng9IjgiIGZpbGw9IiMwYjRmNmMiLz48cGF0aCBkPSJNMTAgMzJjNi02IDEwLTYgMTQgMHM4IDYgMTQgMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjMiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjx0ZXh0IHg9IjU4IiB5PSIzMCIgZm9udC1mYW1pbHk9IkhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMwYjRmNmMiPkhhcmJvdXIgTGFuZSBEaWdpdGFsPC90ZXh0Pjwvc3ZnPgo=)

# Re-test comparison: Toolshop (sprint 5 with deliberate bugs)

Prepared by Harbour Lane Digital for Practice Software Testing (Testsmith) · 17 October 2026 compared with 17 October 2026 · Runs run_20261017-184848_8601fe and run_20261017-185139_0923c8

## Summary

**1 new, 0 fixed, and 7 still open, against WCAG 2.2 AA in tested pages. 1 journey that worked last time no longer works.**

## Journeys that stopped working

- **Checkout:** worked last time, did not work this time. Did not work for the test account: at step 26 of 26, the page should have said "Thanks for your order!" but did not, after the site's server answered 500 (an error on its side) to POST /invoices.

## Journeys that work again

None.

## New issues

- J-02 · High · Checkout did not work (`journey:checkout`)

## Fixed since last time

None.

## Still open

- J-01 · High · Add to cart did not work: 1 place last time, 1 now (`journey:cart`)
- A-01 · Medium · Text is too faint to read easily: 27 places last time, 27 now (`a11y:color-contrast`)
- A-02 · Medium · Images have no description: 23 places last time, 23 now (`a11y:image-alt`)
- A-03 · Medium · Buttons have no name: 4 places last time, 4 now (`a11y:button-name`)
- A-04 · Medium · Form fields have no label: 3 places last time, 3 now (`a11y:label`)
- A-05 · Medium · Lists are built incorrectly: 2 places last time, 2 now (`a11y:list`)
- A-06 · Medium · Dropdowns have no label: 1 place last time, 1 now (`a11y:select-name`)

## Scope and limits

- This comparison lists issues found against WCAG 2.2 AA in tested pages, in both runs. It covers only the pages and journeys in those runs.
- "Fixed" means the automated checks no longer find the issue on pages that were checked again. Criteria that need a person still need one.
- This is not a security test. Nothing was done to look for vulnerabilities, and the results say nothing about how secure the site is.
- Testing was done under the site's published permission for test practice (https://with-bugs.practicesoftwaretesting.com/), record toolshop-live-practice.
- The full report for this run is `client-report.md` in `run_20261017-185139_0923c8`.
