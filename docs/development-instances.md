# Development-instance architecture contract

Status: **namespace, isolated builds, lifecycle, diagnostics, and explicit build activation implemented** (D02–D07). This document also records the remaining design contract for
[Isolated Worktree Development and Remote Fixtures](https://www.sfora.ai/org/wavyr/notes/mx7agc0d3fqgmy35jfds23vexx8egvm3).
The command table includes planned later operations; only the commands explicitly
listed in the implementation sections below exist today. Existing `test`,
`smoke`, `testdrive` and `performance` fixtures remain ephemeral.

## Identity and lifetime

An instance belongs to one canonical Git worktree root and one optional name.
Resolve the root with Git, then `realpath`; directory aliases and symlinked entry
paths select the same instance. A linked worktree is distinct from its main
checkout even when both share a Git common directory. Commands outside a valid
worktree fail unless selecting a previously recorded instance for status or
cleanup. Never infer identity from the current branch.

Use `dev-` plus the first 24 hexadecimal characters of SHA-256 over the UTF-8
encoding of `JSON.stringify(["tmux-ide-development-v1", canonicalRoot, name])`.
The default name is the empty string. Explicit `--name` accepts case-sensitive
ASCII `[A-Za-z0-9][A-Za-z0-9_.-]{0,47}`; no trimming, case folding or slug aliases.
The same name in different worktrees is safe; repeated selection of the same
root/name means the same instance. Persist the full digest and identity tuple;
a truncated-ID collision or mismatched tuple is an error, never reuse.
Branch, HEAD and dirty status are display/build metadata. Changing branches does
not change the instance or silently start another daemon.

The durable owner record also captures Git worktree metadata location and the
root's filesystem identity. Reusing the same pathname for a different checkout
must fail closed rather than adopting old live state. A changed filesystem
identity requires an explicit retired-instance decision, not automatic cleanup.
Moving a worktree creates a new path identity; old state remains an orphan and
is never automatically migrated, copied or killed. Missing trees may still have
live processes. `status --id` and `down/reset --id` can address a verified stored
record without the source tree. Future listing may enumerate these records, but
names and directory guesses are not ownership evidence. No move/alias migration
command is required for the first implementation.

Extend `RuntimeMode` with **`development`**, `isolated: true`,
`persistence: "durable"`. Stable `namespaceId` is the instance ID, not a cleanup
token. Keep a randomly generated private ownership capability in the instance
record, distinct from the daemon's changing `daemonInstanceId`, bearer token,
process incarnation and tmux socket identity. Reuse the existing cleanup-token
field as a capability where appropriate; do not interpret development as a
successful test run whose directory should be deleted on exit. Existing fixture
mode/token semantics stay compatible.

## Paths and authority bundle

Use a dedicated development store outside `~/.tmux-ide`, initially
`~/.local/state/tmux-ide-dev` on both macOS and Linux. An explicit manager-store
option may select another absolute private root, subject to the same checks;
inherited `TMUX_IDE_HOME` is not a manager-store selector. A custom store is an
explicit separate installation of development state: record it in status and do
not search other stores when selection fails.

For instance `I`, the proposed layout is:

```text
<store>/instances/I/instance.json     identity, capability, schema; private
<store>/instances/I/state/            durable application state
<store>/instances/I/logs/             bounded owner/stdout/stderr and diagnostics
<store>/instances/I/artifacts/G/      immutable successful build generation
<store>/instances/I/build.json        atomic selected-build manifest pointer
<store>/instances/I/locks/            lifecycle/build admission, owned records
/tmp/ti-dev-<uid>/I/                  short transient socket directory
  tmux.sock
  control.sock
```

Resolve `/tmp` to its real platform path (including macOS `/private/tmp`) before
recording it. Require the final UTF-8 socket path to fit a conservative 100-byte
budget; reject an incompatible root rather than silently switch socket or server.
Verify each managed directory is owned by the effective user, private (0700),
not a symlink, and still the observed directory before mutations. Files carrying
state/capabilities are 0600; explicitly executable artifacts can be owner-only 0700. Reject foreign owners of managed paths and path/symlink escapes.
Allow system-owned sticky temporary ancestors such as `/tmp` or `/private/tmp`;
the `ti-dev-<uid>` and instance descendants must themselves be user-owned 0700,
not shared or symlinked. Other writable shared ancestors are rejected.
Use the existing pinned-descriptor and socket-identity helpers for race-sensitive
operations. Paths are not capabilities by themselves; this isolates accidental
cross-instance actions, not hostile processes running as the same Unix user.

`RuntimeNamespace` remains the one process-local authority. Extend it with an
explicit runtime directory and resolved config/settings/integration destinations
rather than giving the wrapper a second set of independent defaults. In development,
registry and daemon publication live under `state/`; control and tmux sockets live
under the short runtime root. Named tmux socket selection remains supported for
existing fixtures; development uses an explicit absolute socket path. The
namespace validates all members together and rejects partial/conflicting bundles,
canonical paths, sibling-instance paths and unknown modes **before any I/O to
application defaults**. No fallback to canonical state, default socket or installed
binaries after invalid isolation.

## State and artifact inventory

Paths below describe existing consumers and the required development destination.
Links are source authorities, not a claim that all consumers are isolated today.

| Consumer / existing source                                                                                                                                                                                                                                                                                                                                                         | Development destination or rule                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`runtime-namespace.ts`](../packages/daemon/src/lib/runtime-namespace.ts), [`state-home.ts`](../packages/daemon/src/lib/state-home.ts)                                                                                                                                                                                                                                             | Resolve one bundle; existing isolated modes currently all mean ephemeral and `namespaceId = cleanupToken`. Add durable development explicitly.                                                                                                                                                                                                                                |
| [`canonical-daemon.ts`](../packages/daemon/src/lib/canonical-daemon.ts): `daemon.json`, `daemon.claim/owner.json`, bearer token in record                                                                                                                                                                                                                                          | `state/`; reuse secure inspection/preparation/election and expected-generation ownership. No second daemon locator.                                                                                                                                                                                                                                                           |
| [`project-registry.ts`](../packages/daemon/src/lib/project-registry.ts), [`workspace-registry.ts`](../packages/daemon/src/lib/workspace-registry.ts), [`saved-machines.ts`](../packages/daemon/src/lib/saved-machines.ts), [`fleet-client-state.ts`](../packages/daemon/src/lib/fleet-client-state.ts)                                                                             | `state/projects.json`, `workspaces.json`, `machines.json`, `fleet-view.json`; initially empty, no production import/discovery. Remote connection requires explicitly saved development configuration.                                                                                                                                                                         |
| [`app-config.ts`](../packages/daemon/src/lib/app-config.ts), [`app-settings.ts`](../packages/daemon/src/lib/app-settings.ts)                                                                                                                                                                                                                                                       | `state/config.json`, `state/app-settings.json`; currently each defaults to `homedir()` independently of namespace. Override validation belongs in the common resolver, not just the launcher.                                                                                                                                                                                 |
| [`project-runtime-repository.ts`](../packages/daemon/src/lib/project-runtime-repository.ts), mission repository                                                                                                                                                                                                                                                                    | `state/projects/<identity>/`, including documents, event streams, recovery audit and writer locks. Project source/config files remain in the worktree; runtime persistence must not escape there.                                                                                                                                                                             |
| [`terminals-store.ts`](../packages/daemon/src/lib/terminals-store.ts)                                                                                                                                                                                                                                                                                                              | Currently writes `.tmux-ide/terminals.json` beneath a caller-provided project directory. Development must map this runtime metadata into the instance project store; two names in one worktree must not share terminal receipts. Source/config editing remains an intentional project operation.                                                                              |
| [`auth/auth-service.ts`](../packages/daemon/src/lib/auth/auth-service.ts), remote access and templates                                                                                                                                                                                                                                                                             | Remote auth can read host `.ssh/authorized_keys`; development starts loopback/local-owner only. Remote/auth fixtures must supply private identity/trust roots before enabling remote access. User template overrides must be explicitly scoped or rejected; packaged templates are immutable artifact inputs.                                                                 |
| [`environment-identity.ts`](../packages/daemon/src/lib/environment-identity.ts), [`onboarding-marker.ts`](../packages/daemon/src/lib/onboarding-marker.ts), app state, welcome/offer/notify state                                                                                                                                                                                  | `state/` (`environment.json`, `onboarding.json`, `app-state.json`, welcome/integration markers, `notify-state.json`); no canonical history reuse.                                                                                                                                                                                                                             |
| [`control/server.ts`](../packages/daemon/src/control/server.ts), [`tui/chrome/events.ts`](../packages/daemon/src/tui/chrome/events.ts), [`lib/log.ts`](../packages/daemon/src/lib/log.ts)                                                                                                                                                                                          | Short `control.sock`; namespace `events.jsonl` and its rotation; wrapper captures owner output in bounded `logs/`. Logger's in-memory ring/SSE is not a substitute for process logs. Trace/profiling destinations also must be owned by this instance.                                                                                                                        |
| [`update-check.ts`](../packages/daemon/src/lib/update-check.ts), [`tui-binary.ts`](../packages/daemon/src/lib/tui-binary.ts)                                                                                                                                                                                                                                                       | Channel cache files under `state/` if explicitly tested; automatic update checking/installing and downloaded-binary fallback disabled in development.                                                                                                                                                                                                                         |
| [`widget-asset-store.ts`](../packages/daemon/src/lib/widget-asset-store.ts), rich-preview assets, detector manifest overrides                                                                                                                                                                                                                                                      | Namespace state/cache only, preserving existing retention limits; no shared mutable asset directory.                                                                                                                                                                                                                                                                          |
| [`tui/team/keymap.ts`](../packages/daemon/src/tui/team/keymap.ts), [`tui/chrome/snapshot.ts`](../packages/daemon/src/tui/chrome/snapshot.ts)                                                                                                                                                                                                                                       | Legacy `team-keys.json`/`snapshot.json` homedir paths must be routed if reachable; a legacy dispatcher is not an isolation exemption.                                                                                                                                                                                                                                         |
| [`skill-sync.ts`](../packages/daemon/src/lib/skill-sync.ts), [`tui/integrations/claude.ts`](../packages/daemon/src/tui/integrations/claude.ts), [`opencode.ts`](../packages/daemon/src/tui/integrations/opencode.ts), [`scripts/postinstall.js`](../scripts/postinstall.js)                                                                                                        | Disable automatic integration/skill sync and prompts; explicit integration fixtures use `state/integrations/`. Claude hook script currently ignores the settings override and uses homedir. Postinstall has its own homedir logic and global-daemon update path; it must recognize development or be omitted by fixture install policy. No host hooks/settings modifications. |
| [`tui/detect/session-id.ts`](../packages/daemon/src/tui/detect/session-id.ts)                                                                                                                                                                                                                                                                                                      | Codex sessions/Cursor chats roots must use fixture-owned roots or be disabled; do not silently scan personal agent history. Native developer shells may still invoke user tools explicitly.                                                                                                                                                                                   |
| [`workspace-pane-creation.ts`](../packages/daemon/src/lib/workspace-pane-creation.ts), [`bundled-tmux.ts`](../packages/daemon/src/lib/bundled-tmux.ts), tmux bridge                                                                                                                                                                                                                | Pin executable and explicit private socket for a generation; validate socket identity on operations. Current resolver gives inherited `TMUX` precedence, which development must reject or verify against its own authority.                                                                                                                                                   |
| [`tui/compiled.ts`](../packages/daemon/src/tui/compiled.ts), [`tui/mirror/hosted.ts`](../packages/daemon/src/tui/mirror/hosted.ts)                                                                                                                                                                                                                                                 | Exact manifest-selected executable; config-free compiled cwd under instance runtime state. Current `compiledTuiRuntimeDir()` uses homedir, and binary discovery probes relative/downloaded candidates. Neither is a development fallback. Child-host launches carry the whole namespace.                                                                                      |
| [`build-cli.mjs`](../scripts/build-cli.mjs), [`build-tui.mjs`](../scripts/build-tui.mjs)                                                                                                                                                                                                                                                                                           | CLI currently writes tracked `bin/cli.js`; TUI defaults to `packages/daemon/dist/tui/` with `--outfile` support. D03 must direct staging outputs outside source and atomically publish a complete artifact generation.                                                                                                                                                        |
| Native builders: [`build-bundled-tmux.mjs`](../scripts/build-bundled-tmux.mjs), [`build-macos-notifier.mjs`](../scripts/build-macos-notifier.mjs), [`native/build-opentui-scroll.mjs`](../scripts/native/build-opentui-scroll.mjs), [`build-xterm-native-parser.mjs`](../scripts/build-xterm-native-parser.mjs), [`build-terminal-fnv64.mjs`](../scripts/build-terminal-fnv64.mjs) | Inventory tmux+libraries, notifier, OpenTUI library, parser package/WASM and generated source. Normal instance rebuild consumes pinned assets; it must not silently regenerate tracked parser/FNV sources or mutate a shared dependency checkout. Native rebuilds use owned staging and manifest hashes.                                                                      |
| Package `dist/`, frontend outputs, `.turbo`, dependency links and test artifacts                                                                                                                                                                                                                                                                                                   | Mutable outputs belong to one worktree/build owner; two named instances in one tree must not race shared `dist/`. Share only immutable/content-addressed cache entries. Test receipts/screenshots/traces get per-run directories and explicit cleanup ownership. Tests keep ephemeral namespace lifetimes.                                                                    |

Native development retains the real `HOME` and ordinary shell environment so
shells can use developer tools. It is **not a filesystem or credential sandbox**.
Application-owned defaults and automatic integrations must therefore be fixed at
their consumers, not hidden by changing HOME alone. Explicit tests of installers
or agent integrations use a private HOME/XDG root as existing product fixtures do.
Default development disables desktop notifications, auto-updates, integration
installation and automatic remote connections. Real remote credentials are an
explicit developer choice, never copied into status or fixtures by default.

## Launch and ownership

The manager resolves identity from its requested worktree, validates one complete
bundle and constructs child environment from a known policy. Remove inherited
`TMUX`, `TMUX_PANE`, conflicting socket selectors, daemon/registry/settings/config
paths, cleanup tokens, CLI/TUI executable overrides and testdrive/performance
capabilities; then apply the selected instance values. Do not merge competing
namespace fields. Preserve normal PATH/locale/terminal variables, but resolve
required tools once to absolute paths and record them. `TMUX_IDE_CWD` identifies
the actual project, separate from compiled runtime cwd. Any additional application
path override requires explicit validation; unsupported authority overrides fail.

Launching from inside production or a sibling TUI selects the requested worktree
instance, not the inherited daemon or socket. Inside a verified same-instance
pane, tmux's own `TMUX` may be present; consumers must verify it matches the pinned
socket or use the namespace authority. The manager entry always clears it. Never
strip the namespace from children that can reach daemon/state/tmux operations.

Create a private tmux server with explicit socket and config policy (`-f /dev/null`
for the initial server), not the user's tmux configuration and hooks. Record its
incarnation/socket identity. A small owned keeper/fixture session can keep this
server alive until `down`; expose it in status rather than hiding ownership in a
user session. Daemon listener chooses a free loopback port, publishes through
existing canonical election, and is verified with authenticated identity/health.
No fixed shared port; remote access defaults off.

One instance lifecycle lock serializes `up`, stop, restart, reset and artifact
activation. Build staging uses a separate build lock; publication briefly takes
the lifecycle lock in the documented order build → lifecycle. Lifecycle code must
never wait for the build lock while holding lifecycle. Reset refuses a live build
or waits boundedly outside lifecycle. Lock records identify owner/incarnation;
unknown/live competing owners are protected. Reuse canonical claim election for
the daemon, not a wrapper PID file as replacement authority. Startup/cancellation
cleanup removes only resources this invocation can prove it created, never a
winner of a concurrent `up`.

## Build contract

D03 publishes a versioned manifest with instance identity, canonical source root,
Git commit, exact dirty-source digest, package and lockfile hashes, execution mode,
absolute CLI/TUI/tool/native paths and their hashes, platform/architecture,
Node/Bun versions and native ABI/provenance. Include relevant untracked build
inputs; exclude generated artifacts, logs and dependency caches. A dirty boolean
or version string alone is not a build identity. Record source changes during a
build and reject an inconsistent snapshot rather than claiming exact provenance.
On macOS, native artifact qualification must verify usable code signatures and
execute a bounded launch smoke test before publication. Where a local ad-hoc
signature is required, signing is a declared build step on the owned candidate;
hash the final signed bytes. A build-success exit alone does not prove the binary
can launch (invalid signatures can produce SIGKILL). Record signing mode and
verification evidence in the manifest; do not alter installed/user binaries.
The currently pinned release Bun is 1.4.2; implementation reads the repository's
pin and reports unsupported local toolchains rather than assuming PATH Bun is it.

A generation contains or pins all needed external dependencies (including node-pty, better-sqlite3 and watcher bindings), native libraries,
worker/WASM/parser/query assets and config-free runtime requirements; a CLI that
still resolves mutable sibling `node_modules` is not an immutable self-contained
artifact. Distinguish source/development execution from packaged-artifact
qualification in status. Reuse existing builders and provenance checks, adding
output parameters/staging where needed. Never install globally or download a TUI
as recovery. Verify the full candidate before atomically replacing `build.json`;
failed builds preserve the previous runnable generation. Retain artifacts used by
live owners. Source edits do not revoke verified immutable generations: `app/up`
may continue using the recorded build. Explicit diagnostics computes source
freshness on demand; launch and status do not hash source automatically. Rebuild
publishes a new selection, and explicit activation replaces an owner. Already
running owners are reported, not silently replaced.

## Worktree-local manager launcher

`pnpm dev:instance` uses a small stock-Node bootstrap. On a cache miss it compiles
only the manager in a short-lived child using the shared CLI bundle/purity policy;
warm commands retain neither TSX nor the compiler. This cache never rebuilds or
activates daemon/TUI artifacts: `rebuild` and `restart --apply-build` remain explicit.

Each invocation hashes the bounded worktree source/config inventory, lockfiles,
Node/platform identity, compiler bytes and package resolution links. The compiler
checks its discovered input closure before and after the publication build. A
changed source, configuration, compiler or workspace link cannot silently select
old manager code. Bundled source inputs must belong to the tracked scripts/package-source/config inventory; tsconfig
inheritance outside the tracked scripts/package-source/root-config inventory
fails with an actionable error. No installed manager or stale bundle is a fallback.
This manager freshness check is separate from on-demand daemon/TUI build freshness.

Cache data lives in the private owned `node_modules/.cache/tmux-ide-manager` folder.
Publication uses complete staging directories and atomic rename; the launcher
verifies and hardlinks selected bytes before importing them in its own process.
Pruning retains two cached generations, with at most 32 live/unverified execution
pins and four admitted compiler stages. Each file is capped at 32 MiB and hashed
input bytes at 256 MiB. Pins preserve code through concurrent cache pruning. Normal
exit releases the current pin; only proven-dead PID leftovers are reclaimed.
Live/unknown entries protect their files and can cause a bounded capacity refusal.
An interrupted compiler forwards SIGINT/SIGTERM and preserves exit 130/143.

Use `pnpm --silent dev:instance ... --json` for machine-readable stdout. Compilation
errors remain on stderr; bootstrap failures emit a distinct safe structured error.
Manager argument and lifecycle errors retain their existing behavior. The first
command after an input change costs a compilation; warm launches still perform
bounded synchronous validation. This change targets development-wrapper memory,
not production TUI frame throughput.

## Proposed command semantics

All commands accept `--name`; lifecycle/status may accept a verified `--id` for an
orphan, mutually exclusive with source-derived selection. JSON contains safe
identity, paths, selected/running build IDs, owner generation/PID, socket/port,
readiness and log locations, never tokens or raw environment. Errors are bounded
and distinguish missing build, stale build, invalid namespace, competing owner,
startup timeout and unsupported platform. No command exists merely by this table.

| Proposed command                          | Contract                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:instance up`                    | Require verified current build; create/reuse owned server and daemon. Concurrent calls converge through claims. Repeat returns current owner; build mismatch is explicit, never automatic replacement. Bounded readiness and failed-start receipt.                                                                                                                        |
| `pnpm dev:instance app`                   | Ensure `up`, then launch manifest-selected TUI against that owner. Multiple clients allowed. Closing TUI leaves durable instance running; no installed/source/download fallback.                                                                                                                                                                                          |
| `pnpm dev:instance status --json`         | Read-only inspection and bounded authenticated readiness. No build, session creation, repair or startup. Report missing/stopped/orphan/stale/blocked distinctly; health is liveness and admission readiness is scoped separately.                                                                                                                                         |
| `pnpm dev:instance logs`                  | Bounded support-safe structured snapshot (D06). Follow/cancellation remains planned. No token/environment dump.                                                                                                                                                                                                                                                           |
| `pnpm dev:instance rebuild`               | Stage and publish verified artifacts only. Does not restart daemon, pane commands or TUI. Running/selected builds may differ and status says so.                                                                                                                                                                                                                          |
| `pnpm dev:instance restart`               | Existing owner-authorized, instance-fenced same-version generation reset. Preserve tmux panes, remote configuration and supervising PID; verify replacement. Does not load newly built code. Missing owner is an error; use `up`.                                                                                                                                         |
| `pnpm dev:instance restart --apply-build` | D07: replace the managed daemon process with the exact selected published build, retaining the verified tmux server and pane work. Authenticate/fence the old owner, wait boundedly for exit, launch the manifest entry through existing election, verify new build and generation, then reconnect clients explicitly. Never reuse H04 runtime reset as code replacement. |
| `pnpm dev:instance down --daemon-only`    | Authenticated owner shutdown only; preserve tmux and state. Later `up` may start selected code against the existing verified server.                                                                                                                                                                                                                                      |
| `pnpm dev:instance down`                  | Explicitly stop entire instance: daemon plus verified private tmux server and its pane work. Preserve durable state/artifacts/logs. Repeated down is harmless. No process-name kills or PID-only proof.                                                                                                                                                                   |
| `pnpm dev:instance reset --yes`           | Require stopped, verified instance with no live/unknown owner or build. Delete only that instance's state/artifacts/logs/runtime and record; never stop running work implicitly or delete a broad store root. New up creates fresh capability/state after rebuilding.                                                                                                     |

New-code activation is deliberately separate from same-version restart. D07 implements
`rebuild` followed by `restart --apply-build`; code activation never falls back
to same-process runtime reset. The instance lifecycle
owner, not an arbitrary detached replacement, owns this transition. Preserve a
replacement receipt and the prior artifact on failure; report stopped/failed
truthfully rather than claiming the new build is running. Existing clients must
verify the new daemon/build identity and reconnect; old clients cannot silently
keep presenting an old artifact as the selected build. TUI executable replacement
requires an explicit client relaunch, while tmux pane commands continue unchanged.

## Migration and qualification

Production defaults remain compatible. D02 centralizes currently divergent
consumers without importing production settings, catalogs or credentials into
development. Existing testdrive/public product environment helpers remain the
fixtures' source of launch policy; reuse their clean-environment and exact-entry
patterns, not their ephemeral cleanup as a durable supervisor:
[`tui-testdrive-launch.mjs`](../scripts/lib/tui-testdrive-launch.mjs),
[`product-configless-owner.mjs`](../scripts/lib/product-configless-owner.mjs).
Existing private test namespaces need no on-disk migration. An unsupported
namespace/manifest version fails with a targeted instruction, not best-effort
canonical fallback. Pre-existing ad hoc development directories are not adopted
without an explicit future migration operation.

D02 proves disjoint path bundles and inherited-environment rejection. D03 proves
exact manifests, concurrent builds and failed-build retention. D04/D05 prove
concurrent startup, restart/stop/reset ownership and orphan behavior. Before
calling native instances usable, D08 must exercise worktrees A/B plus a disposable
production-shaped sentinel, identical session names, long/space paths, aliases,
invalid bundles, PID reuse and interrupted operations. Test macOS/Linux separately;
unsupported platforms stay explicit. Docker/SSH/service fixtures extend this
contract later; neither a container nor this native namespace is evidence of
hostile-code containment or measured performance improvement.

## D03 build API (implemented)

`pnpm exec tsx scripts/development-build.ts --bun /absolute/path/to/bun
[--worktree /absolute/tree] [--store /absolute/private/store] [--name name]`
produces a JSON manifest. Bun must match `.bun-version`; CI and release builds
use that same file. Prepare frozen dependencies and a qualified host native tmux
bundle in that worktree first. This command neither installs dependencies nor
fetches a native bundle. It does not start an instance or implement `dev:instance`.

The manager hashes Git-visible relevant inputs, including untracked source,
records HEAD, dirty status, lockfile, package versions, selected Node ABI and Bun
identity, and checks source consistency again before publication. It builds CLI
and TUI into a private staging directory. The CLI's resolved external package
closure is copied with generation-local links, retaining native dependencies;
templates, skill and qualified native tmux assets are copied alongside it. It
verifies a native PTY, CLI startup, compiled TUI provenance and macOS code signing.
The entire generation payload, including root dependency links, is hashed before
an atomic `build.json` replacement. No worktree `bin/cli.js` or TUI output is
replaced. Compiler/store caches are inputs; runtime dependencies are private
snapshots. Existing prepared native bundles are hash-validated inputs; this stage
does not rebuild tmux from C sources.

Build and publication locks use private directories and random owner tokens.
Admission waits at most 30 seconds; unknown locks are never deleted by PID guess.
Individual compiler/qualification subprocesses have a five-minute deadline and
are killed on cancellation (the direct owned process, not arbitrary detached
descendants). Source/dependency copy budgets cap files and bytes.
Failed builds remove only their own staging generation and leave the last good
pointer and artifacts intact. Interrupted-process stale-lock recovery and old
artifact collection belong to the managed lifecycle stages.

Runtime selection verifies the instance tuple, host, payload and selected Node
executable. The compiler Bun path/hash is provenance, not a runtime dependency;
the compiled TUI embeds Bun. Child launch pins carry both generation and manifest
hash, so rebuilding does not redirect an already selected generation. Source
edits alone do not revoke the last good build. A changed/missing Node executable
requires rebuilding; external system libraries remain host prerequisites.
Missing manifests, sibling paths, changed artifacts or incompatible hosts fail
without installed/source/download fallback. Legacy UI commands that invoke an
unqualified global CLI and automatic detached daemon bootstrap remain explicitly
disabled in development until the managed lifecycle supplies exact launches.

A local macOS arm64 qualification measured a full cold selection at about 217 ms
and process RSS rising from 88 to 96 MiB, with one reusable 64 KiB hash buffer.
These are local verification costs, not a startup or rendering speedup claim.
Selection performs full verification; callers should reuse the verified launch
or daemon authority at their existing construction boundary, not reverify on a
rendering tick.

## D04 managed lifecycle (implemented)

From the selected worktree, first build its exact artifacts with the D03 command
above. Then:

```sh
pnpm dev:instance up
pnpm dev:instance app
pnpm --silent dev:instance status --json
```

All three accept `--name <label>`, `--store <absolute-private-directory>` and
`--worktree <path>`. `app` is interactive and rejects `--json`; `up` and `status`
produce credential-free JSON. Use `pnpm --silent` when piping that JSON.
A build made before the managed-owner capability was added must be rebuilt;
there is no fallback to an installed CLI or source runtime.

`up` serializes lifecycle admission and starts one detached, exact-build Node
owner plus an explicitly socket-selected tmux server using `-f /dev/null`. The
private `tmux-ide-dev-keeper` session keeps the server alive. Repeated/concurrent
`up` reuses a ready owner. A new selected build does not replace a running owner:
`status` reports both generations, and `app` pins the active owner's TUI. Closing
an app leaves the owner and tmux work running. Runtime UUID and canonical claim
may change during an authenticated runtime restart; process incarnation and the
launch receipt continue to identify the same supervised process.

Admission checks worktree filesystem identity, private records, exact artifacts,
process incarnation and tmux socket identity. Readiness checks canonical record
and claim, matching identity/health versions and owner-authenticated passive
admission data. Health alone is not whole-daemon readiness. Status performs no
repair or startup; missing builds, stopped owners, transitions and blocked
ownership are distinct. Existing live or unknown owners are protected. `up` may
reclaim a dead server's leftover socket only when its recorded identity still
matches exactly. An unrecorded or replaced socket stays blocked.

The lifecycle lock waits at most 30 seconds; startup readiness defaults to 15
seconds after spawn, with bounded individual probes. Build verification and
filesystem work precede that readiness deadline. Startup failure writes a
redacted `startup-receipt.json`; `logs/owner.log` is a best-effort rotating 1 MiB
log with a 64 KiB / 128-entry pending limit and bounded drop notices. Private
`tmux-startup.json` preserves partial-start evidence. Single-use launch receipts
prevent replay from overwriting an existing owner. D05 prunes consumed receipts only after stopped admission is revoked; old
artifacts remain until explicit reset or a future garbage-collection stage.

The D05 operations below extend this lifecycle. D06 implements a bounded `logs`
snapshot. D07 adds the public `rebuild` and `restart --apply-build` operations below.
Do not use broad process-name or socket-directory cleanup to emulate lifecycle operations. The opt-in two-worktree qualification harness performs
only authenticated, process-incarnation/socket-fenced cleanup of its explicitly
supplied scratch instances. Linux qualification remains separate from the macOS
acceptance evidence; this stage does not claim equivalent testing on both hosts.

## D05 owned lifecycle and orphan management (implemented)

```sh
pnpm dev:instance restart                  # Same loaded runtime; preserves pane work
pnpm dev:instance down --daemon-only       # Preserve tmux and pane processes
pnpm dev:instance down                     # Stop daemon and the verified private tmux server
pnpm dev:instance reset --yes              # Only after daemon, tmux and managed apps stop
pnpm dev:instance list --json              # Explicit store inventory; no process discovery
pnpm dev:instance status --id dev-<id> --json
pnpm dev:instance down --id dev-<id>
pnpm dev:instance reset --id dev-<id> --yes
```

Use the complete ID returned by `list` or `status`, not the literal placeholder.
`--id` is supported by status/restart/down/reset and cannot combine with
`--name`/`--worktree`. It reconstructs paths only from a private validated stored
identity, so a removed/moved worktree remains inspectable and cleanable. Listing
is bounded to 256 directory entries and marks unverifiable records blocked;
it does not adopt directory names as authority. `worktreeState` distinguishes
present, missing and changed source identity. Cleanup never removes the source
tree, including a different checkout now occupying its old pathname.

Restart uses the current owner credential and runtime UUID fence, then verifies
a new UUID in the same process/incarnation and active build. It does not load
newly built code; D07 `--apply-build` is the separate code-replacement operation. Stops are idempotent.
Full stop uses the exact recorded tmux socket, executable, process incarnation
and server capability; the destructive tmux command also checks server PID and
capability on its own connection. Daemon-only stop preserves those pane/server
identities. Both stop modes may leave an app displaying a disconnected state;
neither mode implicitly kills app processes.

Supported `dev:instance app` launches now publish a private admission receipt
under the lifecycle lock before spawning, then record the child's process
incarnation. Reset refuses live, reused-PID or unknown app ownership. Closing the
app releases its receipt only after verified exit; a later reset can prune
proven-dead receipts if its launcher died. An interrupted pre-spawn/null-PID
receipt deliberately blocks reset because a child may have escaped publication.
There is no process-name search or guess-based recovery for that case. Apps
launched before D05 or directly outside this manager have no receipt: close those
legacy clients before reset. They are outside the supported admission guarantee.

Reset holds the existing **build → lifecycle** locks through all removal. It
removes only this instance's stopped state, artifacts, logs and verified runtime
paths. Unknown runtime entries block removal. The instance root, `locks/`
scaffold and a private `reset.json` identity receipt remain, so queued D04/D05
commands share mutual exclusion and repeated `--id` reset remains verifiable.
The reset receipt is not active launch admission: a later `up` creates a fresh
identity/capability after a new build. Reset never implicitly stops active work.

Complete locks are published from private candidate directories. A complete
lock or recovery-marker owner is retired only after its PID is proven dead,
with captured inode/token checks; a reused/live/unknown PID is protected even
when its recorded incarnation differs. Lock waits remain bounded at 30 seconds.
Incomplete legacy lock directories, unrecorded sockets, and incomplete app
admission remain blocked rather than being declared stale from their age.
Candidate/retired evidence from an interrupted recovery may remain on disk;
no broad directory cleanup is performed. Startup now records the spawned daemon's
exact process incarnation before readiness, allowing explicit down to recover
an interrupted but verified launch. Consumed launch receipts are pruned only
after stopping the owner and revoking the current startup admission.

Qualification uses the same session name in three private namespaces (own,
sibling, and production-shaped test sentinel). It compares actual daemon/tmux/
pane PIDs and socket inodes through restart, both stop modes and orphan reset,
and exercises reset with a real open app. These are macOS arm64 results; Linux
execution remains a separate qualification gate.

Lifecycle JSON failures contain a manager-authored `operation` and allowlisted
`reason` (for example `confirmation-required`, `app-live`, `owner-unverified`,
`lock-unavailable`, `activation-failed`, or `tmux-restart-required`). Stored-ID selection failures
also remain JSON with `identity-unavailable`. They never forward arbitrary raw
exceptions or credentials. A startup receipt path is included only when that
`up` operation wrote it; reset/down/restart refusals do not point at stale startup
receipts. Invalid CLI syntax/option combinations may still fail at argument parsing.

The short runtime path keeps the worktree/name identity, but now has a private
atomic ownership receipt binding that full tuple, canonical store/root and
runtime capability. Up, app admission, stop and reset verify it before touching
runtime contents. Different stores for the same tuple cannot share that path,
even after a daemon/tmux stop: only the owning store's explicit reset releases
it. Unmarked nonempty legacy directories stay blocked; no automatic adoption is
inferred from a launcher PID or missing socket. Test fixture legacy cleanup used
prior verified process-exit receipts and removed only an observed empty compiled
cwd, never arbitrary user runtime contents.

The ownership receipt is published through a complete temporary inode and an
exclusive hard link. A concurrent read during the short two-link publication
window may fail closed until the temporary link is removed; same-store mutations
are serialized by the lifecycle lock. If another store claims immediately after
reset releases ownership, the final empty-directory removal can fail with
`ENOTEMPTY`; the new owner's receipt/content is preserved and the old reset must
not force removal. These are conservative retries, not ownership adoption.

Lock candidate publication protects observed incomplete legacy directories.
POSIX rename is not a general no-replace primitive for empty directories: in a
mixed D04/D05 pre-admission race, one writer may fail before entering its action.
D04's exclusive `owner.json` creation and D05's complete nonempty candidate keep
the protected actions mutually exclusive. No stronger guarantee about replacing
an unobserved empty legacy directory is claimed.

## Development identity and support diagnostics (D06)

The shared application header shows `DEV [name:]short-id`; `*` means the running
artifact was built with a dirty worktree. The marker is captured from the
manager's validated launch environment once when chrome mounts. Rendering does
not run Git, hash files, poll source freshness, or install diagnostic sinks.
Names are reduced to bounded printable ASCII for terminal presentation; the
full identity remains in the explicit command output.

```sh
pnpm --silent dev:instance diagnostics --json
pnpm --silent dev:instance logs --json
# Both also accept --name/--worktree/--store, or verified stored --id.
```

`diagnostics` takes an on-demand source snapshot and reports the branch (null
for detached HEAD or unavailable branch), current dirty state, selected build,
running daemon's active build and runtime UUID. `dirtyAtBuild` is historical;
`sourceStale` compares relevant source content now with each build digest. Null
freshness means source could not be read, never “up to date.” Publishing a build
does not change an existing daemon or TUI. TUI launch receipts report their own
artifact generations separately and deliberately make no liveness claim.
Versions describe the verified artifact manifest (CLI/TUI/daemon, Node ABI,
embedded Bun and native asset hashes). The separate `manager` fields identify
the inspecting process's Node version/ABI, Bun (if any), platform and architecture.
Build and lifecycle commands must select a compatible manager Node ABI through
a consistent PATH. For example, prefix PATH with the recorded Node executable's
bin directory for both `pnpm exec tsx scripts/development-build.ts ...` and
`pnpm dev:instance app`. A login shell and an inherited PTY environment can select
different Node installations. ABI checks remain strict; a mismatch while
verifying the pinned tmux build can currently surface as `tmux-owner-invalid`,
which does not by itself prove the tmux server was replaced.

Connection failure copy diagnostics retain allowlisted code/reason, operation
ID, the actual attempted daemon runtime generation when known, and the
launch-time TUI build generation in development. An unavailable generation is
omitted rather than inferred from whichever build is currently selected.

`logs` is a support-safe structured projection, **not a raw owner.log tail**.
It reads at most 64 KiB, discards incomplete boundary fragments, keeps at most
128 complete JSON records, and reports skipped records and truncation. Only
validated timestamp/severity, fixed component/error vocabulary and UUID-shaped
operation/runtime identifiers are eligible. Free-form messages, arbitrary data,
unknown components, credentials and unstructured lines are omitted. The private
`logs/owner.log` remains available for deliberate local inspection and is not
included in support output. Empty projections do not imply no activity.

These commands do not enumerate environment/configuration, mutate readiness,
create workspaces, or enable performance tracing. Existing owner logging keeps
its asynchronous bounded queue and 1 MiB disk rotation; a failed or slow disk
sink cannot stall terminal input. Source hashing runs in the explicit manager
command, with its existing source size budget and a cancellation deadline.

## Explicit rebuild and build activation (D07)

```sh
pnpm --silent dev:instance rebuild --bun /absolute/path/to/pinned/bun --json
pnpm --silent dev:instance restart --apply-build --json
# After a failed replacement, deliberately select the last recorded ready build:
pnpm --silent dev:instance restart --apply-build --previous --json
```

Use `--silent` when parsing pnpm-wrapped JSON; the manager emits one document but
pnpm's ordinary script banner is separate output. The first rebuild requires
`--bun`; later rebuilds may reuse the compiler path in the selected manifest.
That path is still checked against `.bun-version`. Keep the manager Node ABI and
PATH consistent with the qualified build as described above.

Rebuild stages/qualifies/publishes an immutable generation. Its receipt compares
actual CLI, TUI, dependency and native asset hashes against the previously
selected build and reports the selected and active daemon pins separately.
It does not restart any process. No file watcher triggers activation.

`restart --apply-build` validates source identity, namespace, selected artifact,
prior owner and existing tmux authority before stopping. One lifecycle lock
serializes retirement and startup; build publication uses build→lifecycle order.
The replacement launches the exact pinned Node/CLI generation through canonical
claim/authenticated readiness. Existing local clients rediscover the descriptor,
reconnect and retain their own TUI code. Close and reopen each app to load a new
TUI generation. Descriptor publication may briefly precede readiness: an observed
replacement with absent discovery or an explicit pre-promotion daemon/routing
unavailability (without an operation ID or error code) receives at most eight retries with
250 ms–2 s delays (about 12 seconds total). Disposal, offline authority or a newer
generation cancels the old retry. Typed promotion refusals and coded transport
failures are not retried;
recovery beyond this window requires an explicit reopen. Plain `restart` remains
the same-process runtime reset.

An existing tmux server keeps its original generation/executable provenance.
If its tmux bundle differs from the candidate, activation refuses with
`tmux-restart-required`; explicit full `down` then `up` is required and stops pane
work. Compatible daemon replacement preserves the server, socket and pane PIDs.

Private `activation.json` and public status/diagnostics retain operation ID,
transition phase, exact target and previous verified ready build pins, runtime
UUIDs/PIDs and tmux generation. A failed activation can leave the daemon stopped;
it never reports automatic rollback. `--previous` verifies and explicitly
activates the prior ready pin recorded by the transition, including recovery
from a stopped failed attempt. It does not rewrite build publication. If the
prior artifact, source identity, runtime lease or native toolchain cannot be
verified, recovery refuses. Unknown or reused process owners remain protected.

Build failures leave published artifacts and running processes untouched. The
public allowlisted failure points to private `build-receipt.json` with phase and
operation ID; `logs/build.log` retains bounded compiler details (64 KiB disk and
queue limits). It is private, may contain compiler source/error text, and is
excluded from support `logs`/`diagnostics` exports. Diagnostic sink failure never
changes a failed build into success. A subsequent failed build replaces the
receipt; immutable successful manifests remain the generation receipts.

## Native isolation release gate (D08)

The opt-in gate uses two **disposable detached worktrees** with existing qualified,
intentionally different CLI builds and a private development store. Its second
canonical worktree path must be at least 100 characters. It creates its own
production-shaped sentinel (private HOME/state, explicit test namespace and tmux
socket); it never uses the user's installed daemon as a test target.

```sh
pnpm test:development-isolation-unit
pnpm --silent test:development-isolation /absolute/disposable/a /absolute/long/disposable/b /absolute/private-store --yes-owned-fixtures
```

Run from the repository with the same qualified manager Node PATH used for the
artifacts. This gate deliberately crashes its owned daemon, creates/removes a
fixture branch, moves/restores worktree A, and resets A's development instance,
including its artifacts. It refuses a branch-attached A worktree. Retain or rebuild
fixtures intentionally; do not pass a development instance you need to keep.

Three namespaces use identical `shared` session names. Actual native TUIs render
their own DEV identity and echo input; protected daemon/tmux/pane processes,
socket inodes and machine files must survive every other-instance lifecycle step.
Competing inherited environment points at the private sentinel. Concurrent up,
branch/alias/long paths, crash recovery, runtime restart, daemon-only/full down,
live-app reset refusal, reused-PID protection, dead-lock recovery and orphan reset
are recorded in `<store>/d08-qualification.json`, including cleanup outcomes.

Every checkpoint bounds the observed owned process tree to 40 processes,
512 numeric file descriptors per process and 2048 total descriptors. Explicit
root incarnations must remain stable across sampling. macOS uses bounded `lsof`;
Linux uses `/proc`. Short-lived children that exit between snapshots are reported
as omitted, never silently counted as a missing root. Counts are observations,
not peaks or memory/performance guarantees. Three rounds of four real log SSE
subscriptions must cancel and return the daemon FD count to within 8 of baseline.
This is a gate-owned transport subscription count, **not** an internal daemon
listener census. Existing bounded-queue unit tests cover internal cleanup.

The macOS native checkpoint is qualified independently. Linux arm64 source and
packed image lanes now exist; see [owned Linux fixtures](../docker/development/README.md).
The source lane completed native builds and real TUI input in two worktrees. The
separate packed lane passed configless doctor and installed native TUI input with
verified process cleanup, without Bun or source dependencies. Its standalone TUI
is explicitly staged; package postinstall, release download and upgrade flows
remain separate D12 qualification.

The uninstrumented Linux arm64 D08 gate now passes all 15 phases with the smaller
worktree-local manager: concurrent owners, real TUI crash-recovery output/input,
runtime restart, daemon-only stop, dead-lock recovery, full stop, and moved-tree
reset while preserving the sibling and private production-shaped sentinel. The
run sampled at most 26 owned processes and 308 file descriptors, ended with zero
gate subscriptions and all tracked processes/apps gone, and recorded no new OOM
kills. This is a bounded qualification run, not a long-soak or throughput claim.

Earlier crash-recovery and final-down failures remain retained evidence. The
intermittent final-down rejection was not reproduced in 27 bounded diagnostic
shutdowns; its cause is not claimed fixed. No substitute system-tmux manifest,
installed TUI fallback, relaxed ownership check, increased production deadline or
global Docker memory change was used. Linux x64 and emulated performance remain
unqualified.
