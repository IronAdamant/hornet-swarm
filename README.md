# Hornet Swarm

Hornet Swarm is a local tool for checking websites you own, or websites someone has authorised you in writing to test. It runs a small browser inside one container per test account. You talk to it from the `hornet-swarm` command, or from an AI agent through the MCP server.

It is not a load tester, and it does not try to break into sites. If a page asks for a human check or a second code, Hornet Swarm stops and tells you.

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
pnpm hornet-swarm doctor
```

The age private key is created in the macOS Keychain the first time Hornet Swarm stores a password. The Keychain item is named `hornet-swarm-age-key`. An existing item named `aegis-age-key` still unlocks the store. The private key is not written into the project. On Linux CI, set `SOPS_AGE_KEY` for that job only.

3. Add an authorisation file that names the domains you are allowed to test, then point a project at your local fixture or your own site. The checked-in examples are templates. Do not run them against a live site from this repo's tests. The offline fixture is `test/fixture-app`:

```bash
pnpm --filter @hornet-swarm/fixture-app start
node test/e2e/prepare-fixture.mjs
pnpm hornet-swarm env up --project fixture --count 1
```

4. Run the sample checks:

```bash
pnpm hornet-swarm suite --project fixture \
  --journey examples/journeys/consistencyhub/01-signin-dashboard.journey.yaml \
  --journey examples/journeys/consistencyhub/02-tenant-isolation.journey.yaml
```

Reports land in `~/.hornet-swarm/runs/<run id>/`. `summary.md` is the short version for a person. `analysis.json` is the detailed version for an agent.

## Everyday commands

- `hornet-swarm env up --count 10` starts the default fleet.
- `hornet-swarm env reset` recreates the containers. `hornet-swarm env reset --hard` also rebuilds the runner and proxy images and the project network.
- `hornet-swarm env status` shows health.
- `hornet-swarm kill` stops a live run. `hornet-swarm kill --release` lets new runs start.
- `hornet-swarm creds serve` opens the private login page on `127.0.0.1`.
- `hornet-swarm creds add <project> <label>` asks for a username and password without showing the password.
- `hornet-swarm export-evidence <run id> --project <id> --out proof.zip` packs the proof for one run.
- `hornet-swarm accept-baseline <run id> --project <id>` saves the current screenshots as the comparison point.

A macOS Shortcut can run `hornet-swarm kill` if you want a keyboard stop. Hornet Swarm does not register a global hotkey itself.

## Agents

Open `http://127.0.0.1:7781/setup` to keep the website and up to ten logins. Start that page with `hornet-swarm creds serve` if it is not already open. Fill the website first, then the cards in order: username, password, and a personality for that sub-agent. Press Ready and confirm with Touch ID. The passwords stay in the encrypted store.

After Ready, `hornet-swarm swarm --json` and the MCP tool `get_swarm` show the website, the labels, and the personalities. They do not show passwords. Each label is one sub-agent and one browser. The browser inside the container is full Chromium on a virtual screen, the same browser a person would use, rather than headless Chromium.

Start the MCP server with `hornet-swarm-mcp` (the built file is `packages/mcp-server/dist/main.js`). Agents see labels such as `qa-user-1`. They never receive passwords. When a login is missing, the agent calls `request_credentials` and you type it on the local page or with `hornet-swarm creds add`.

One agent holds one test login at a time.

## Runner output folders

Each runner writes screenshots, traces, and network logs under `~/.hornet-swarm/runners/<project>/<label>`. That folder is mode `0700`. The owner is the user who starts Hornet Swarm, and the group is that user's group.

Docker Desktop on this Mac shows the folder to the container as root, and the runner user (uid 10001) can still write there. The files come back owned by the user who started Hornet Swarm, so the controller can read them. Mode `0700` is enough for that. A group shared with the container would let more accounts in, and it is not required.

If that folder already exists and other accounts can open it, startup stops and names the folder. Hornet Swarm does not change its mode.

## Tests

```bash
pnpm test
pnpm test:e2e
```

`pnpm test` is the unit suite. `pnpm test:e2e` is the end-to-end suite. Both use the offline fixture only. Do not point them at a live site.

End-to-end tests need Docker or OrbStack, sops, age, and tesseract on this Mac. GitHub Actions runs build, lint, and unit tests on Linux for every push and pull request (`.github/workflows/ci.yml`). That Linux job does not run `pnpm test:e2e`. GitHub-hosted macOS runners do not provide Docker or OrbStack, so the end-to-end command stays manual:

```bash
pnpm test:e2e
```

The Linux job also runs `pnpm test:coverage`. That command fails the check when redactor or policy coverage drops below the gate in `vitest.config.ts`.

On 12 October 2026 this Mac ran both commands against the offline fixture only.

`pnpm test` exited 0. 19 files passed and 80 tests passed.

`pnpm test:e2e` exited 0. 16 files passed and 43 tests passed.
