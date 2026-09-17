# Run independent development worktrees

Use `pnpm dev:instance` to run each worktree with its own daemon, tmux server,
state and immutable build. The same instance name in two worktrees selects two
different instances. Closing the app leaves its daemon and pane work running.

This workflow does not require a global installation. The production daemon,
durable development instances and disposable testdrive fixtures have separate
lifetimes. See the [architecture contract](../development-instances.md) for
ownership and recovery details.

## Prepare two worktrees

Use a supported macOS or Linux host, Git, the repository's pinned pnpm version,
and Bun matching `.bun-version`. Keep the same Node executable and ABI for
dependency installation, builds and instance commands. Native dependencies built
under another Node ABI must be rebuilt before use. Package engine support alone
does not qualify every native toolchain combination.

From an existing clone, choose unused paths and branch names:

```sh
git worktree add -b dev/instance-a ../tmux-ide-instance-a HEAD
git worktree add -b dev/instance-b ../tmux-ide-instance-b HEAD
```

Prepare the tmux source once outside your worktrees, using the commit recorded
in each candidate's `native/tmux/provenance.json`:

```sh
git clone https://github.com/tmux/tmux.git /absolute/path/to/pinned/tmux-checkout
git -C /absolute/path/to/pinned/tmux-checkout checkout --detach \
  "$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync("native/tmux/provenance.json", "utf8")).commit)')"
```

The checkout must match `native/tmux/provenance.json`.

Run the preparation below in **each** new worktree. Replace the two absolute
paths with your pinned Bun executable and tmux source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build:tmux --source /absolute/path/to/pinned/tmux-checkout
pnpm --silent dev:instance rebuild --name demo \
  --bun /absolute/path/to/pinned/bun --json
pnpm --silent dev:instance up --name demo --json
pnpm --silent dev:instance status --name demo --json
```

The native builder exports that commit into private staging, applies the checked-in patch and builds a
bundle for the current platform. It requires a C toolchain, autoconf/automake,
pkg-config and the platform's libevent, ncurses and utf8proc development
dependencies. It does not modify the source checkout or replace system tmux.
An ordinary system tmux binary is not a substitute for this patched bundle.

Compare the two status documents: instance IDs, worktree paths, daemon identities
and tmux sockets must differ. Each command selects the current worktree and name;
use the same `--name demo` throughout this example. The default private store is
`~/.local/state/tmux-ide-dev`. For an explicit store, supply the same absolute
`--store` path on every command.

## Open, inspect and update

In a terminal in either worktree:

```sh
pnpm dev:instance app --name demo
```

The app uses that instance's verified build. Open the other worktree's app in
another terminal to work on both branches concurrently. For bounded diagnostics:

```sh
pnpm --silent dev:instance status --name demo --json
pnpm --silent dev:instance logs --name demo --json
pnpm --silent dev:instance diagnostics --name demo --json
```

`logs` returns a structured snapshot; it is not a follow stream. Diagnostics
checks source freshness on demand. Editing source does not change running code.
After making changes:

```sh
pnpm --silent dev:instance rebuild --name demo --json
pnpm --silent dev:instance restart --name demo --apply-build --json
```

Later rebuilds can reuse the verified Bun path from the selected manifest.
Rebuild publishes artifacts without restarting anything. `restart --apply-build`
replaces the daemon with the selected build while preserving compatible tmux
pane work. Close and reopen the app to load rebuilt TUI code. Plain `restart`
resets the already loaded runtime; it does not load source edits.

If the tmux bundle changed, activation returns `tmux-restart-required`: stop the
whole instance with `down`, then run `up`. That stops its pane commands. A failed
daemon activation can leave the daemon stopped; inspect diagnostics before
deliberately choosing the recorded previous build:

```sh
pnpm --silent dev:instance restart --name demo --apply-build --previous --json
```

## Stop and reset

Close managed app clients before reset. Run in each worktree:

```sh
pnpm --silent dev:instance down --name demo --json
pnpm --silent dev:instance reset --name demo --yes --json
```

`down` stops the selected daemon and its private tmux server, including pane work,
but retains state and builds. `down --daemon-only` preserves tmux and pane work.
`reset --yes` requires the instance to be stopped and removes its verified state
and artifacts, retaining a small reset marker. Rebuild before starting a reset instance again. Neither command
cleans unrelated worktrees, production sessions or an entire shared store.

## Linux over SSH and clean installs

For a container-backed Linux daemon with a native local TUI, follow the
[Docker/SSH walkthrough](../../docker/development/README.md#initial-container-wrapper).
Export the source, build an immutable image explicitly, and pass its exact image
ID and matching source export to `up --container`. The wrapper does not mount
your worktree or rebuild an image implicitly. Use the same worktree, name and
store for its subsequent `app`, `shell`, `status`, `logs`, `down` and `reset`
commands. Container restart requires explicit `up --resume`; source changes
require a new matching image/export workflow.

Run expensive builds sequentially on small Docker VMs. Each native instance
adds a daemon and tmux server; every open app adds a TUI process. Pane commands
and build tools can dominate memory use. Docker tests do not qualify native
macOS rendering, clipboard or notifications. See the Docker guide for resource
limits and the separate SSH qualification cases.

Use the [packed installation qualification](../../scripts/pack-check-run.md)
to test published package behavior. A working source instance does not prove
clean installation, update or OS service behavior.

## Move from ad-hoc scripts

Replace manually assigned homes, ports and socket names with the worktree/name
selection above. Inherited `TMUX_IDE_HOME` does not select the development store;
use `--store`. Existing production and testdrive environment helpers keep their
own purpose. The manager does not import their settings, tokens or live state.

Existing ad-hoc directories are not automatically adopted. Keep them until their
own sessions have been stopped, then retire them with their original workflow.
Moving a worktree changes its identity; use `list --json` and the verified stored
`--id` to inspect or retire an orphan before removing its old checkout. Do not
copy ownership records or delete unknown state to bypass a refusal.

## CI qualification

See [isolated development CI](../../scripts/development-ci.md) for the fast
contract matrix, scoped installed-package checks, platform requirements, retained
evidence and cancellation limits. A local walkthrough and a CI workflow file are
separate from a successful run of that workflow.
