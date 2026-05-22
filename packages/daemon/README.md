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

## Subpath exports

- `@tmux-ide/daemon` — embedded daemon entry, chat store, canonical-info helpers
- `@tmux-ide/daemon/contract` — action contract (re-export of `@tmux-ide/contracts`)
- `@tmux-ide/daemon/errors` — action error types
- `@tmux-ide/daemon/codex` — codex client + protocol

## License

MIT — see the repository root for the full license.
