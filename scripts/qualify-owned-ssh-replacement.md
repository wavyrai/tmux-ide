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
