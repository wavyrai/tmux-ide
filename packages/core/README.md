# `@tmux-ide/core`

Renderer-neutral workspace policies shared by the OpenTUI and browser/desktop
clients. This includes workspace selection plus the canonical interaction-mode,
focus-cycle, and Escape-ladder rules; renderer packages only adapt their local
state into these policies.

Renderer-neutral tmux workspace state and policies shared by the GUI and TUI.

Core owns durable identities, selection/reconciliation, and other headless
state machines. It does not own rendering, pane geometry, canvas documents,
DOM/OpenTUI components, or terminal transport adapters. In particular, it has
no dependency on an external or closed-source canvas SDK.

`ResizeTransactionController` shares pane-resize gesture scheduling across renderers:
submit the first changed target, retain only the latest size while an operation
settles, and flush on release. Transport adapters must validate authority, pane
lifetime, and operation receipts against canonical layout before calling
`observeLayout`. Its preview size is interaction intent, not terminal geometry.
