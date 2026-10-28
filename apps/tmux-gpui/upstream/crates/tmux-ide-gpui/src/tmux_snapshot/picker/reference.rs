//! Native-supported reference only. TUI application-shortcuts.ts supplies the
//! category pattern; unsupported TUI-only terminal/session keys are not advertised.
use super::{Action, Mode, Row, Target};
const SHORTCUTS: &[&str] = &[
    "Application · F1 — Home",
    "Application · F2 — Terminals",
    "Application · F5 — Commands",
    "Application · Cmd+K / Cmd+P — Search sessions and panes",
    "Application · F6 — Search sessions and panes",
    "Workspace · Cmd+Alt+← / → / ↑ / ↓ — Focus adjacent pane",
    "Workspace · Cmd+Shift+Enter — Zoom or restore focused pane",
    "Workspace · Ctrl+G — Focus visible fleet sidebar; otherwise search sessions",
    "Fleet sidebar · ↑ / ↓ / PageUp / PageDown / Home / End — Move focus",
    "Fleet sidebar · Enter — Activate focused row; Esc — Return to terminal",
    "Fleet sidebar · ← / → — Collapse or expand the focused machine",
    "Fleet sidebar · f — Toggle favorite for supported rows",
    "Application · F7 — Needs attention (when available)",
    "Application · F8 / Shift+F8 — Previous / next visited session (when available)",
    "Application · F9 / Shift+F9 — Next / previous retained session",
    "Application · Ctrl+F9 — Forget active session; tmux keeps running",
    "Workspace · F10 — Show or hide sidebar",
    "Home · / — Focus agent search",
    "Home · 0 — All agents",
    "Home · w — Working agents",
    "Home · a — Toggle Needs attention",
    "Home · f — Cycle machine filter (when available)",
    "Home · r — Retry observations (when available)",
    "Home · m — Load more sessions (when available)",
    "Terminal links · Cmd-click / Ctrl-click — Open selected-pane HTTP(S) link",
    "Terminal selection · Cmd+C — Copy selected text",
    "Terminal · Cmd+Shift+C — Copy visible pane (no selection)",
    "Terminal · Cmd+V — Paste (live input authority required)",
    "Terminal · Shift+PageUp / PageDown — Scroll history",
    "Terminal · Shift+End — Return to live",
    "Menus · Type — Search",
    "Menus · ↑ / ↓ — Move selection",
    "Menus · Enter — Activate selected available action",
    "Menus · Esc — Dismiss; reference returns to Commands",
    "Text fields · Composition owns Enter and Escape",
];
const HELP: &[&str] = &[
    "Find your work · Home brings agents from connected machines together. Sessions contain terminal windows and panes.",
    "Find your work · Search Home by agent, team, harness, project, session, machine or server. Coverage notes explain incomplete observations.",
    "Navigate · F6 searches sessions and panes. F7 shows observed agents needing attention. F8 and Shift+F8 move through visited sessions when available.",
    "Sessions · Switch sessions in the sidebar or with Cmd+P. Window tabs switch tmux windows within the selected session.",
    "Machines · Use Commands to connect, manage saved machines, retry unavailable connections or return to the local machine.",
    "Terminals · Select a pane before typing. Pane header controls and Commands offer available pane actions.",
    "History · Scroll back to read earlier output; return to live before sending terminal input.",
    "Appearance · Commands includes Appearance and Terminal font. Your font family and size are saved for the next launch.",
    "Safety · Unavailable or stale targets cannot receive input. Refresh or reselect the intended target after a connection changes.",
];
const CHANGES: &[&str] = &[
    "Home and fleet · Agent search, machine filters, observation retry and load more, plus saved-machine management.",
    "Workspace · New terminal windows and named Claude or Codex agents; pane rename, split, zoom and confirmed close.",
    "Native controls · Pane header menus, sidebar visibility, searchable Commands and keyboard reference popovers.",
    "Terminal font · Installed family selection, size controls and automatic symbol fallbacks, saved for the next launch.",
];
pub(super) fn heading(mode: Mode) -> &'static str {
    match mode {
        Mode::Help => "Using tmux-ide · Esc to Commands",
        Mode::WhatsNew => "Native preview changes · Esc to Commands",
        _ => "Keyboard shortcuts · Esc to Commands",
    }
}
pub(super) fn rows(mode: Mode, query: &str) -> Vec<Row> {
    let query = query.to_lowercase();
    match mode {
        Mode::Help => HELP,
        Mode::WhatsNew => CHANGES,
        _ => SHORTCUTS,
    }
    .iter()
    .filter(|label| {
        query
            .split_whitespace()
            .all(|term| label.to_lowercase().contains(term))
    })
    .map(|label| Row {
        target: Target::Command(Action::Shortcuts),
        label: (*label).into(),
    })
    .collect()
}
