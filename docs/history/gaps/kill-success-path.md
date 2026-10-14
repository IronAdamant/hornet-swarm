# Kill when the job response still returns

Status: done. `applyReturnedJob` treats a kill file or a kill abort on the success path the same as the catch path: it stops the project runners and returns `killed: true` with `blocked_reason: kill`. `test/unit/kill-success.test.ts` covers it.

## What the source does

`engageKill` writes `~/.hornet-swarm/KILL`. The CLI `kill` command and MCP `reset_environment` with `kill: true` write that file and stop the project's runner containers. MCP checks `release` first. When both `release` and `kill` are set, the call releases the switch and returns before the stop.

During a job, a 400ms timer in `execute` posts `/v1/abort` and aborts the fetch when the kill file appears. The `catch` path stops every runner for the project and returns `blocked_reason: kill` with `killed: true`.

The success path is different. After the fetch returns, a duration abort replaces the report and stops that label. A kill abort is handled only inside the `catch`. If the abort does not reject the fetch, `execute` returns the runner's own report with `killed: false` and does not stop runners from that function. The CLI or MCP kill command may already have stopped them. A kill that is only the file, noticed by the timer, can miss that stop when the response still arrives.

A duration stop does not write the kill file.

## Amendment I would make

On the success path, if the abort reason is `kill` or the kill file exists, do the same work as the catch path: stop the project runners, and return `blocked_reason: kill` with `killed: true`. Do not treat that response as a normal runner report.

Keep the duration path as it is: one label, `killed: false`, no kill file.
