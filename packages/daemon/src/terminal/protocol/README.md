# terminal/protocol — the tmux wire library

Only the core touches tmux: it spawns, attaches, scrapes, and stamps, and this
directory holds the wire vocabulary it does that with — control-mode line
parsing, key encoding, input coalescing, layout parsing, session-descriptor
discovery, and the workspace pane reconciliation. Adapters render and express
intent; they own no tmux connection of their own.

Imports flow adapter → core only. `tui/mirror` and the widget surfaces import
from here; nothing here (nor anywhere else under `terminal/`, `command-center/`,
`lib/`, or `server/`) may import from `tui/` or `widgets/`. That direction is
enforced by `src/__tests__/engine-import-dag.test.ts`, which also carries the
ledger of pre-existing inversions still awaiting relocation — a list that may
only shrink.
