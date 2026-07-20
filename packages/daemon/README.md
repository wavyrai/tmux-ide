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

The command is deliberately foreground and config-free. The child it creates
is the canonical daemon owner; readiness is the published `daemon.json` plus a
successful `/health` probe. A compatible live owner is reused, stale metadata
is replaced, and an incompatible wire protocol is rejected without takeover.
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
