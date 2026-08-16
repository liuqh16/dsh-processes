# Install and update notes

How to install dsh-processes into a dsh profile from its git repository, and
the operational quirks discovered while doing so. The plugin has two
packages (the host plugin `dsh-processes` and the browser dock
`dsh-processes-web`); both install the same way.

## Install

```sh
cd <deepseek-harness-checkout>
export DSH_HOME=/root/.dsh
pnpm dsh plugin --profile web add github:liuqh16/dsh-processes
pnpm dsh plugin --profile web add github:liuqh16/dsh-processes-web
```

First install on a fresh profile is refused once by pnpm's build-script
allowlist (the git-install `prepare` build). `dsh` prints the exact
`allowBuilds` key to add; put it under `allowBuilds` in the profile's
`pnpm-workspace.yaml`, then re-run the same command.

After installing the host plugin, add the browser plugin's loader row to the
profile patch so the client modules system discovers it:

```yaml
# /root/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: processes-web
      name: 'dsh-processes-web'
```

(The profile patch layer targets existing entries by id; a new row needs the
`insert:` list form, not a bare row — a bare row fails with
`entry "processes-web" not found`.)

## Update

```sh
cd <deepseek-harness-checkout>
export DSH_HOME=/root/.dsh
pnpm dsh plugin --profile web add github:liuqh16/dsh-processes
# restart the GUI process afterwards — host-side (server) plugins cannot hot-reload
pkill -f 'bin.ts web'; sleep 2
nohup node --import tsx/esm apps/cli/src/bin.ts web --port 8080 > /tmp/dsh-web.log 2>&1 &
```

Browser-only changes (the dock package) take effect without a restart: the
client modules system re-hashes the bundle and the browser reloads it.
Host-side changes (the process tool, notifications, projections) require the
restart above.

## Operational quirks

- **allowBuilds keys accumulate, they are never replaced.** Updating a git
  dependency adds a new commit hash and therefore a new key, but pnpm keeps
  rebuilding the old package during the transition, so the previous key must
  stay. Append the new key under the existing `allowBuilds` block; do not
  rewrite the block to only the new key.
- **pnpm rewrites pnpm-workspace.yaml itself** (for example appending entries
  to `minimumReleaseAgeExclude`). After editing the file by hand, re-read it
  before re-running pnpm so a pnpm-side rewrite did not clobber your edit or
  duplicate a block (a duplicated `allowBuilds:` key fails the install).
- **Script escaping**: in shell scripts that patch the yaml with an embedded
  Python heredoc, a literal backslash-n inside the replacement string becomes
  a real newline and breaks the intended single-line insert. Prefer
  `sed`/`awk` or double the backslash, then verify the file.
- **The GUI server and the HMR watcher are different processes.**
  `dev:web` (`scripts/dev-web.ts`) only rebuilds browser bundles; the
  Loader/composition lives in `bin.ts web`. Restart the latter for host-side
  changes.

## Verify an update

```sh
grep -c 'process/clear' /root/.dsh/profiles/web/node_modules/dsh-processes/lib/manager.js
# 1 = the dock-clear fix is installed (an older build prints 0)
```

Then start a short-lived process (process tool, `command: echo done`), wait
for the dock to show it as finished, and run `/ps-clear` — the row disappears.

