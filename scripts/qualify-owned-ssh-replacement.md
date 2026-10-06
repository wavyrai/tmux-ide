# Native SSH daemon replacement qualification

`qualify-owned-ssh-replacement.ts` is an opt-in macOS developer fixture. It builds
four isolated native development instances: two daemon targets and two separate
local TUI owners. The TUIs connect through private localhost SSH servers. No Docker
or globally installed tmux-ide executable participates.

Use the nonroot macOS, system SSH and compiler prerequisites described in
[the transport fixture](qualify-owned-ssh.md). Both source worktrees also need the
pinned Node/Bun toolchain, installed dependencies and qualified native tmux bundle
described in [development instances](../docs/development-instances.md). Use clean
source worktrees and record their exact commits. The manager checkout is separate
from those source worktrees; its commit must also be recorded.

Create a private evidence directory and put `descriptor.json` inside it. Replace
the absolute paths and commit labels below. The store must not exist. All four
tuples must use that store, have different instance identities and have no existing
runtime directory. The two worktrees can build the same source revision while
retaining separate worktree identities.

```json
{
  "version": 1,
  "managerRoot": "/absolute/manager-checkout",
  "managerCommit": "record-exact-manager-commit",
  "node": "/absolute/pinned-node",
  "bun": "/absolute/pinned-bun",
  "nativeSource": "record-exact-native-source-commit",
  "store": "/private/tmp/new-owned-ssh-store",
  "session": "d11-shared",
  "instances": [
    {
      "role": "target-a",
      "name": "d11-target-a",
      "worktree": "/absolute/source-a",
      "store": "/private/tmp/new-owned-ssh-store"
    },
    {
      "role": "target-b",
      "name": "d11-target-b",
      "worktree": "/absolute/source-b",
      "store": "/private/tmp/new-owned-ssh-store"
    },
    {
      "role": "client-a",
      "name": "d11-client-a",
      "worktree": "/absolute/source-a",
      "store": "/private/tmp/new-owned-ssh-store"
    },
    {
      "role": "client-b",
      "name": "d11-client-b",
      "worktree": "/absolute/source-b",
      "store": "/private/tmp/new-owned-ssh-store"
    }
  ]
}
```

Run from the manager checkout using its exact Node executable:

```sh
/absolute/pinned-node --import tsx scripts/qualify-owned-ssh-replacement.ts --run /absolute/evidence/descriptor.json
```

To exercise an npm-installed client, add an `installedClient` object containing
absolute `cli` and `tui` paths, their `cliSha256` and `tuiSha256` digests, and
`commit` matching `nativeSource`. Install the package tarball from a clean release
gate receipt and independently verify both files against that receipt first.
The runner checks the supplied digests before launch. It uses the supported
`TMUX_IDE_TUI_BIN` override for the unpublished candidate's verified TUI artifact.
It still builds four managed instances for isolated target infrastructure.

Installed clients run with short private homes, a seeded saved-machine profile,
a private bundled-tmux server and the fixture's SSH wrapper. The explicit socket
is created before launch because daemon admission requires an existing server.
Short state paths also keep the control socket within macOS path limits. Their renderer identities, manual sizing, terminal IO and
daemon replacement checks are the same as the development-client journey. The
receipt records installed artifact identity separately. Cleanup removes private
homes only after client and tracked-process teardown succeeds, the exact private
tmux server is retired, and no local daemon record or private tmux socket remains.
The server PID, kernel identity and socket inode are checked before retirement.
A remaining local daemon is a cleanup refusal to investigate, not permission to
discard its state. The installed mode also adds, disables, enables, removes and restores a second
saved host through the authenticated local registry API while the app stays open.
It checks persisted responses, background tunnel retirement/replacement, unchanged
selected-host and sibling-app tunnel identities, retained renderers and terminal
IO. These background-profile operations do not prove selected-profile removal,
route edits, duplicate-route presentation, remote installation or external hosts.

The runner selects actual terminal views, verifies encoded shell output and typed
input, then stops only A's daemon. It confirms the original SSH tunnel and forward
are still alive at daemon death. A wrong-identity HTTP listener occupies the old
daemon port. The replacement must have a new UUID, token and port while preserving
the original tmux server, socket and pane. The same TUI must recover fresh output
and keyboard input; B must remain responsive.

An independent, retained SSH forward proves that refreshing the fixture listener
does not kill existing forwards. Only a credential-free `/owned-witness` request
uses that raw forward. Application traffic and authenticated admission always use
the production transport endpoint. The receipt records raw and guarded witness
ports separately.

Listener refresh first checks that the SSH port is listening, then performs one
authenticated discovery attempt with the normal 15-second transport budget.
Discovery verifies immutable development artifacts and can exceed 1.5 seconds.
Temporary fixture lease transitions emit the existing structured `unavailable`
response; empty SSH stdout would incorrectly indicate an invalid descriptor.

`qualification.json` and terminal frames are written beside the descriptor. Trap
diagnostics contain bounded, fixed request classes, credential-presence flags and
old/replacement-token equality booleans. They never store token values, headers,
cookies or request paths. A null replacement-token comparison means the new token
was not known at observation time. Discovery timings distinguish producer work
from listener readiness. These instrumented durations are not latency benchmarks.

Exit status zero requires recovery, zero credential-bearing requests to the trap,
and successful cleanup. Teardown retires the TUIs and owned SSH processes, confirms
discovery producers have settled, then stops/resets the four managed instances.
Unconfirmed discovery cleanup protects the corresponding target artifacts from
reset. Preserve failed receipts and inspect every cleanup field before retrying;
do not use broad process kills or recursive deletion to conceal a refusal.

The corrected baseline with manager `7bb9139f` and native source `29e6f891` recovered
the retained TUI and preserved tmux identity, but failed the credential assertion:
23 trap requests carried the exact old owner token. All owned cleanup checks and
the independent 60-process/eight-port audit passed. Earlier fixture timeout,
listener-refresh and malformed-handshake failures remain separate evidence. This
baseline demonstrates the defect; it is not a passing qualification of its fix.

## Fixed-product qualification

A fresh bounded run passed with manager and all four native artifact sources at
clean `54542def`, using Node 26.8.2 and Bun 1.4.2 on macOS 27 arm64. Each immutable
manifest and CLI/TUI hash was independently verified before interpreting the
result. The retained TUI recovered fresh shell output and keyboard input with the
same tmux PID, socket inode and pane; the daemon UUID, token, port and SSH tunnel
changed. The healthy sibling stayed responsive during and after replacement.

The wrong-identity trap received exactly two requests: one public identity probe
and one independent raw-forward witness, both without credentials. No old or
replacement owner token reached it. The original TUI's SSH process and listener
were alive at daemon death; the separate retained raw witness survived fixture
listener refresh. Raw and guarded witness ports are recorded separately, and TUI
traffic stayed behind the production identity guard.

The run took 62,272ms including four builds, fixture work and teardown. Every
cleanup field passed. Independent checks found all 59 captured processes absent,
all nine recorded ports closed, four runtime/artifact roots retired through managed
reset, and an empty private SSH parent. Both source worktrees remained clean.
Exact manifests, frames, trap counters, cleanup audits and the unchanged original
receipt are under ignored local evidence
`plans/development-instances/evidence/d11/stage4/guarded-native-live`.

The baseline and earlier failed receipts are preserved separately. This is a
bounded accidental stale-endpoint credential and real recovery qualification,
not a long soak, native Linux/x64 proof, terminal-reader performance benchmark or
defense against a malicious listener copying the public identity. Generic paused
HTTP-reader and configured fleet-scheduler cases have separate receipts described
in [the transport qualification](qualify-owned-ssh.md).

The foundation candidate `8ec99ddb` passed again with four clean native source
instances on macOS arm64, Node 24.11.1 and Bun 1.4.2. The fixture now opens F2
Terminals and selects its plain shell session from the sidebar; Home's agent list
does not contain a shell without an agent. Terminal focus is checked before the
encoded output and input witnesses. The two earlier navigation failures are
retained with successful cleanup, separately from the passing recovery run.

The run took 103,710ms including builds and teardown. Both trap requests were
credential-free (one identity probe and one independent witness). All cleanup
fields passed; an independent audit found 64 captured PIDs absent and six checked
ports closed. The fixture source hash, clean native manifests, terminal frames and
cleanup audit are retained under ignored local evidence
`.tasks/sfora-foundation-mission/native-ssh-replacement-selected`. Its manager was
`8ec99ddb` with only the recorded fixture navigation patch; runtime artifacts came
from the clean worktrees. This proves native development-client recovery, not an
npm-installed remote journey, registry hot reload, remote manual sizing or a CPU
performance improvement.

## Remote manual sizing

The fixture also resizes the actual SSH client's PTY under explicit window-local
and inherited global `window-size manual` policies. It checks exact remote window
dimensions, repair to `latest`, fresh encoded output/input, preservation of an
unselected 90×25 manual window and pane PIDs, and a responsive second connection.
It restores the original geometry before replacing the daemon. Every IO witness
checks the exact compiled TUI executable's PID and kernel identity before and
after, so a surviving launcher cannot hide a renderer restart.

Four clean `826dfe6a` native artifacts passed this combined journey on macOS arm64
with Node 24.21.0/Bun 1.4.2. The selected remote window changed from 92×29 to 112×37
and 100×33 for the two policies, then returned to 92×29; its neighbour stayed
90×25/manual. Both native renderer identities survived the full journey. The run
took 109,754ms including builds and cleanup, with zero credential-bearing trap
requests. All cleanup fields passed; an independent audit found 66 captured PIDs
absent and six checked ports closed. Exact fixture source, native manifests,
frames and receipts are retained at
`.tasks/sfora-foundation-mission/native-ssh-manual-sizing-renderer`. The manager
was `826dfe6a` with the recorded fixture extension. This is a native localhost-SSH
proof, not an npm-installed remote client, DGX-host test or performance benchmark.

## Installed-client qualification

The clean `29aa9d31` release-gate npm tarball and verified compiled TUI passed this
journey on macOS arm64 with Node 24.21.0/Bun 1.4.2. The manager was `29aa9d31` with
the recorded fixture extension; all four development target artifacts came from
clean worktrees at that revision. Both installed clients used saved SSH profiles,
short private state homes and separately owned local tmux servers.

The retained installed renderer recovered output and input after remote daemon
replacement, both manual-sizing policies passed, the hidden window and pane
identities were preserved, and the sibling stayed responsive. The trap received
only a credential-free identity probe and the independent witness. Both clients
closed interactively with exit zero. The 100,413ms run includes setup and teardown;
it is not a latency benchmark. Every cleanup field passed. Independent checks
found 72 recorded PIDs absent, seven recorded ports closed and both private homes
and sockets removed; installed CLI/TUI hashes and fixture source remained stable.

Receipts are retained under ignored local evidence
`.tasks/sfora-foundation-mission/installed-ssh-replacement-socket-cleanup-29aa9d31`.
Earlier failed receipts remain separate: missing explicit local sockets delayed
startup, and a later behavior-passing run refused stale-socket cleanup. This is an
npm-installed client against owned localhost SSH targets. Saved-machine mutations,
external hosts, remote installation and runtime performance budgets remain outside
this proof.

## Live installed registry mutations

A further clean29aa installed-client run adds a second saved SSH host through the
local daemon's authenticated registry API after both apps are running. It then
disables, enables, removes and restores that background profile. Every response
matches the persisted registry and exact local daemon generation. Removed or
disabled routes lose their tunnel; restored routes obtain a new tunnel. The
selected host's tunnel and the second app's tunnel retain their exact identities,
both renderers survive, both terminals accept input and remote daemon/tmux/pane
fingerprints remain unchanged. Sizing passes before registry mutation; daemon replacement subsequently passes
with the mutated profiles still loaded.

The 114,829ms run and all cleanup fields passed. Independent checks found 94 PIDs
absent, ten ports closed and both installed homes/sockets removed. CLI/TUI hashes
and fixture source remained stable. Evidence is retained at
`.tasks/sfora-foundation-mission/installed-ssh-registry-live-add-29aa9d31`; the manager
was `7873adca` plus its recorded fixture extension, with unchanged clean29aa product
artifacts. A previous two-profile startup attempt exceeded the fixture producer's
six-second response bound and remains a separate failed receipt with clean
teardown. No product timeout or performance budget was changed.

This proves background-profile mutation in a running installed app. Selected-route
removal, route edits and duplicate-route presentation are additional scenarios;
this receipt does not establish those behaviors or external-host readiness.

## Selected-profile restoration and subsequent daemon replacement

The installed journey also disables and removes the selected profile, restores it
through the local API, reopens its sidebar session and verifies fresh terminal IO
in the same renderer. Background and sibling-app tunnels must retain their exact
identities. The subsequent daemon replacement exposed a navigation defect: a
retained session key/name was treated as the same selection after authority had
fallen back to Local. Reopening created a server-scoped route without its live
session identity, so later replacement could not requalify that session.

The same-selection shortcut now also requires the same selected machine. A focused
regression fails before this change; all 40 affected navigation, route and machine
ownership tests pass afterward, alongside typechecking and lint. Temporary route
tracing confirmed that replacement reached the observer but stopped before server
verification; that instrumentation is removed from runtime source.

The corrected TUI passed the complete journey in 124,305ms, including all seven
registry cases, manual sizing, retained-renderer replacement and credential
isolation. Every cleanup field passed. Independent checks found 110 PIDs absent,
14 ports closed and both private homes/sockets removed, with stable source and
artifact hashes. Evidence is at
`.tasks/sfora-foundation-mission/selected-route-fix-bounded-discovery`. This proof
uses the unchanged clean29aa installed CLI/native targets and a source-hashed
corrected TUI; it is not a clean single-candidate package/release qualification.

Two fixture corrections are independently recorded: visible frames must clip
headless backing rows to the current column count after shrink, and concurrent
native-artifact verification exceeded the fixture's six-second producer deadline.
This qualification selects a bounded ten-second producer timeout, below the
unchanged fifteen-second product SSH timeout. Other fixtures keep their existing
default. All 23 fixture tests pass. Earlier failed receipts remain separate.
