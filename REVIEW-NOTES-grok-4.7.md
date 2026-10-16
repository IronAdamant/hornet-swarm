# Review of PR #2 — structural safety guards

Reviewer: grok-4.7, independent of the author. Branch `cursor/structural-safety-guards-da86` (base `5723644`). The five classes in the PR body are the right shape, and the history proofs I re-ran really do fail on the old code. Several of the "structurally impossible" claims still had a bypass. Those are fixed on this branch in small commits. What is left is called out below for the owner.

## Verdict

Hold the merge. Land the fixes on this branch with the PR. Do not merge until end-to-end has passed on a Mac, or until the Linux token handoff below is in and end-to-end has passed on Linux. The unit suite, typecheck, lint, and the redaction coverage gate are in good shape. Two `doctor` tests need a live Docker socket and did not run here.

## What I ran

| Command | Result |
|---|---|
| `pnpm build` | pass |
| `pnpm typecheck` | pass, including `test/types` |
| `pnpm lint` | pass |
| `pnpm test` with `HORNET_REQUIRE_HISTORY=1` | 320 passed, 2 failed |
| `pnpm test:coverage` | same 2 failures, so the script exits 1. Re-run excluding `test/unit/doctor.test.ts`: thresholds pass. Combined lines 95.88%, branches 91.85%. `redactor.ts` lines 94.2% (same figure the PR quotes). |
| `pnpm test:e2e` | not run. This VM has no Docker socket. |

The two failures are `test/unit/doctor.test.ts`: `doctor --json` and `doctor --estimate 10` shell out to the CLI, which gets `connect ENOENT /var/run/docker.sock`. They do not import the code this review changed. On a machine with Docker they are unchanged.

History proofs that ran and passed, so the pre-fix code really does the bad thing:

- `test/unit/leak-corpus.test.ts` — each pre-fix redactor still emits its corpus leak (`d13f1e7`, `5d6f36a`, `cf684c1`, `5723644`, `6184a74`, `bed382d`).
- `test/unit/secret-type.test.ts` — the `5723644` store saves the password `abc`. The `539d310` length helper rejects the username `bob`, which `Secret` accepts.
- `test/unit/attacker-page.test.ts` — the `5723644` proxy forwards a token-bearing abort and the runner records it. Today's proxy and relay refuse it.
- `test/unit/lint-rules.test.ts` — `secure-fs-only` flags the parents of `d0043ee`, `294967a`, `f05f31f`, and `bdb438b`. Today's files are clean.
- `test/unit/runner-isolation.test.ts` — `a19653a^` has no token file; `6184a74^` mounts the whole token directory.
- `test/unit/evidence-claims.test.ts` — summaries before `6184a74` and `c8963cf` overclaim, and the finding shapes from `6fd08df`, `d391eab`, `6550f54`, and `722e1a0` are refused.

The lint proof for sealed artifacts is weaker than the others. It rewrites the old `job.ts` import to `writePrivateFile` and then expects the import itself to be banned. That shows the rule fires on the import, which is what the rule does. The behavioral leak proofs are the leak corpus, not this lint case.

## Fixed on this branch

### High — runner symlinks were followed into saved files

`copyPrivateFile` called `readFileSync`, which follows links. `copyPrivateTree` skips a link it sees in `readdir`, then later reads by path, so a swap between the two calls was followed. `acceptBaseline` and the evidence zip used the same read. The comment in `copyPrivateTree` says a runner link must never be followed.

Fixed: `readRegularFile` (`packages/core/src/secure-fs.ts:173`) opens with `O_NOFOLLOW | O_NONBLOCK` and requires a regular file. `copyPrivateFile`, the artifact readers, and page-text reads use it. A link named as the source is not copied (`test/unit/secure-fs.test.ts`).

### Medium — a short username could be stored as a password

`Secret.field` was a public instance property, and `setSecrets` stored `secret.reveal()`. Either could be replaced on the object: assign `field` from `username` to `password` on a 3-character username, or replace `reveal` with a shorter string. `Secret.parse` was not the only way a short password reached the store. The forged-object test only checked that something threw, and a missing `sops` made that true even when the value was accepted.

Fixed: the field and value live in a module-private record. `valueForField` (`packages/core/src/secret.ts:97`) is what `setSecrets` writes (`packages/controller/src/broker.ts:90`). Relabelling `.field` or replacing `reveal` does not change it. The test now checks that directly, with no `sops` involved.

### Medium — isolation on reuse missed mounts, extra networks, and the job path

`runnerIsolationProblems` required the one token file under `/tokens` and a source path ending in `docker.sock`. A reused container could also mount the token directory at `/host-tokens`, or mount `/var/run`, and still pass. `NetworkMode` is not updated when Docker attaches a second network, so a hand-added `bridge` was invisible. `startStoppedRunner` and `endpointFor` started or used that container with no check. `sameImage` treated a failed image inspect as a match (`wanted === ''`), which is the old fail-open, left in place beside the new check.

Fixed:

- Extra token-directory mounts and `/var/run` or `/run` are problems (`packages/controller/src/runner-isolation.ts:118`, `:182`).
- A second network on an inspect result is a problem (`runner-isolation.ts:127`).
- `env up` uses that inspect view (`packages/controller/src/env.ts:513`, `:561`). An unknown image id is not reused (`env.ts:559`).
- A job refuses a container that fails the check (`env.ts:125`, `suite.ts:716`) and `startStoppedRunner` will not start one (`env.ts:137`).

### Medium — evidence and writes trusted a loose parent or a link

`hasFile` used `existsSync`, which is true for a symlink to `/etc/passwd`. A finding could cite that path. Page text was read the same way, so a quote could be satisfied by the link target. `prepareParent` checked an existing private parent with a forbidden-bit mask of 0, so a folder that had been opened to the group or the world still received new 0600 files.

Fixed: evidence files must be regular files inside the run directory (`packages/controller/src/findings-report.ts:39`). An existing private parent must be owner-only (`secure-fs.ts:238`). `acceptBaseline` resolves the screenshot path and refuses `runDir/../../etc/hosts`, which still starts with `runDir/` (`packages/controller/src/suite.ts:888`, `isInside`). The old prefix test only rejected a path that did not start with the run directory.

### Low — two lint holes around the new rules

`import('node:fs')` was not an `ImportDeclaration` or `require`, so `secure-fs-only` allowed it. `writeRedactedFile(path, text as any)` is not a cast to `Redacted`, so `sealed-artifacts-only` allowed it, and `any` is assignable to `Redacted`.

Fixed in `eslint-rules/hornet-swarm-rules.js:118` and the dynamic-import handler. Both are in `test/unit/lint-rules.test.ts`.

## Left for the owner

### Medium — Linux runners cannot read the 0600 token

Confirmed from the image and the entrypoint, not re-run (no Docker here). `images/runner/entrypoint.sh` drops to uid 10001, gid 10010, then Node reads `AEGIS_CONTROL_TOKEN_FILE`. The file is a host bind mount, mode 0600, owned by the host user. Linux Docker keeps that uid. Docker Desktop and OrbStack present the file as readable inside the VM, which is why Mac end-to-end works and this VM's runners would not. Main mounts the file the same way; this PR's 0600 mode is what makes the Linux read fail where a 0644 file used to succeed. The out directory is 0700 as well, so artifact writes from uid 10001 fail on Linux for the same reason.

Feasible fix, without loosening the host file and without putting the token in the environment (`AEGIS_CONTROL_TOKEN=` is already refused):

1. In `entrypoint.sh`, as root, open the mounted token read-only before `setpriv`. Root on a normal Linux daemon can read a host 0600 file. `setpriv` keeps the fd.
2. Pass the number only, for example `AEGIS_CONTROL_TOKEN_FD`. That is not the secret, so the isolation check can allow that name and still forbid `AEGIS_CONTROL_TOKEN=`.
3. In the runner, if the fd is open, `pread` it from offset 0 on every request. `rewritePrivateFileInPlace` keeps the inode, so the fd sees a rotation. If the fd was not opened, keep reading the path, which is what Docker Desktop does today when the container user can see the file.

Do not `chmod` the host file to 0640 and `chgrp` it to 10010. The controller is not root, so it cannot change the group to a gid it is not in, and gid 10010 may be a real account on the host. This also does not help a daemon with user namespaces, where container root is an unprivileged host uid. That case needs a daemon setting.

### Low — CONNECT tunnels are not tagged

`openTunnel` (`packages/controller/src/egress-proxy.ts:108`) pipes bytes after the port check. The egress header is added only in `forwardHttp`. A CONNECT to a port other than 8899 does not carry `x-hornet-swarm-egress`, so the relay's header check does not see it. Port 8899 is refused for every host, and `relayReachableThrough` refuses an allow-list entry that can reach loopback on the published relay port. Those two checks are what actually hold. The header is a second layer for plain HTTP only.

### Low — screenshot OCR fails open

`ocrBuffer` (`packages/report/src/artifacts.ts:256`) returns `''` when tesseract errors. A PNG whose pixels show a password and whose bytes do not contain it is kept. Byte scans now run on the PNG as well, which catches a password stored as text in the file. A purely visual leak still depends on OCR succeeding.

### Low — a four-character quote and an all-skipped pass

A quote only has to be four characters and a substring of the saved page text (`packages/report/src/evidence-claims.ts:17`). `unsupportedPass` (`evidence-claims.ts:167`) accepts a pass whose every step is `skipped`. Both match the written rule. They are weak evidence, not a bypass of the checker.

### Low — other leftovers

- `privateDir` checks the final path. `mkdir` follows a symlink in an earlier component and creates the leaf inside the target. Refusing every symlink on the way to `~/.hornet-swarm` would also refuse a home whose `/home` itself is a link, so this was left.
- `as any` stored in a variable, then passed to `writeRedactedFile`, is not flagged. A direct `as any` argument is.
- `groupSharedDir` asks for mode 0770, and the process umask can turn that into 0750. The socket test masks out the group bits (`mode & 0o707`), so it does not lock group-write off. Inside the container the group is gid 10010 (`control`), shared by the runner user and the proxy user. The proxy already forwards the control request, including the bearer token. A group-writable socket directory would let it replace the socket; with a normal umask the directory is not group-writable.
- `rewritePrivateFileInPlace` truncates to zero before writing (`secure-fs.ts:139`). A crash in that window leaves an empty token. The runner then rejects every request, which is fail-closed. Writing the new bytes first and truncating to the new length would avoid the empty window.
- Hard links are not links to `lstat`. A runner cannot hard-link a file from outside the bind mount.

## Merge recommendation

Do not merge yet. The architecture (one sealed writer, one filesystem module, one runner spec, one `Secret` parser, nominal `VerifiedFinding`) is what should ship, and the proofs against the old commits are real. After the fixes above, I would approve the code and still block the merge on a green end-to-end run: Mac as the PR already requires, or Linux once the token fd handoff is in. The residuals in the last section are the owner's call; none of them by themselves is a reason to drop the branch.
