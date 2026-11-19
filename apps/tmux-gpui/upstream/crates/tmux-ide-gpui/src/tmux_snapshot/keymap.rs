//! The app's one key table: each shortcut the window answers, by id, with the
//! keystroke it is typed as. The menu bar's key equivalents, the setup
//! guide's Keys step and the keyboard hints read it, and tests hold the
//! hand-matched key paths (`pane_shortcuts::shortcut`, the F-keys in
//! `picker/commands.rs`) and Keyboard shortcuts… to it, so they can't drift.
use gpui::Keystroke;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Id {
    Commands,
    SessionsAndPanes,
    Search,
    Home,
    Terminals,
    Attention,
    Sidebar,
    SplitRight,
    SplitDown,
    Zoom,
    ClosePane,
    FocusLeft,
    FocusRight,
    FocusUp,
    FocusDown,
    NewWindow,
    NextWindow,
    PreviousWindow,
}

/// `(id, what it does, keystroke)`, the keystroke in gpui's own syntax.
pub(super) const KEYMAP: &[(Id, &str, &str)] = &[
    (Id::Commands, "Commands", "f5"),
    (Id::SessionsAndPanes, "Search sessions and panes", "f6"),
    (Id::Search, "Search sessions and panes", "cmd-k"),
    (Id::Home, "Home", "f1"),
    (Id::Terminals, "Terminals", "f2"),
    (Id::Attention, "Needs attention", "f7"),
    (Id::Sidebar, "Show or hide the sidebar", "f10"),
    (Id::SplitRight, "Split right", "cmd-d"),
    (Id::SplitDown, "Split down", "cmd-shift-d"),
    (Id::Zoom, "Zoom the pane", "cmd-shift-enter"),
    (Id::ClosePane, "Close the pane", "cmd-w"),
    (Id::FocusLeft, "Focus pane left", "cmd-alt-left"),
    (Id::FocusRight, "Focus pane right", "cmd-alt-right"),
    (Id::FocusUp, "Focus pane above", "cmd-alt-up"),
    (Id::FocusDown, "Focus pane below", "cmd-alt-down"),
    (Id::NewWindow, "New window", "cmd-t"),
    (Id::NextWindow, "Next window", "cmd-}"),
    (Id::PreviousWindow, "Previous window", "cmd-{"),
];

/// The keystroke `id` is typed as.
pub(super) fn keystroke(id: Id) -> &'static str {
    KEYMAP
        .iter()
        .find(|(entry, _, _)| *entry == id)
        .map_or("", |(_, _, key)| key)
}

/// The keys the setup guide teaches, in its order: a label and the ids it
/// covers (a row may stand for a pair or the four arrows).
pub(super) const GUIDE: &[(&str, &[Id])] = &[
    ("Commands", &[Id::Commands]),
    ("Search sessions and panes", &[Id::Search]),
    ("Home", &[Id::Home]),
    ("Needs attention", &[Id::Attention]),
    ("Split right / down", &[Id::SplitRight, Id::SplitDown]),
    ("Zoom the pane", &[Id::Zoom]),
    (
        "Move between panes",
        &[Id::FocusLeft, Id::FocusRight, Id::FocusUp, Id::FocusDown],
    ),
    ("Show or hide the sidebar", &[Id::Sidebar]),
];

/// `key` as the menus show it: modifier symbols, then the key (⌘⇧D, F5,
/// ⌘⌥←), in the order the app's other hints use.
pub(super) fn symbols(key: &str) -> String {
    let Ok(stroke) = Keystroke::parse(key) else {
        return String::new();
    };
    let m = stroke.modifiers;
    let mut out = String::new();
    for (on, symbol) in [
        (m.control, "⌃"),
        (m.platform, "⌘"),
        (m.alt, "⌥"),
        (m.shift, "⇧"),
    ] {
        if on {
            out.push_str(symbol);
        }
    }
    out.push_str(&match stroke.key.as_str() {
        "enter" => "↵".into(),
        "left" => "←".into(),
        "right" => "→".into(),
        "up" => "↑".into(),
        "down" => "↓".into(),
        k => k.to_uppercase(),
    });
    out
}

/// `key` as Keyboard shortcuts… spells it (Cmd+Shift+Enter, F5).
pub(super) fn spelled(key: &str) -> String {
    let Ok(stroke) = Keystroke::parse(key) else {
        return String::new();
    };
    let m = stroke.modifiers;
    let mut parts: Vec<String> = Vec::new();
    for (on, word) in [
        (m.control, "Ctrl"),
        (m.platform, "Cmd"),
        (m.alt, "Alt"),
        (m.shift, "Shift"),
    ] {
        if on {
            parts.push(word.into());
        }
    }
    parts.push(match stroke.key.as_str() {
        "enter" => "Enter".into(),
        k => k.to_uppercase(),
    });
    parts.join("+")
}

/// Whether the key press `event` is the keystroke `key`: the same key and
/// exactly its modifiers. Shift is part of a symbol for `{` and `}`.
pub(super) fn matches(key: &str, event: &Keystroke) -> bool {
    let Ok(want) = Keystroke::parse(key) else {
        return false;
    };
    let (w, e) = (want.modifiers, event.modifiers);
    let shifted_symbol = matches!(want.key.as_str(), "{" | "}");
    let key_matches = event.key == want.key
        || (want.key == "{" && event.key == "[" && e.shift)
        || (want.key == "}" && event.key == "]" && e.shift);
    key_matches
        && w.platform == e.platform
        && w.control == e.control
        && w.alt == e.alt
        && (shifted_symbol || w.shift == e.shift)
}

#[cfg(test)]
#[path = "keymap_tests.rs"]
mod tests;
