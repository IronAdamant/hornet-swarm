# Aegis

Aegis is a local tool for checking websites you own, or websites someone has authorised you in writing to test. It runs a small browser inside one container per test account. You talk to it from the `aegis` command, or from an AI agent through the MCP server.

It is not a load tester, and it does not try to break into sites. If a page asks for a human check or a second code, Aegis stops and tells you.

## What you need

- macOS on Apple Silicon
- Node.js 22
- pnpm 9
- Docker Desktop (or another engine that speaks the Docker API, such as OrbStack)
- `sops` and `age` (`brew install sops age`)
- `tesseract` so screenshots can be checked for leaked passwords (`brew install tesseract`)

## Set up

1. Install the workspace and build it:

```bash
pnpm install
pnpm build
pnpm image
```

2. Check the machine:

```bash
pnpm aegis doctor
```

The age private key is created in the macOS Keychain the first time Aegis stores a password. The Keychain item is named `aegis-age-key`. The private key is not written into the project. On Linux CI, set `SOPS_AGE_KEY` for that job only.

3. Add an authorisation file that names the domains you are allowed to test, then point a project at your local fixture or your own site. The checked-in examples are templates. Do not run them against a live site from this repo's tests. The offline fixture is `test/fixture-app`:

```bash
pnpm --filter @aegis/fixture-app start
node test/e2e/prepare-fixture.mjs
pnpm aegis env up --project fixture --count 1
```

4. Run the sample checks:

```bash
pnpm aegis suite --project fixture \
  --journey examples/journeys/consistencyhub/01-signin-dashboard.journey.yaml \
  --journey examples/journeys/consistencyhub/02-tenant-isolation.journey.yaml
```

Reports land in `~/.aegis/runs/<run id>/`. `summary.md` is the short version for a person. `analysis.json` is the detailed version for an agent.

## Everyday commands

- `aegis env up --count 10` starts the default fleet.
- `aegis env reset` recreates it.
- `aegis env status` shows health.
- `aegis kill` stops a live run. `aegis kill --release` lets new runs start.
- `aegis creds serve` opens the private login page on `127.0.0.1`.
- `aegis creds add <project> <label>` asks for a username and password without showing the password.
- `aegis export-evidence <run id> --project <id> --out proof.zip` packs the proof for one run.
- `aegis accept-baseline <run id> --project <id>` saves the current screenshots as the comparison point.

A macOS Shortcut can run `aegis kill` if you want a keyboard stop. Aegis does not register a global hotkey itself.

## Agents

Start the MCP server with `aegis-mcp` (the built file is `packages/mcp-server/dist/main.js`). Agents see labels such as `qa-user-1`. They never receive passwords. When a login is missing, the agent calls `request_credentials` and you type it on the local page or with `aegis creds add`.

One agent holds one test login at a time.

## Tests

```bash
pnpm test
pnpm test:e2e
```

The end-to-end tests use the local fixture only.
