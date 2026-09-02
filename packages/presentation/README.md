# @tmux-ide/presentation

Renderer-neutral PaneFrame and WorkbenchDock presentation policy shared by the
Web/Solid and OpenTUI hosts. This package owns semantic models, action-state
precedence, and navigation. It deliberately does not import daemon runtime,
Electron, xterm, DOM globals, or OpenTUI.

Host-specific rendering remains thin:

- `pane-frame/web` and `workbench-dock/web` bind the shared models to Solid DOM.
- the daemon OpenTUI workbench imports the same model and navigation exports.
- terminal transport, authority, and framebuffer state stay outside this package.
