# Fleet client integration contract

Execution cards F01–F11: [Sfora design](https://www.sfora.ai/org/wavyr/notes/mx72n2ekkdz9xaz218v94k9xe58e5fpe).

One daemon owns each environment's ordinary tmux sessions. Each client connects
independently; losing the computer that first configured a fleet cannot terminate
another computer's sessions. No daemon mesh or remote proxy tmux sessions.

## Identity and ownership

| Identity                               | Purpose                                     | Must not substitute for            |
| -------------------------------------- | ------------------------------------------- | ---------------------------------- |
| Saved machine UUID                     | Editable access route and local preferences | Authenticated environment identity |
| Verified environment ID                | Join routes to the same daemon state home   | Credentials or current generation  |
| Instance ID, startedAt, endpoint epoch | Fence all asynchronous live operations      | Durable navigation identity        |
| V3 liveSessionId scoped to environment | Session incarnation, stable over rename     | Name-derived fleet mutation ID     |

Missing environment IDs remain independent routes. Conflicting live generations
remain separate until resolved. Cached metadata never supplies live authority.
Every operation resolves the current route and target, captures its generation,
and revalidates before dispatch and application of results. A selected-machine
change retires old input synchronously. Ambiguous mutations/input are not replayed.

## Package boundary

- `daemon-client`: transport-neutral scheduling, retry supervision, resource
  replicas, identity joins, navigation models. No process, filesystem or Solid.
- `contracts`: versioned public schemas and additive capabilities. Existing wire
  version 2 and beta 15 consumers remain supported unless explicitly negotiated.
- `core`: pure registry/preference reducers.
- `daemon/src/lib`: SSH, private descriptor handling, persistent registry owner.
- `daemon/src/tui/mirror`: OpenTUI views and host wiring.
- Browser renderer/hosting implementation remains owned by the web workstream.
  It can consume the same pure models through its own adapter. It never imports
  OpenSSH or reads credential-bearing descriptors from a view model.

## Connection slice

Use the existing runtime supervisor for both initial and subsequent failures.
Only the SSH authority owner retries; the machine manager must not recreate it
on initial failure. An initial readiness result settles after the first attempt,
while that same owner may continue reconnecting. Local startup bypasses dialing.

A manager owns a cancellable four-slot handshake scheduler. Selection promotes
queued work, without interrupting live connections. A cancelled adapter that
ignores abort retains its occupied slot until it settles; its late result is
disposed. There is no unbounded oversubscription hidden behind cancellation.

The SSH adapter opts into jittered retries capped at thirty seconds; shared web
supervisor defaults are unchanged. Retirement removes descriptors/input authority
before retry delay. Never manage remote processes through local daemon files/PIDs.

## Validation boundary

F02 requires deterministic limits, priority, abort, late completion, initial
failure/recovery, same-daemon new tunnel and generation-fence tests. Broader WAN,
two-seat, release and performance qualification belongs to F09. Do not claim those
results from unit tests. The user supplied SSH target `mini`; inspect its version
and handshake before considering isolated test setup or explicit upgrades.
