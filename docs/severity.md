# How severity is judged

One scale for every functional and chaos report: the sample reports, the chaos reports, and client reports. Security reports keep their own scale, in each `docs/security-report-<lab>.md`.

- **High:** a customer cannot complete something the site exists for (such as paying for an order, booking, or signing in), or money is wrong, a customer is locked out, or an order or payment is lost.
- **Medium:** the customer can carry on, but sees wrong data, is told something false, or is not told that something failed.
- **Low:** wording, spelling, labels, ordering, or layout that does not stop anyone.

## Chaos findings

Chaos adds the disruption, such as a lost request or a delay, so the disruption itself is not the finding. A chaos finding is rated by what the customer is left with once it has happened. A payment form that stays up with no message is Medium. A balance that changes twice is High.

## Planted faults

A practice site's deliberate bugs are rated like any other fault. On a client's site, they would be real.
