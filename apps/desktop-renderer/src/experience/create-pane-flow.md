# Native create terminal / agent flow

`CreatePaneFlow` is an independently composable Solid presenter for the native
`+` action. It deliberately has no terminal runtime implementation. The
renderer submits one strict, daemon-owned `workspace.pane.create` invocation;
tmux remains the only terminal/process authority.

## Required production adapter

App wiring should provide the component with:

1. workspace choices from the generation-bound live workspace catalog, mapped
   to its canonical `workspaceName`, label, and availability. Never pass the catalog's
   trusted-host `sessionName` into the renderer;
2. a future daemon resource containing safe harness profile metadata only:
   semantic profile ID, display label/description, and availability. Executable,
   argv, cwd, environment, model launch flags, and adapter internals stay in the
   daemon;
3. optional mission projection choices containing semantic ID, label, and
   availability only; and
4. an `onCommand` callback routed through a typed Electron host capability for
   `workspace.pane.create`.

The missing mutation adapter should validate `WorkspacePaneCreateInvocation`,
pin the current daemon generation, resolve `workspaceName`, `harnessProfileId`,
role, and `missionId` against daemon-owned registries, and only then ask the
tmux bridge to create the pane. The adapter must return a semantic result or a
sanitized error; it must never return tmux IDs, commands, paths, or argv to the
renderer.

Dock buttons, palette entries, and shortcuts can call
`workspacePaneCreateInvocation` with their own command source. This preserves
one semantic command instead of creating surface-specific terminal launch
paths.
