//! The Herdr daemon's `[keys]` table, read so the GUI answers the same
//! shortcuts, prefix chords included, as the TUI. Herdr owns that file and
//! reports its own mistakes, so anything this client cannot express (an
//! unparseable entry, a `hyper` modifier, an action with no GUI command) is
//! skipped rather than turned into a GUI config error.
//!
//! Herdr actions with no GUI command, each for a reason:
//! - `detach`: closing the window already leaves the daemon running, and a
//!   window cannot stay open without a connection.
//! - `open_worktree` and `remove_worktree`: the workspace menu offers both,
//!   but each needs a menu row as the target, not just the focused one.
//! - `navigate_pane_*`: the workspace picker is a search field here, with no
//!   pane cursor to move.

use crate::{Error, Result, controls::Command};
use gpui::{Keystroke, Modifiers};

/// Herdr's own fallback when `prefix` is missing or names no usable key.
const DEFAULT_PREFIX: &str = "ctrl+b";

/// A daemon `[keys]` entry can hold a list, but never an unbounded one.
const MAX_ENTRIES: usize = 16;

/// A host's published profile is daemon data. Herdr's normalized `[keys]` is a
/// few kilobytes, so anything far larger is refused before it is parsed.
const MAX_PROFILE_BYTES: usize = 64 * 1024;

/// What a daemon action runs here.
#[derive(Clone, Copy)]
enum Target {
    Command(Command),
    /// An action expanded over the digits 1-9, each of which it binds
    /// selecting that item, as `[keys.indexed]` does too.
    Indexed(Indexed),
}

#[derive(Clone, Copy)]
enum Indexed {
    /// `switch_tab`, by the tab's number.
    Tab,
    /// `switch_workspace`, by position in the sidebar.
    Workspace,
    /// `focus_agent`, by position in the agent panel.
    Agent,
}

impl Indexed {
    fn command(self, digit: u8) -> Command {
        match self {
            Self::Tab => Command::TabNumber(digit),
            Self::Workspace => Command::WorkspaceNumber(digit),
            Self::Agent => Command::AgentNumber(digit),
        }
    }

    /// The `[keys.indexed]` entry naming a modifier combo for these digits.
    fn legacy_key(self) -> &'static str {
        match self {
            Self::Tab => "tabs",
            Self::Workspace => "workspaces",
            Self::Agent => "agents",
        }
    }
}

/// Daemon actions with a GUI equivalent, each with Herdr's default binding.
/// The module documentation lists the actions missing here, and why.
const ACTIONS: &[(&str, Target, &str)] = &[
    ("help", Target::Command(Command::Keybinds), "prefix+?"),
    ("settings", Target::Command(Command::Settings), "prefix+s"),
    (
        "new_workspace",
        Target::Command(Command::Workspace),
        "prefix+shift+n",
    ),
    (
        "new_worktree",
        Target::Command(Command::NewWorktree),
        "prefix+shift+g",
    ),
    (
        "workspace_picker",
        Target::Command(Command::WorkspacePicker),
        "prefix+w",
    ),
    (
        "goto",
        Target::Command(Command::WorkspacePicker),
        "prefix+g",
    ),
    (
        "rename_workspace",
        Target::Command(Command::RenameWorkspace),
        "prefix+shift+w",
    ),
    (
        "close_workspace",
        Target::Command(Command::CloseWorkspace),
        "prefix+shift+d",
    ),
    (
        "reload_config",
        Target::Command(Command::ReloadConfig),
        "prefix+shift+r",
    ),
    (
        "open_notification_target",
        Target::Command(Command::OpenNotificationTarget),
        "prefix+o",
    ),
    (
        "previous_workspace",
        Target::Command(Command::PreviousWorkspace),
        "",
    ),
    (
        "next_workspace",
        Target::Command(Command::NextWorkspace),
        "",
    ),
    (
        "previous_agent",
        Target::Command(Command::PreviousAgent),
        "",
    ),
    ("next_agent", Target::Command(Command::NextAgent), ""),
    ("focus_agent", Target::Indexed(Indexed::Agent), ""),
    ("new_tab", Target::Command(Command::Tab), "prefix+c"),
    (
        "previous_tab",
        Target::Command(Command::PreviousTab),
        "prefix+p",
    ),
    ("next_tab", Target::Command(Command::NextTab), "prefix+n"),
    (
        "rename_tab",
        Target::Command(Command::RenameTab),
        "prefix+shift+t",
    ),
    (
        "move_tab_previous",
        Target::Command(Command::MoveTabPrevious),
        "",
    ),
    ("move_tab_next", Target::Command(Command::MoveTabNext), ""),
    ("switch_tab", Target::Indexed(Indexed::Tab), "prefix+1..9"),
    ("switch_workspace", Target::Indexed(Indexed::Workspace), ""),
    (
        "close_tab",
        Target::Command(Command::CloseTab),
        "prefix+shift+x",
    ),
    (
        "rename_pane",
        Target::Command(Command::RenamePane),
        "prefix+shift+p",
    ),
    (
        "edit_scrollback",
        Target::Command(Command::EditScrollback),
        "prefix+e",
    ),
    ("clear_pane", Target::Command(Command::ClearPane), ""),
    ("copy_mode", Target::Command(Command::CopyMode), "prefix+["),
    (
        "focus_pane_left",
        Target::Command(Command::FocusLeft),
        "prefix+h",
    ),
    (
        "focus_pane_down",
        Target::Command(Command::FocusDown),
        "prefix+j",
    ),
    (
        "focus_pane_up",
        Target::Command(Command::FocusUp),
        "prefix+k",
    ),
    (
        "focus_pane_right",
        Target::Command(Command::FocusRight),
        "prefix+l",
    ),
    (
        "swap_pane_left",
        Target::Command(Command::SwapLeft),
        "prefix+shift+h",
    ),
    (
        "swap_pane_down",
        Target::Command(Command::SwapDown),
        "prefix+shift+j",
    ),
    (
        "swap_pane_up",
        Target::Command(Command::SwapUp),
        "prefix+shift+k",
    ),
    (
        "swap_pane_right",
        Target::Command(Command::SwapRight),
        "prefix+shift+l",
    ),
    (
        "cycle_pane_next",
        Target::Command(Command::NextPane),
        "prefix+tab",
    ),
    (
        "cycle_pane_previous",
        Target::Command(Command::PreviousPane),
        "prefix+shift+tab",
    ),
    (
        "split_vertical",
        Target::Command(Command::SplitRight),
        "prefix+v",
    ),
    (
        "split_horizontal",
        Target::Command(Command::SplitDown),
        "prefix+minus",
    ),
    (
        "close_pane",
        Target::Command(Command::ClosePane),
        "prefix+x",
    ),
    ("last_pane", Target::Command(Command::LastPane), ""),
    ("zoom", Target::Command(Command::Zoom), "prefix+z"),
    (
        "resize_mode",
        Target::Command(Command::ResizeMode),
        "prefix+r",
    ),
    ("resize_pane_left", Target::Command(Command::ResizeLeft), ""),
    ("resize_pane_down", Target::Command(Command::ResizeDown), ""),
    ("resize_pane_up", Target::Command(Command::ResizeUp), ""),
    (
        "resize_pane_right",
        Target::Command(Command::ResizeRight),
        "",
    ),
    (
        "toggle_sidebar",
        Target::Command(Command::ToggleSidebar),
        "prefix+b",
    ),
];

/// How a daemon binding is typed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Trigger {
    /// The keystroke alone runs the command.
    Direct(Keystroke),
    /// The prefix, then this keystroke.
    Prefixed(Keystroke),
}

/// The daemon's bindings for GUI commands: those its file sets first, in
/// table order, then Herdr's defaults for the rest. Herdr rejects a default
/// that collides with a binding the user wrote, and the keymap keeps the
/// first binding for a keystroke, so the same one wins here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DaemonKeys {
    /// Every prefix key, never empty and without duplicates. Each one arms
    /// prefix mode; the first is the one shown in chord labels.
    pub(super) prefixes: Vec<Keystroke>,
    pub(super) bindings: Vec<(Command, Trigger)>,
    /// `navigate_workspace_up` and `_down`: the keys that move the workspace
    /// picker's selection, besides its own arrows.
    pub(super) navigate_up: Vec<Keystroke>,
    pub(super) navigate_down: Vec<Keystroke>,
}

impl Default for DaemonKeys {
    /// Herdr's defaults, which also apply when it has no config file.
    fn default() -> Self {
        Self::from_table(None)
    }
}

impl DaemonKeys {
    /// Reads a host's `server_keybindings_toml`: the normalized `[keys]`
    /// profile Herdr publishes for `--remote-keybindings server`. It is read
    /// with the same rules as the local `[keys]` table, so prefixes, actions,
    /// and indexed keys mean the same thing on either side. Like Herdr, a
    /// profile that is missing or unreadable as a whole is an error, which
    /// leaves the caller on its local keybindings.
    pub(crate) fn from_profile(profile: Option<&str>) -> Result<Self> {
        let profile = profile.ok_or(Error::ServerKeybindingsMissing)?;
        if profile.len() > MAX_PROFILE_BYTES {
            return Err(Error::ServerKeybindingsTooLarge {
                max: MAX_PROFILE_BYTES,
            });
        }
        let table: toml::Table = profile.parse().map_err(Error::ServerKeybindingsParse)?;
        let keys = table
            .get("keys")
            .and_then(toml::Value::as_table)
            .ok_or(Error::ServerKeybindingsNoKeys)?;
        Ok(Self::from_table(Some(keys)))
    }

    /// Reads the daemon config's `[keys]` table; each action it leaves out,
    /// or gives a value of the wrong type, keeps Herdr's default.
    pub(crate) fn from_table(keys: Option<&toml::Table>) -> Self {
        let prefixes = prefixes(keys);
        let legacy = |indexed: Indexed| {
            keys.and_then(|keys| keys.get("indexed")?.get(indexed.legacy_key())?.as_str())
                .map(str::trim)
                .filter(|combo| !combo.is_empty() && !combo.starts_with("prefix"))
        };
        let mut configured = Vec::new();
        let mut defaults = Vec::new();
        for &(name, target, default) in ACTIONS {
            let value = keys.and_then(|keys| {
                keys.get(name)
                    // Herdr still accepts zoom's old name.
                    .or_else(|| (name == "zoom").then(|| keys.get("fullscreen")).flatten())
            });
            let written = entries(value);
            // A legacy `[keys.indexed]` combo is user configuration too: it
            // displaces the default unless the action is also set itself.
            let legacy = match target {
                Target::Indexed(indexed) => legacy(indexed),
                Target::Command(_) => None,
            };
            let (list, entries) = if written.is_none() && legacy.is_none() {
                (&mut defaults, vec![default.to_owned()])
            } else {
                let mut entries: Vec<String> = written
                    .unwrap_or_default()
                    .into_iter()
                    .take(MAX_ENTRIES)
                    .map(str::to_owned)
                    .collect();
                entries.extend(legacy.map(|combo| format!("{combo}+1..9")));
                (&mut configured, entries)
            };
            for entry in &entries {
                for (digit, trigger) in triggers(entry) {
                    let command = match (target, digit) {
                        (Target::Command(command), _) => command,
                        (Target::Indexed(indexed), Some(digit)) => indexed.command(digit),
                        (Target::Indexed(_), None) => continue,
                    };
                    list.push((command, trigger));
                }
            }
        }
        configured.append(&mut defaults);
        let navigate = |name: &str, default: &'static str| -> Vec<Keystroke> {
            let entries = entries(keys.and_then(|keys| keys.get(name)));
            // Herdr refuses prefix chords in navigate mode.
            entries
                .unwrap_or_else(|| vec![default])
                .into_iter()
                .take(MAX_ENTRIES)
                .map(str::trim)
                .filter(|entry| !entry.starts_with("prefix+"))
                .filter_map(keystroke)
                .collect()
        };
        Self {
            prefixes,
            bindings: configured,
            navigate_up: navigate("navigate_workspace_up", "up"),
            navigate_down: navigate("navigate_workspace_down", "down"),
        }
    }
}

/// A `[keys]` value's entries, when it has a binding's shape: a string, or a
/// list of strings. An empty one still counts, as Herdr reads it as unbound;
/// any other value leaves the default.
fn entries(value: Option<&toml::Value>) -> Option<Vec<&str>> {
    match value? {
        toml::Value::String(entry) => Some(vec![entry.as_str()]),
        toml::Value::Array(entries) if entries.iter().all(toml::Value::is_str) => {
            Some(entries.iter().filter_map(toml::Value::as_str).collect())
        }
        _ => None,
    }
}

/// `prefix` as Herdr reads it: one string or a list, with the published
/// profiles' `extra_prefixes` appended. Entries this client cannot parse are
/// dropped, later duplicates are ignored, and when nothing usable remains
/// (an empty list included) Herdr's default applies.
fn prefixes(keys: Option<&toml::Table>) -> Vec<Keystroke> {
    let field = |name: &str| entries(keys.and_then(|keys| keys.get(name))).unwrap_or_default();
    let mut prefixes: Vec<Keystroke> = Vec::new();
    let entries = field("prefix").into_iter().chain(field("extra_prefixes"));
    for parsed in entries.take(MAX_ENTRIES).filter_map(keystroke) {
        if !prefixes.contains(&parsed) {
            prefixes.push(parsed);
        }
    }
    if prefixes.is_empty() {
        prefixes.extend(keystroke(DEFAULT_PREFIX));
    }
    prefixes
}

/// Each binding one entry spells, with the digit it types, if any. `1..9`
/// stands for the nine digit keys; an unparseable entry yields nothing.
pub(super) fn triggers(entry: &str) -> Vec<(Option<u8>, Trigger)> {
    let entry = entry.trim();
    let (prefixed, body) = match entry.strip_prefix("prefix+") {
        Some(body) => (true, body),
        None => (false, entry),
    };
    let trigger = |keystroke| {
        if prefixed {
            Trigger::Prefixed(keystroke)
        } else {
            Trigger::Direct(keystroke)
        }
    };
    if body.split('+').any(|part| part.trim() == "1..9") {
        return (1..=9)
            .filter_map(|digit| {
                let keystroke = keystroke(&body.replace("1..9", &digit.to_string()))?;
                Some((Some(digit), trigger(keystroke)))
            })
            .collect();
    }
    let Some(keystroke) = keystroke(body) else {
        return Vec::new();
    };
    let digit = keystroke
        .key
        .parse::<u8>()
        .ok()
        .filter(|digit| (1..=9).contains(digit));
    vec![(digit, trigger(keystroke))]
}

/// One daemon keystroke, `+`-separated as Herdr writes it, in GPUI's terms.
/// Herdr's `hyper` modifier has no GPUI equivalent, so it matches nothing.
fn keystroke(text: &str) -> Option<Keystroke> {
    let mut modifiers = Modifiers::default();
    let mut key = None;
    for part in text.split('+') {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers.control = true,
            "shift" => modifiers.shift = true,
            "alt" | "option" | "meta" => modifiers.alt = true,
            "cmd" | "command" | "super" => modifiers.platform = true,
            "hyper" => return None,
            _ if key.is_none() => key = Some(part),
            _ => return None,
        }
    }
    let key = key?;
    let named = match key.to_ascii_lowercase().as_str() {
        "space" => "space",
        "enter" | "return" => "enter",
        "esc" | "escape" => "escape",
        "tab" => "tab",
        "backspace" | "bs" => "backspace",
        "left" => "left",
        "right" => "right",
        "up" => "up",
        "down" => "down",
        "minus" => "-",
        "comma" => ",",
        "period" => ".",
        "slash" => "/",
        "backslash" => "\\",
        "quote" => "'",
        "double_quote" | "double-quote" => "\"",
        "semicolon" => ";",
        "colon" => ":",
        "percent" => "%",
        "ampersand" => "&",
        "backtick" => "`",
        "plus" => "+",
        _ => "",
    };
    let mut chars = key.chars();
    let key = match (chars.next(), chars.next()) {
        _ if !named.is_empty() => named.to_owned(),
        (Some(single), None) if single.is_ascii_uppercase() => {
            modifiers.shift = true;
            single.to_ascii_lowercase().to_string()
        }
        (Some(single), None) => single.to_string(),
        _ => {
            let lower = key.to_ascii_lowercase();
            let number: u8 = lower.strip_prefix('f')?.parse().ok()?;
            if !(1..=35).contains(&number) {
                return None;
            }
            lower
        }
    };
    Some(Keystroke {
        modifiers,
        key,
        key_char: None,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
