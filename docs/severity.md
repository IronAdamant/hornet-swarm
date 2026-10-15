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

## Planted faults

A practice site's deliberate bugs are rated like any other fault. On a client's site, they would be real.
