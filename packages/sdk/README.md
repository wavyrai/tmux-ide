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

Non-desktop runtimes use the daemon-only factory instead of fabricating window,
theme, update, or onboarding capabilities:

```ts
import { createTmuxIdeDaemonSdk } from "@tmux-ide/sdk";

const daemon = createTmuxIdeDaemonSdk(myDaemonHostAdapter);
const workspaces = await daemon.listWorkspaces();
```

Owner automation can deliver privacy-safe pane input with a stable operation
ID. When the caller is itself a workspace pane, include its semantic identity;
the daemon publishes the relationship only after validating both pane stamps
against live tmux state:

```ts
import { createTmuxIdeOwnerSdk } from "@tmux-ide/sdk";

const owner = createTmuxIdeOwnerSdk({ baseUrl, ownerToken });
await owner.sendPane({
  workspaceName: "product",
  sourceSemanticPaneId: "pane.editor",
  semanticPaneId: "pane.tests",
  text: "Run the focused suite",
  submit: true,
});
```

Receipts never contain `text`. Authored sends expose the verified relationship
as `pane.editor → pane.tests`; raw external `tmux send-keys` remains source-less
and is presented as `External input → pane.tests`.

The SDK exposes the complete reviewed host capability surface. Named methods
validate requests while preserving each UI's semantic projection boundary; the
generic `daemon.request()` path additionally validates responses for automation
and integration tests. Bootstrap state and pushed events are always validated.
`createTmuxIdeDaemonSdk()` is the portable core used by TUI, browser, automation,
and test adapters; `createTmuxIdeSdk()` adds the real desktop-only capabilities.
Neither exposes an arbitrary HTTP, shell, IPC, or tmux-command escape hatch.
It also contains no canvas implementation or external canvas SDK; renderer and
layout concerns stay outside this host/daemon capability facade.
