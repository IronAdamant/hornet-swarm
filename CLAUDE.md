# Hornet Swarm

A local harness that checks websites through isolated Chromium containers, one per test account, driven by the `hornet-swarm` CLI or by AI agents over MCP. Read `README.md` for setup and `SECURITY.md` for the rules on secrets.

## Working on the code

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`.
- End-to-end tests import `packages/*/dist`. Rebuild after a source change. Rebuild the images with `pnpm image` after a change to the runner or to `egress-proxy.ts`.
- Tests use the offline fixture in `test/fixture-app` only. Never point a test at a live site.
- Commit as the owner: `git -c user.name="Aron Amos" -c user.email="aron.amos@ironadamant.com" commit ...`. Leave `.stele-context/` untracked.

## Running a swarm as an agent

- `.mcp.json` registers the MCP server as `hornet-swarm`. `.claude/agents/hornet-swarm-tester.md` is the sub-agent for one label. The playbook is `docs/agents.md`.
- Test a live site only when an authorisation file covers it (`owner`, `contract`, or `public_practice`) and the owner has asked for that site. Never widen an authorisation yourself.
- Practice sites: `node scripts/setup-practice.mjs the-internet` or `saucedemo`, then `pnpm hornet-swarm env up --project <id>`.
- Never put a password, TOTP secret, or age key in a reply, a note, a journey, or a commit. Never solve a captcha or a second code. Only release the kill switch when the owner asks.
