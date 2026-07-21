# Electron shell

This package is the thin operating-system host for the browser-native desktop
renderer. It owns single-instance behavior, secure window creation, physical
window-bounds persistence, native dialogs/theme events, and bounded startup and
shutdown. It does not render product UI or start tmux terminals.

The preload exposes the finite, versioned `HostCapabilities` contract. There is
no generic IPC, command, eval, or raw send escape hatch. Renderer processes run
with context isolation and sandboxing enabled, Node integration disabled, and
navigation, popups, webviews, and permission requests denied.

The daemon integration is deliberately an injected preflight seam. The default
reports `deferred`; canonical daemon startup remains owned by its future card.

Useful commands:

```bash
pnpm --filter @tmux-ide/electron-shell dev
pnpm --filter @tmux-ide/electron-shell smoke
pnpm --filter @tmux-ide/electron-shell package:smoke
```

The package command creates a local smoke-capable bundle. On macOS it applies an
ad-hoc signature; distribution signing and notarization remain release work.
