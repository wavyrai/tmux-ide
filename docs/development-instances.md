# Development-instance architecture contract

Status: **design contract, not implemented commands**. This document defines D01 of
[Isolated Worktree Development and Remote Fixtures](https://www.sfora.ai/org/wavyr/notes/mx7agc0d3fqgmy35jfds23vexx8egvm3).
D02–D05 implement the namespace, build selection and native lifecycle. Existing
`test`, `smoke`, `testdrive` and `performance` fixtures remain ephemeral. Do not
run the proposed commands below expecting isolation until their implementation
and multi-instance qualification land.

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
live owners. A changed source digest makes status stale; `app/up` must refuse a
stale selected build with a rebuild instruction unless an explicit recorded-build
selection is added later. Already running owners are reported, not silently replaced.

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
| `pnpm dev:instance logs`                  | Read/follow only the instance's bounded logs, with cancellation. No token/environment dump.                                                                                                                                                                                                                                                                               |
| `pnpm dev:instance rebuild`               | Stage and publish verified artifacts only. Does not restart daemon, pane commands or TUI. Running/selected builds may differ and status says so.                                                                                                                                                                                                                          |
| `pnpm dev:instance restart`               | Existing owner-authorized, instance-fenced same-version generation reset. Preserve tmux panes, remote configuration and supervising PID; verify replacement. Does not load newly built code. Missing owner is an error; use `up`.                                                                                                                                         |
| `pnpm dev:instance restart --apply-build` | D07: replace the managed daemon process with the exact selected published build, retaining the verified tmux server and pane work. Authenticate/fence the old owner, wait boundedly for exit, launch the manifest entry through existing election, verify new build and generation, then reconnect clients explicitly. Never reuse H04 runtime reset as code replacement. |
| `pnpm dev:instance down --daemon-only`    | Authenticated owner shutdown only; preserve tmux and state. Later `up` may start selected code against the existing verified server.                                                                                                                                                                                                                                      |
| `pnpm dev:instance down`                  | Explicitly stop entire instance: daemon plus verified private tmux server and its pane work. Preserve durable state/artifacts/logs. Repeated down is harmless. No process-name kills or PID-only proof.                                                                                                                                                                   |
| `pnpm dev:instance reset --yes`           | Require stopped, verified instance with no live/unknown owner or build. Delete only that instance's state/artifacts/logs/runtime and record; never stop running work implicitly or delete a broad store root. New up creates fresh capability/state after rebuilding.                                                                                                     |

New-code activation is deliberately separate from same-version restart. D07 implements
`rebuild` followed by `restart --apply-build`; until then the latter reports an
unsupported operation, never falls back to runtime reset. The instance lifecycle
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

## D03 build API (implemented; lifecycle commands remain planned)

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
