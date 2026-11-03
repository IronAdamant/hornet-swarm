# How severity is judged

One scale for every functional and chaos report: the sample reports, the chaos reports, and client reports. Security reports keep their own scale, in each `docs/security-report-<lab>.md`.

- **High:** a customer cannot complete something the site exists for (such as paying for an order, booking, or signing in), or money is wrong, a customer is locked out, or an order or payment is lost.
- **Medium:** the customer can carry on, but sees wrong data, is told something false, or is not told that something failed.
- **Low:** wording, spelling, labels, ordering, or layout that does not stop anyone.

## Chaos findings

Chaos adds the disruption, such as a lost request or a delay, so the disruption itself is not the finding. A chaos finding is rated by what the customer is left with once it has happened. A payment form that stays up with no message is Medium. A balance that changes twice is High.

## Accessibility findings

axe-core gives each problem an impact: critical, serious, moderate, or minor. That is a starting point, not the grade. Critical starts at High, serious at Medium, and moderate or minor at Low. The reviewer then grades by what a customer using a screen reader, a keyboard, or magnification can still do:

- **High:** they cannot complete something the site exists for, such as an unlabelled card field or a checkout button with no name.
- **Medium:** they can carry on but miss something that matters, such as a quantity control with no name or a faint "Out of stock".
- **Low:** they lose a little time or context, such as an icon button that only reveals a password.

In a client report, the reviewer's grade goes in the job file's `severity_overrides`, by the issue's re-test key, with the reason. The report prints the reason beside the issue.

The harness's own WCAG 2.2 checks start at: a focused control entirely hidden behind a banner (2.4.11) Medium, a password field that blocks pasting (3.3.8) Medium, and help links in a different order from page to page (3.2.6) Low. Dragging (2.5.7), a password field with autocomplete off or a puzzle (3.3.8), and a value typed twice (3.3.7) are listed for a person to review, not graded, because the check cannot tell whether an alternative exists.

## Internal findings file

`ia-findings.json` is not a client report. It maps axe-core impact onto its own four-step scale: critical stays critical, serious is high, moderate is medium, and minor is low. Client reports still use the High, Medium, and Low grades above. A finding under 0.5 confidence is `needs_review` and is not scored.

## Header and cookie check findings

A `header_cookie_check` step uses Low and Medium only. It does not use the functional scale above, and it does not grade a site as meeting a standard. High is not used: the step cannot show that a customer is locked out or that money is wrong.

- **Medium:** the page was served over plain HTTP, the document was loaded over TLS 1.0, TLS 1.1, or SSL, or a session-named cookie on HTTPS is missing the HTTPS-only flag or missing `HttpOnly`. The cookie value is not recorded. The flag says the browser will send the cookie, or that page script can read it.
- **Low:** a missing or weak browser policy on the document response (Content-Security-Policy, `nosniff`, Referrer-Policy, frame protection, HSTS on HTTPS), a non-session cookie on HTTPS missing the HTTPS-only flag, `SameSite=None`, or a redirect with no final page to check.

On plain HTTP, a missing HSTS header and a missing HTTPS-only flag are not separate findings. The plain HTTP finding is the one that is recorded. A loopback page served over plain HTTP is recorded the same way.

## Planted faults

A practice site's deliberate bugs are rated like any other fault. On a client's site, they would be real.
