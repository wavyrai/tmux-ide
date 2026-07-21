# Desktop renderer

This package owns the browser-native tmux-ide desktop UI. It is a standard
SolidJS/Vite application and must remain runnable without Electron.

- Do not import `electron`, Node built-ins, or `@tmux-ide/electron-shell`.
- Request native behavior only through `HostCapabilities` from
  `@tmux-ide/contracts`.
- Keep terminal and mission truth behind daemon contracts; this package renders
  projections rather than starting processes.

Run `pnpm --filter @tmux-ide/desktop-renderer dev` for browser development.
The browser fallback implements the same narrow host shape with safe no-op
native capabilities.
