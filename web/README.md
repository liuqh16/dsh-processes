# dsh-processes-web

Browser half of [dsh-processes](../README.md): the process dock in the
composer input bar, fed entirely by the `processes` session projection the
host plugin folds from its `process/*` events. The dock shows a running-count
badge and, when expanded, the session's process list with status and the
latest notification text.

## Install

The package is a dsh client plugin: its browser half is discovered through
the `dsh.client` declaration in `package.json` and loaded by the web app's
module system. Add both packages to the target profile's composition:

```yaml
# profile cordis.patch.yml
- insert:
    - id: processes
      name: 'dsh-processes'

    - id: processes-web
      name: 'dsh-processes-web'
      # host-side row: makes the package appear in the Loader; the browser
      # half is discovered through its dsh client declaration.
      config: {}
```

or install both through the dsh CLI:

```sh
dsh plugin --profile <name> add dsh-processes dsh-processes-web
```

The web row must be mounted on a profile that already composes
`@deepseek-ai/dsh-client-runtime`, `@deepseek-ai/dsh-client-locale`, and
`@deepseek-ai/dsh-client-ui-conversation` (the web-app bundle mounts these).

## Behavior

- No dock entry renders for sessions with no process activity.
- The badge shows the live process count; expanding the strip lists every
  started process with localized status, exit facts, and the latest
  notification text (the same text delivered to the agent).
- The projection updates whenever `process/start`, `process/exit`, or
  `process/notify` lands in the session log — the dock makes no RPC and holds
  no host-side browser state.

## Development

```sh
pnpm --dir web typecheck   # tsc over the browser sources
pnpm --dir web build       # esbuild bundle -> dist/client.js + lib declarations
```

The build emits the module-loader contract: a closure factory receiving the
injected module-table require, with react and the @deepseek-ai/dsh-client-*
platform modules resolved as externals.

## Known Limitations and Deferred Work

- The dock shows the latest notification text, not full captured output. A
  real-time output tail needs a host RPC channel (typert remote) and is a
  separate milestone.
- The bundle is built with a standalone esbuild script, not the harness
  tsdown client pipeline; CSS-module styling is intentionally avoided.
- Runtime verification requires mounting the packages in a dsh web profile.

