# Changelog

All notable changes to hornet-swarm are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-20

First tagged release. It covers everything up to and including PRs #2 to #8.

### ⚠️ BREAKING CHANGES

Read these before you upgrade an existing install.

- **Results are kept for 7 days by default, not 30.** `results_retention_days` in `~/.hornet-swarm/config.yaml` now defaults to `7`. Runs older than that are removed when the next run starts. To keep runs longer, set `results_retention_days` yourself. (#8)
- **Accessibility checks default to WCAG 2.2 AA (`wcag22aa`).** An `accessibility` step with no `standard` now also runs axe-core's `target-size` rule and the new 2.2 checks. A journey with `fail_on: serious` can now fail on a target-size finding where it passed before. To keep the old behaviour, set `standard: wcag21aa` on the step. `accessibilityTags()` with no argument now returns the five 2.2 tags. (#3)
- **Private files and folders must be owner-only.** `~/.hornet-swarm` and every private file and folder in it (project, lease, credential and token files, and the runner socket folder) are refused if other accounts can open them, if they are a symbolic link, or if another user owns them. The error names the command that fixes it. A home made by an older version is often `0755`. Fix it once with:

  ```sh
  chmod -R go-rwx ~/.hornet-swarm
  ```

  Runner containers that don't match the isolation spec are now replaced instead of reused. (#2)
- **Full-disk encryption is required** for any machine that stores client runs. On a Mac that is FileVault. Turn it on before a client job is stored on the machine. See `docs/reference.md` and `docs/client-engagement.md`. (#8)
- **Rebuild the runner image** with `pnpm image`, because the runner code changed. (#3, #4)
- **Saved run files gained fields.** The saved accessibility file and `run.json` steps gain optional fields (`criteria`, `review_rules`, `wcag22`, `redundant_entry`). Older runs still parse, but older versions of the harness will refuse new `run.json` files, because the schemas are strict. (#3)

### Added

- WCAG 2.2 AA checks. axe-core runs with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` tags, and the runner adds its own checks for 2.4.11 (focus hidden behind a sticky or fixed banner), 2.5.7 (drag-only controls), 3.2.6 (where help links sit), 3.3.7 (a value typed again on a later page, stored as a hash only) and 3.3.8 (password paste blocked, autocomplete off, or a puzzle). 2.5.8 comes from axe's `target-size` rule. The 55 A and AA criteria are catalogued in `core/src/wcag22-criteria.ts`. (#3)
- `hornet-swarm client-report --job <file> --run <id>` writes a plain-English, white-label client report (`client-report.md`, `.html` and `.json`) into the run folder. It carries the agency brand from the job file or `~/.hornet-swarm/config.yaml`. (#3)
- `client-report` also writes `client-report.pdf`. Each finding lists its WCAG 2.2 criterion and level, such as 1.4.3 (AA), and the scope and limits state the coverage of automated checks plus a manual pass, that no screen-reader testing was done, and that the report is not a compliance certificate. (#5)
- `hornet-swarm retest --job <file> [--if-due]` re-runs a saved job through the normal authorised suite and writes `retest-diff.md` with new, fixed and still-open issues and journey regressions. The docs include a launchd example. (#3)
- `hornet-swarm findings` and the MCP tool `check_findings` check report findings against the saved runs. (#2)
- `hornet-swarm delete-after-delivery --job <file>` wipes a delivered job's saved runs, including page bodies and evidence. Other jobs' runs stay. (#8)
- A fill step can name the frame a card field sits in (Stripe Elements, Shopify checkout). A captcha frame is refused. (#6)
- A `storefront_password` step fills the password form Shopify shows before a storefront opens. (#6)
- An `inbox` step (`inbox: { mailbox, selector }`) reads a code from a test inbox and types it into the named field. Without that step, a page that says a code was emailed still stops the run. (#6, #7)
- A journey can set `viewport: { preset: phone }` (390 by 844) and `keyboard: { key: Tab }` for a keyboard-only pass. (#8)
- `docs/wcag22-manual-checklist.md`, the human WCAG 2.2 checklist. It never marks a manual criterion as passed. (#8)
- Each suite writes `ai-usage.json` with its model calls and cost. (#8)
- Client docs tell clients to pre-verify test accounts and turn captcha off on staging when a journey has no inbox step. (#7)

### Changed

- Saved files go through sealed, redacted writers only. A file that cannot be redacted is withheld, and evidence export refuses a run with withheld files. (#2)
- Files, folders and sockets are created owner-only through `core/src/secure-fs.ts`, enforced by a lint rule. (#2)
- Runner sessions issue and revoke a per-run token, and runner containers are checked for isolation (internal network, read-only token, no published ports, no `docker.sock`, dropped capabilities) on create and on reuse. The egress proxy denies the control port. (#2)
- Login length rules live in one place, `Secret.parse` (8 characters for a password or TOTP secret, a non-empty username). (#2)
- Report findings must be backed by evidence in a saved run, and a runner "pass" that does not record every step it was sent becomes a harness error. (#2)
- Stored page responses have email addresses and phone numbers masked. Card numbers stay with the existing secret masking. (#8)
- Reports never claim compliance or certification, a criterion that needs a person is never shown as clear, building a report with no agency named stops with an error, and no report is built for a run that failed redaction. (#3)
- 4.1.1 Parsing is treated as obsolete under `wcag22aa`. (#3)
- The sample reports in `docs/sample-*-toolshop-live.*` come from the second live Toolshop re-test (17 October 2026, WCAG 2.2 AA). The regenerated fixture samples are now `docs/fixture-sample-*`. (#4)
- Tests can't reach live sites (lint rule plus a runtime network guard), and CI runs `pnpm typecheck` with full git history. (#2)
- The runner job file and `suite.ts` are split into modules under 600 lines each. (#6, #8)

### Fixed

- The runner opens its control token as root and keeps that file descriptor after dropping to the runner user, so a host-owned mode-0600 token stays readable on Linux Docker. (#4)
- A run that stops at its time limit and leaves a half-written `trace.zip` drops that file and finishes as blocked, instead of exiting with an uncaught error. (#4)

### Known limitations

From the PR notes for this release:

- No Shopify or WooCommerce store has been authorised, so live checkouts were not run.
- The Linux token fix was proved with a file descriptor on a Mac, not on a Linux host.
- The test inbox is only mounted into the runner container when `AEGIS_INBOX_DIR` is set there.
- No screen-reader pass was done. The PDF report is text only (no logo or page furniture).

[Unreleased]: https://github.com/IronAdamant/hornet-swarm/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/IronAdamant/hornet-swarm/releases/tag/v0.1.0
