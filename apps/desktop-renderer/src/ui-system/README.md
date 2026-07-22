# Desktop UI system

This directory contains renderer-local Solid primitives and semantic CSS tokens.
It intentionally has no dependency on the application shell or canvas.

Import components from `./ui-system/index.ts`. The stylesheet is loaded from
`index.html` as `/src/ui-system/ui-system.css`; components must not import it from
TypeScript because Vite's development CSS injection conflicts with the desktop
renderer's strict `style-src 'self'` policy.

Chrome and prose use `--tmi-font-chrome` (the native system sans stack). Technical
values use `--tmi-font-technical`, available through the `tmi-technical` utility.
The semantic colors prefer the existing `--tmux-ide-*` visual-contract variables
inside the app and provide dark-first fallbacks for isolated fixtures.

`Tabs` uses automatic activation by default and supports a manual activation
mode with focus roving independently from selection. `ResizeHandle` is a focusable
ARIA separator: arrow keys move one step, Shift+arrow moves a large step, and
Home/End move to the bounds. `Tooltip` uses a render prop so its trigger receives
`aria-describedby` without cloning elements. Its fixed layer portals to the nearest
`data-overlay-root` (then the app/theme root), flips and clamps against the viewport,
and is exercised by the strict-CSP browser smoke without injecting a style element.
Escape dismisses only the innermost open tooltip; once tooltip layers are gone, the
event remains available to the containing dialog or palette.
