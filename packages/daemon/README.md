# @tmux-ide/daemon

Singleton background daemon for [tmux-ide](https://github.com/wavyrai/tmux-ide).

Provides an embeddable workspace registry, command-center HTTP/WebSocket API, and chat/codex orchestration. Used by the `tmux-ide` CLI and bundled by the native Mac app.

## Install

```bash
npm install @tmux-ide/daemon
```

## Embedded use

```ts
import { startEmbeddedDaemon } from "@tmux-ide/daemon";

const handle = await startEmbeddedDaemon({ port: 6060 });
// ...
await handle.stop();
```

## Installed CLI ownership

Native and desktop hosts should execute the installed root CLI with an argv
array, not import this private workspace package and not construct a shell
command:

```text
/resolved/path/to/tmux-ide  --headless
```

Resolve that executable from the installed root package and spawn it directly
with an argv array; do not use a shell, `&`, `nohup`, or another daemonizer. The
command is deliberately foreground and config-free. The spawned child itself is
the canonical daemon owner, so the host must retain its PID and use an existing
working directory. Redirecting stdio is fine; stdout is not the readiness
protocol.

Readiness is the owner-only `daemon.json`, a matching credential-free
`/identity` instance nonce, and a compatible `/health` response. Protocol and
instance identity are compatibility boundaries; `productVersion` is diagnostic
unless the protocol is incompatible. A process-lifetime atomic claim spans
inspection, bind, publication, and shutdown, so simultaneous cold-start losers
wait for and reuse exactly one winner. Publication is create-if-absent and
cleanup removes only the owning `instanceId`, never a concurrently replaced
record. A compatible live owner is reused, stale metadata for a proven-dead PID
is replaced, and an incompatible, malformed, insecure, or live-but-unhealthy
owner is rejected without takeover. IPv6 literals in probe URLs must be
bracketed.
`SIGINT`, `SIGTERM`, and the daemon shutdown action all await the same cleanup
path before the process exits.

See the user-facing [CLI reference](../../docs/content/docs/commands.mdx) for the
complete native handoff and lifecycle contract.

## Subpath exports

- `@tmux-ide/daemon` — embedded daemon entry, chat store, canonical-info helpers
- `@tmux-ide/daemon/contract` — action contract (re-export of `@tmux-ide/contracts`)
- `@tmux-ide/daemon/errors` — action error types
- `@tmux-ide/daemon/codex` — codex client + protocol

## License

MIT — see the repository root for the full license.
