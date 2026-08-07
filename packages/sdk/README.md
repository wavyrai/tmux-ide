# `@tmux-ide/sdk`

The host-neutral, renderer-safe tmux-ide client.

```ts
import { createTmuxIdeSdk } from "@tmux-ide/sdk";

const tmuxIde = createTmuxIdeSdk(window.tmuxIdeHost);
const bootstrap = await tmuxIde.bootstrap();
const workspaces = await tmuxIde.daemon.listWorkspaces();

// Generic and fully typed, useful for automation and contract tests.
const readiness = await tmuxIde.daemon.request({ resource: "startupReadiness" });
```

The SDK exposes the complete reviewed host capability surface. Named methods
validate requests while preserving each UI's semantic projection boundary; the
generic `daemon.request()` path additionally validates responses for automation
and integration tests. Bootstrap state and pushed events are always validated.
It does not expose an arbitrary HTTP, shell, IPC, or tmux-command escape hatch.
