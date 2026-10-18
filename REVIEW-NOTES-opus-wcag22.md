# Review notes: WCAG 2.2 AA, white-label client reports, and monthly re-tests

Author: Claude Opus, cloud agent. Branch `cursor/wcag22-white-label-retest-859d`, stacked on `cursor/structural-safety-guards-da86` (PR #2, not merged). Nothing is merged.

## Summary

- Accessibility steps now check against WCAG 2.2 AA by default. axe-core runs with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, and `wcag22aa` tags, and the runner adds its own checks for the new 2.2 criteria. 4.1.1 Parsing is treated as obsolete.
- `hornet-swarm client-report` turns a saved run into a plain-English, white-label report: a summary, issues with severity, where, why it matters, and how to fix, the sign-up, log in, cart, and checkout results, the criteria table, scope and limits, and an evidence appendix. It is written as Markdown, HTML, and JSON.
- `hornet-swarm retest --job <file> [--if-due]` re-runs a saved job and writes a comparison with the previous run: new, fixed, and still-open issues, plus journey regressions.
- The two hard rules are enforced in code, not left to the writer. A report can never say compliant or certified. A criterion that needs a person can never show as clear.
- Everything from PR #2 is kept: the authorisation gate, sealed writes, secure-fs, evidence paths, and the redaction-failure rule. A run that failed redaction gets no client report.

## What I ran

| Command | Result |
|---|---|
| `pnpm build` | pass |
| `pnpm typecheck` | pass, including `test/types` |
| `pnpm lint` | pass |
| `pnpm test` with `HORNET_REQUIRE_HISTORY=1` and a throwaway age key | 375 passed, 2 failed (39 files) |
| `pnpm test:coverage` without `test/unit/doctor.test.ts` | 374 passed. Lines 95.88%, branches 91.85%, so the thresholds pass |
| `node scripts/generate-sample-report.mjs --check` | pass (also run by a unit test) |
| `pnpm test:e2e` | not run. This VM has no Docker socket |

The two failures are the same two as on PR #2: `test/unit/doctor.test.ts`, "doctor --json reports the live Docker API" and "doctor --estimate 10 prints the measured figures". Both need `/var/run/docker.sock`.

The base branch had 322 unit tests. This branch adds 55 tests in six new files and changes one existing file:

- `wcag22-criteria.test.ts`: the catalogue, the axe-core tags, and the verdict invariant.
- `client-report-wording.test.ts`: forbidden wording, branding, rendering, and the sample docs.
- `client-report-builder.test.ts`: journeys, issues, the 2.2 findings, reviewer grades, and the diff.
- `scheduled-retest.test.ts`: the sealed files, previous-report lookup, due dates, and `runRetest` with the suite stubbed.
- `wcag22-runner-checks.test.ts`: real Chromium on a local page with each 2.2 fault planted.
- `accessibility.test.ts` (updated): the new default tags, and a 2.1 run still named 2.1.

Docker-only end-to-end tests, all skipped here (20 files in `test/e2e`): accessibility, creds, env-reset, gate-all, hard-reset, inspect, leases, m7, mcp, output-perms, policy, rate-limit, realistic-site, redaction, relay-port, review-fixes, socket-perms, suite-reports, swarm-board, unattended. I updated `test/e2e/accessibility.test.ts` to expect `wcag22aa` and a saved `wcag22` block, but I could not run it.

## WCAG 2.2 criteria: how each is checked

The catalogue is in `packages/core/src/wcag22-criteria.ts`. It covers all 55 criteria at levels A and AA. I count a criterion as "automated" only if two things hold: the checks cannot miss a failure on the elements they evaluate, and anything they cannot decide comes back as needs review. Only two criteria meet that bar.

| How it is checked | Criteria | What the report can say |
|---|---|---|
| Automated (2) | 1.4.3, 2.5.8 | Issues found; "No issues found by automated checks on the tested pages" (only if nothing was left undecided); needs manual review; not tested |
| Partly automated (23) | 1.1.1, 1.2.2, 1.3.1, 1.3.5, 1.4.1, 1.4.2, 1.4.4, 1.4.12, 2.1.1, 2.2.1, 2.2.2, 2.4.1, 2.4.2, 2.4.4, **2.4.11**, **2.5.7**, 3.1.1, 3.1.2, **3.2.6**, 3.3.2, **3.3.7**, **3.3.8**, 4.1.2 | Issues found, needs manual review, or not tested. Never clear |
| Manual (30) | 1.2.1, 1.2.3, 1.2.4, 1.2.5, 1.3.2, 1.3.3, 1.3.4, 1.4.5, 1.4.10, 1.4.11, 1.4.13, 2.1.2, 2.1.4, 2.3.1, 2.4.3, 2.4.5, 2.4.6, 2.4.7, 2.5.1, 2.5.2, 2.5.3, 2.5.4, 3.2.1, 3.2.2, 3.2.3, 3.2.4, 3.3.1, 3.3.3, 3.3.4, 4.1.3 | Always needs manual review, unless an axe finding is mapped to it |
| Obsolete | 4.1.1 Parsing | Not checked. A finding mapped only to 4.1.1 is dropped under `wcag22aa` |

The six new criteria:

| Criterion | Level | How it is checked |
|---|---|---|
| 2.4.11 Focus Not Obscured (Minimum) | AA | Partly automated. The runner focuses up to 60 controls. It samples five points on each and records a control entirely covered by a fixed or sticky element (an issue). It cannot see a banner that only appears after interaction. |
| 2.5.7 Dragging Movements | AA | Partly automated. It finds `draggable="true"`, custom `role="slider"`, and common drag and slider classes. These go under "Needs a person to review", because a check cannot tell whether a click alternative exists. |
| 2.5.8 Target Size (Minimum) | AA | Automated, through axe-core's `target-size` rule (the only axe rule tagged `wcag22aa`). |
| 3.2.6 Consistent Help | **A** | Partly automated. It records the order of contact, help, FAQ, phone, email, and chat links on each page. Help in a different order from one page to the next is an issue. |
| 3.3.7 Redundant Entry | **A** | Partly automated. Fill steps record a SHA-256 hash of each value typed. The same value typed again on a later page, into a field the site left empty, goes under review. Credentials and TOTP codes are never tracked. |
| 3.3.8 Accessible Authentication (Minimum) | AA | Partly automated. A password field that blocks paste (a synthetic paste event that is prevented) is an issue. `autocomplete="off"` and a visible captcha go under review. |

The brief listed all six as "2.2 AA criteria". 3.2.6 and 3.3.7 are Level A in WCAG 2.2. They are part of an AA check either way. The report shows the correct level.

## How the hard rules are enforced

- **No compliance claim.** `assertNoComplianceClaim` (`core/src/report-wording-guard.ts`) refuses "compliant", "compliance", "complies with", "certified" or "certificate", "accredited", "conformance", "conforms to WCAG", "fully accessible", "meets/passes WCAG", and "WCAG … verified/passed". `renderClientReport` and `retestDiffMarkdown` call it on every output, so a report that breaks the rule is never written. Brand names, the client's business and site names, and every reason in a job file are checked when the job is read. `test/unit/client-report-wording.test.ts` covers each claim form, five rendered scenarios in both formats, an edited headline, the re-test comparison, and the committed sample docs.
- **Quoted evidence is exempt.** The guard skips code spans and double-quoted text, because a report quotes the site's own words. Otherwise a shop selling "Certified organic" tea could never get a report. Every word the report itself writes is still checked. This is a judgement call; see the last section.
- **Manual review is never a pass.** A `CriterionVerdict` can only be made by `CriterionVerdict.decide`. It has a private constructor, a `#private` brand, and a constructor check that throws on an outcome the criterion can never have. `clientReportSchema` re-checks every saved row. It refuses an outcome the catalogue forbids, result words that don't match the outcome, and an automation or level that differs from the catalogue. So an edited `client-report.json` cannot be rendered.
- **Agency brand by default.** `resolveBrand` uses the agency unless `use: iron_adamant` is set. If no agency is named, it stops with an error instead of quietly printing Iron Adamant on an agency's report. A job that names an agency wins over a global `use: iron_adamant`.
- **Scope and limits.** Every report says:
  - it lists issues found against WCAG 2.2 AA in tested pages, and covers only the listed pages on that date
  - it is not legal advice and not a security test
  - the testing was done with the owner's written authorisation, naming the authoriser and the record. For a `public_practice` site it says, truthfully, that the site's published permission was used instead.
  - only test accounts were used
  - the needs-manual-review criteria were not checked by a person

  The re-test comparison carries the security and authorisation lines too.

## What changed

Core (`packages/core/src`):

- `wcag22-criteria.ts`: the catalogue and tag parsing.
- `criterion-verdict.ts`: outcomes, their words, and the verdict class.
- `wcag22-page-signals.ts`: schemas for the runner's 2.2 signals.
- `report-wording-guard.ts`: the forbidden-claims guard.
- `client-job-schema.ts`: job files, branding, journey kinds, cadences, and severities.
- `accessibility.ts`: `wcag22aa` is now the default.
- `schemas.ts`: optional `criteria`, `review_rules`, `wcag22`, and `redundant_entry` fields, and global `branding`.

Runner (`packages/runner/src`):

- `accessibility-step.ts`: the axe code moved out of `job.ts`. It records the criteria for each violation and the undecided rules, drops 4.1.1-only findings, runs the 2.2 checks, and saves them, masked.
- `wcag22-page-checks.ts`: the in-page checks.
- `redundant-entry-tracker.ts`: hashes only.
- `job.ts`: wires the tracker into fill steps.
- axe-core is now found with `createRequire(...).resolve`. The old `import.meta.resolve` failed under vitest, so accessibility steps had never run in unit tests.

Report (`packages/report/src`):

- `client-report-model.ts`: zod schemas for the report.
- `client-report-branding.ts`
- `plain-language-rules.ts`: about 35 axe rules and the harness checks in owner-facing words.
- `client-report-page-issues.ts`, `client-report-journeys.ts`, `client-report-builder.ts`
- `client-report-render.ts`: Markdown, and HTML with print CSS.
- `retest-diff.ts`

Controller and CLI:

- `client-report-service.ts`: loads the job, resolves logos, and writes sealed `client-report.*` and `retest-diff.*` files into the run folder.
- `scheduled-retest.ts`: `retestDue` and `runRetest`. `runRetest` calls `runSuite` with journey ids only, `journeyPathsAllowed: false`, no regressions, and the project's own authorisation, and writes an audit entry.
- `run-folder-files.ts`: shared with `findings-report.ts`.
- The CLI gains `client-report` and `retest`.

Examples, docs, and scripts:

- `examples/jobs/fixture-shop-monthly.job.yaml` and an example agency logo.
- Accessibility journeys for the labs that remain, including Juice Shop.
- `examples/sample-runs/`: fixture runs.
- `scripts/generate-sample-report.mjs`.
- Sample outputs: `docs/fixture-sample-client-report.{md,html}` and `docs/fixture-sample-retest-diff.md`.
- `docs/reference.md` has a new section, "Client reports and monthly re-tests", with a launchd example. README, `docs/agents.md`, `docs/client-engagement.md`, and `docs/severity.md` are updated, and `AGENTS.md` has four new rules in its table.
- Every "WCAG 2.1 AA" in code, docs, and journey names now says 2.2. Journey names no longer say pages "meet" the standard.

## Breaking or behaviour-changing config

- **Default standard is now `wcag22aa`.** An `accessibility` step with no `standard` now also runs axe-core's `target-size` rule and the 2.2 checks. A journey with `fail_on: serious` can now fail on a target-size finding (rated serious) where it passed before. Set `standard: wcag21aa` on the step to keep the old behaviour.
- **`accessibilityTags()` with no argument** now returns the five 2.2 tags.
- **The saved accessibility file and `run.json` steps** gain optional fields (`criteria`, `review_rules`, `wcag22`, `redundant_entry`). Older runs still parse. Older versions of the harness will refuse new `run.json` files, because the schemas are strict.
- **Global `config.yaml`** accepts an optional `branding` block. A job file is a new file type, validated strictly.
- **The runner image must be rebuilt** (`pnpm image`), because the runner code changed.

## Judgement calls for Aron

- **The sample report comes from fixtures, not a live run.** The fixture runs in `examples/sample-runs/` are shaped like saved runs so the real report code reads them. Three parts are illustrative and labelled as such:
  - the target-size finding
  - the filter lists being "fixed" in month two
  - which month the checkout failed in

  `node scripts/generate-sample-report.mjs` rebuilds the sample from those fixtures. It does not fetch a site.
- **The historical lab accessibility reports were left as recorded.** `docs/accessibility-report-*-lab.md` were 2.1 runs. Rewriting them to say 2.2 would misstate what was run, so each now opens with a dated note and the command to re-run at 2.2.
- **Quoted page words are exempt from the wording guard** (see above). If you would rather refuse any report that contains those words anywhere, delete the quote stripping in `assertNoComplianceClaim`. Expect it to block reports for shops whose own copy uses them.
- **Automated grades start from axe-core's impact** (critical → High). The sample job shows reviewer grades in `severity_overrides`, with reasons taken from the lab accessibility report.
- **The sample job leaves sign-up out on purpose** ("not in scope"), because sign-up creates a new account on every run. The report says so.
- **No MCP tool for client reports yet.** Agents use the CLI, and only the owner should send a report. Adding `client_report` and `retest` MCP tools would be a small follow-up.
- **File size.** `controller/src/suite.ts` (1,390 lines) and `runner/src/job.ts` (1,173) were already over 600 lines on the base branch. `job.ts` is smaller here because the axe code moved out. Splitting them was out of scope.

## Steps to run on the Mac

```bash
cd ~/hornet-swarm
git fetch origin && git checkout cursor/wcag22-white-label-retest-859d
pnpm install --frozen-lockfile
pnpm build
pnpm image                                   # the runner changed
# Restart the MCP server in Claude Code after the build.

pnpm typecheck && pnpm lint && pnpm test     # doctor tests should pass with Docker up
pnpm test:e2e                                # includes the updated accessibility e2e

# Real 2.2 check on a local lab (made-up details only):
node scripts/setup-lab.mjs
pnpm hornet-swarm env reset --project juice-shop-lab
pnpm hornet-swarm suite --project juice-shop-lab --journey accessibility-visitor accessibility-customer

# Rebuild the fixture sample, which fetches nothing:
node scripts/generate-sample-report.mjs
```

To replace the fixture sample with a run from a lab the owner has up, copy that run's `client-report.md`, `client-report.html`, and `retest-diff.md` over the files in `docs/` and point `OUTPUTS` in `scripts/generate-sample-report.mjs` at them, or keep the fixture sample under its current name. Otherwise the sample check test will flag the difference.

For the monthly subscription, install the launchd agent from "Client reports and monthly re-tests" in `docs/reference.md`, pointed at the client's job file. Read each report before sending it.
