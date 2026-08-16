# dsh-processes

Manage long-running background processes from a DeepSeek Harness agent. A port of
[pi-processes](https://github.com/aliou/pi-processes) onto DSH's native
extension points: one `process` tool, the `/ps` command family, the process
manager over the `ctx.subprocess` seam, and exit/log-match notifications that
wake the owning agent.

Everything lives on public DSH plugin surfaces — no changes to the harness
sources. The plugin is a standalone npm package that mounts as a dsh bundle.

## Install

The package ships as a dsh bundle patch, so it installs through the dsh CLI
directly from its git repository (the `prepare` script builds `lib/` during
installation):

```sh
dsh plugin --profile <name> add github:liuqh16/dsh-processes
```

First install on a fresh profile may be refused by pnpm's build-script
allowlist (the git-install `prepare` build): `dsh` prints the exact
`allowBuilds` key to add under `allowBuilds` in the profile's
`pnpm-workspace.yaml`, after which the same command succeeds.

The bundle manifest (`cordis.patch.yml`) inserts the plugin into the target
profile's composition. The plugin declares the services it needs
(`tools`, `commands`, `subprocess`, `systemPrompt`) and fails at load when a
service is missing, so a composition that mounts it must also mount the local
subprocess runtime and the command runtime.

Peer dependencies: `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and the
`@deepseek-ai/dsh-*` packages listed in `package.json`.

## What the model gets

### The `process` tool

One tool with an `action` discriminator:

- `start` — run a shell command in the background; returns the process id.
- `list` — list processes with status, optional filters, sorting, and limit.
- `stop` — terminate a process tree and wait for actual exit.
- `output` — read captured output (per stream, filtered, tailed).
- `write` — send bytes to a running process's stdin (optionally EOF).
- `update` — change the log patterns that trigger notifications.
- `clear` — remove finished processes and free their retained output.

Processes started here keep running across the conversation (and across turns),
their output is captured and inspectable, and exit/log-match notifications
reach the agent. The prompt section mounted by the plugin tells the model to
prefer this over shell background tricks like `&` or `nohup`.

### Commands

- `/ps` — list processes with status and recent output previews.
- `/ps-kill <id>` — stop one process.
- `/ps-logs <id>` — show recent output of one process.
- `/ps-clear` — remove finished processes.

Command names follow DSH's `[a-z0-9_-]` grammar, so pi-processes' colon forms
map to hyphens (`/ps:kill` → `/ps-kill`).

### Notifications

A process can notify on exit (`onSuccess` / `onFailure` / `onKilled`) and on
log matches (`notify.logMatches`). Attention levels:

- `turn` — wake an idle agent via followup.
- `context` — reach an agent still working via inject.
- `ignore` — never notify (exit events are still logged).

The delivered text is logged as a standard `user/message`, so the
model-visible input is always reconstructable from the session log. Matchers
are one-shot by default (`repeat: false`).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `shellPath` | `bash` | Shell executable (bare name resolves through PATH). |
| `shellArgs` | `['-c']` | Shell arguments preceding the command. |
| `maxOutputBytes` | `65536` | Per-stream in-memory output cap; overflow keeps the tail. |
| `maxSpillBytes` | `67108864` | Per-stream spill-file cap; larger streams drop the spill. |
| `graceMs` | `3000` | SIGTERM → SIGKILL escalation grace. |
| `killTimeoutMs` | `10000` | How long `stop` waits for the tree to exit. |
| `pollIntervalMs` | `500` | Notification scan interval. |
| `maxProcesses` | `50` | Upper bound on managed processes; overflow starts fail loud. |

Numeric bounds the schema cannot express (positive finite values, grace within
the harness timer ceiling) are validated at load; the plugin refuses to run with
a misconfigured deployment.

## Session-log footprint

The plugin writes **no custom session events**. Everything the dock needs
rides the standard events the process tool already produces:

- `tool/call` + `tool/result` — the process tool's start/stop/clear results,
  whose `presentationMeta` carries the structured process facts the
  `processes` projection folds for the dock.
- `user/message` — notification text delivered to the agent (followup /
  inject), so the model-visible input stays reconstructable from the log.

Custom event types would be refused by any harness whose event allowlist
does not know them (and out-of-repo event registration is not yet available),
so the projection deliberately folds standard events instead.

## Development

The standalone repo typechecks and tests against a DeepSeek Harness checkout
(the path is configurable via `DSH_HARNESS` for the test config):

```sh
pnpm run typecheck   # tsc over src + tests (source plane via tsconfig paths)
pnpm run build       # emit lib/ (typecheck is the separate gate above)
pnpm test            # vitest: unit, tool, and REAL-composition suites
```

The REAL-composition suite mounts the plugin on the agent loop with the local
subprocess runtime and a scripted mock model, exercising tool calls, durable
events, and notification-driven wakeups through the same paths a live model
would.

## Web UI

The companion package [dsh-processes-web](https://github.com/liuqh16/dsh-processes-web)
mounts a process dock in the composer input bar: a running-count badge
expandable to the session's process list with status and the latest
notification text. The dock is fed by the `processes` session projection this
plugin folds from its `process/*` events, so no extra data channel is needed.
Mount both packages on a web profile:

```sh
dsh plugin --profile <name> add github:liuqh16/dsh-processes
dsh plugin --profile <name> add github:liuqh16/dsh-processes-web
```

## Known Limitations and Deferred Work

- The shell runs with `-c` (not pi-processes' `-lc`), so a login profile is
  not sourced; set `shellArgs` explicitly when a login environment is needed.
- Notifications with `attention: context` only reach an agent already working;
  a fully idle agent never sees them (by design, matching pi-processes).
- The Web dock shows the latest notification text, not a real-time output
  tail; full output streaming needs a host RPC channel and is deferred.
- Output retention is bounded per stream by `maxOutputBytes`/`maxSpillBytes`;
  very large logs are tailed or spilled, never fully retained.