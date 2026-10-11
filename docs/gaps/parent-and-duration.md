# Local parent and one run

Status: open. No code change in this note.

## What the source does

`run_signin_check`, `run_journey`, and `run_suite` are stdio MCP tools. They require `agent_id`. On success the tool result includes the parent packet from `publishParent`. The packet is also written to `projects/<id>/latest-parent-report.json`.

The instruction on that packet tells the parent Grok Build session or Grok Bot to read it and tell the owner the outcome. The harness does not start either parent, and it does not grade the site's AI replies. That string in `packages/controller/src/suite.ts` is the only `Grok Bot` mention in the product TypeScript.

A Grok Bot routine that runs on xAI's side can keep going while this Mac is asleep. It cannot attach to the stdio server or to Docker on this Mac during that sleep. A local Grok Build session or a local Bot process can be the parent while the Mac stays awake and that process stays up.

CLI `suite`, `sign-in`, and `journey` each call `runSuite` once and exit. Nothing schedules a follow-up. The schema default for `max_run_duration_min` is 30. Past that deadline an in-flight job is aborted, only that label's runner is stopped, and the parent status is `duration` unless redaction failed.

`foldRunStatus` does not turn a failed or rate-limited run into `blocked` just because the deadline also fired. The order is `failed`, then `rate_limited`, then `blocked`.

`endpointFor` starts a container that exists and is stopped. A missing container throws `No healthy runner for <label>` with exit 4. The suite does not create one. `env up` is the step that creates runners.

One agent id holds one label. The lease heartbeat runs inside the suite process. SIGTERM releases the lease. SIGKILL does not. The TTL stays 30 minutes.

## Amendment I would make

Do not add a daemon, a cron job, or a second Grok Bot client.

Add `max_run_duration_min` and the deadline time to the parent packet. A local Bot on a long task can then see the cap that stopped it. The Bot calls `run_suite` again when it wants another run. Raising the cap stays an edit to the project file. The default stays 30.

Leave runner creation on `env up`. The error string can name that command. The suite still must not create a missing container.

## Left with the owner

Docker is already up before the long task. The parent is a local process that stays running until the tool returns. A cloud Bot routine is not that parent.
