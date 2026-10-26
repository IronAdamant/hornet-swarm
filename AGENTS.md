# Hornet Swarm

A local harness that checks websites through isolated Chromium containers, one per test account, driven by the `hornet-swarm` CLI or by AI agents over MCP. `README.md` is the overview, `docs/reference.md` covers setup and every command, `docs/agents.md` is the playbook for running a swarm, and `SECURITY.md` has the rules on secrets.

## Commands

`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`. End-to-end tests import `packages/*/dist`, so rebuild after a source change. Run `pnpm image` after a change to the runner or to `egress-proxy.ts`, then restart the MCP server and run `pnpm hornet-swarm env reset --project <id>`.

## Rules and what enforces them

| Rule | Enforced by |
|---|---|
| Files, folders, and sockets are created owner-only, and links or foreign-owned paths are refused | `core/src/secure-fs.ts`; lint `hornet-swarm/secure-fs-only`; `test/unit/secure-fs.test.ts`; `test/unit/lint-rules.test.ts` (past bugs d0043ee, 294967a, f05f31f, bdb438b) |
| Saved artifacts, reports, and the audit log hold only sealed (redacted) content | `Redacted` type from `Redactor.seal`; lint `hornet-swarm/sealed-artifacts-only`; `test/types/sealed-sinks.ts`; `test/unit/leak-corpus.test.ts` (every past leak shape) |
| A login is a `Secret` from `Secret.parse`, which holds the length rule; usernames are exempt by field | `core/src/secret.ts`; `test/unit/secret-type.test.ts`; `test/types/sealed-sinks.ts` |
| A runner starts only for an authorised run, gets a per-run token, and cannot be reached from its browser | `AuthorisedRun` and `RunnerSession` in `controller/src/runner-session.ts`; `runner-isolation.ts` checks on create and reuse; `test/unit/runner-isolation.test.ts`; `test/unit/attacker-page.test.ts` |
| A report finding cites a saved run's step, status, or page text, on the High, Medium, Low scale | `check_findings` and `hornet-swarm findings`; `VerifiedFinding`; `test/unit/evidence-claims.test.ts`; `test/types/verified-findings.ts` |
| A client report never says a site is compliant, certified, or meets WCAG; it lists issues found against WCAG 2.2 AA in tested pages, with a scope and limits statement | `assertNoComplianceClaim` in `core/src/report-wording-guard.ts`, run on every rendered report and re-test comparison; brand names and job reasons checked when the job is read; `test/unit/client-report-wording.test.ts` (also scans the sample reports in `docs/`) |
| An internal findings file is ASCII, blocks banned client words in prose, and is not marked ready for a client unless it is reviewed WCAG 2.2 AA with every issue verified in evidence | `validateIaFindings` in `report/src/ia-findings.ts`; `iaFindingsFromRun`; `test/unit/ia-findings.test.ts` |
| A WCAG criterion that needs a person is shown as needs manual review, never as clear | `CriterionVerdict` in `core/src/criterion-verdict.ts` (only `decide` makes one); `clientReportSchema` refuses an edited row; `test/unit/wcag22-criteria.test.ts` |
| Client reports carry the agency's brand unless Iron Adamant is asked for | `resolveBrand` in `report/src/client-report-branding.ts`; `test/unit/client-report-wording.test.ts` |
| A run that failed its redaction check gets no client report or re-test comparison | `buildClientReport` and `runRetest`; `test/unit/scheduled-retest.test.ts`; `test/unit/client-report-builder.test.ts` |
| A pass means every step was recorded and passed | `vouchedReport` in `controller/src/suite.ts`; `test/unit/evidence-claims.test.ts` |
| Tests reach only the offline fixture in `test/fixture-app` | lint `hornet-swarm/no-live-hosts-in-tests`; runtime guard `test/support/offline-network.mjs`; `test/unit/offline-network.test.ts` |
| A rebuilt MCP server is restarted before use | `mcp-server/src/freshness.ts`; `test/unit/lab.test.ts` |
| A captcha or second-code page stops the journey | runner `resolveChallenge`; `test/unit/review-gaps.test.ts`; `test/unit/operator-code.test.ts` |
| Only the owner releases the kill switch | no MCP tool releases it; `test/e2e/mcp.test.ts` |
| Types, lint, unit tests, and the redaction coverage gate pass on every push | `.github/workflows/ci.yml`; `test/unit/ci.test.ts` |

## Judgment calls no check can make

- Test a live site only when an authorisation file covers it (`owner`, `contract`, or `public_practice`) and the owner asked for that site. Never widen an authorisation.
- Never put a password, TOTP secret, or age key in a reply, note, journey, or commit. Never solve a captcha or a second code. Release the kill switch only when the owner asks.
- Labs (`node scripts/setup-lab.mjs`) run on this Mac only and use made-up details.
- Commit as the owner: `git -c user.name="Aron Amos" -c user.email="aron.amos@ironadamant.com" commit ...`. Leave `.stele-context/` untracked.
