//! The keystrokes bound to each catalog command: the defaults in
//! `controls::COMMANDS`, then the daemon config's `[keys]` table (prefix
//! chords included), with the GUI config file's `[keybindings]` table layered
//! on top. The palette, keybindings page, menu bar, GPUI keymap, and prefix
//! mode all read this one resolved answer. The daemon's `[[keys.command]]`
//! shortcuts arrive with each snapshot instead, so they are matched against
//! this answer when typed rather than resolved into it.

mod custom;
mod daemon;

pub(crate) use custom::Reach;
pub(crate) use daemon::DaemonKeys;

use crate::{
    Error, Result,
    controls::{COMMANDS, Command},
};
use daemon::Trigger;
use gpui::{KeybindingKeystroke, Keystroke, Modifiers};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};

/// A command may carry an alias or two, never an unbounded list.
const MAX_KEYSTROKES: usize = 8;

/// Far more chords than a keyboard has spare.
const MAX_PANE_KEYS: usize = 64;

/// The config's `[pane_keys]` table: a keystroke, and the keystroke the
/// focused pane receives for it instead. An empty value removes a default.
pub(crate) type PaneKeys = BTreeMap<String, String>;

/// Ghostty's macOS line-editing chords, which every other Mac terminal also
/// sends: Cmd-Left and Cmd-Right to the line's start and end, Cmd-Backspace
/// to delete back to its start, and Option-Left and Option-Right a word back
/// and forward as Esc-b and Esc-f, which shells bind where they rarely bind
/// an Alt-modified arrow. Elsewhere the platform key is the desktop's.
const DEFAULT_PANE_KEYS: &[(&str, &str)] = &[
    ("cmd-left", "ctrl-a"),
    ("cmd-right", "ctrl-e"),
    ("cmd-backspace", "ctrl-u"),
    ("alt-left", "alt-b"),
    ("alt-right", "alt-f"),
];

/// Keystrokes the GUI config binds, with the command holding each. Spelling
/// differences still name the same keystroke.
type Claimed = HashMap<(Modifiers, String), &'static str>;

fn identity(keystroke: &Keystroke) -> (Modifiers, String) {
    (keystroke.modifiers, keystroke.key.clone())
}

/// One entry of the config's `[keybindings]` table: a keystroke, or a list of
/// them. An empty string or list leaves the command unbound.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub(crate) enum Binding {
    One(String),
    Many(Vec<String>),
}

impl Binding {
    fn keystrokes(&self) -> impl Iterator<Item = &str> {
        let keystrokes = match self {
            Self::One(keystroke) => std::slice::from_ref(keystroke),
            Self::Many(keystrokes) => keystrokes.as_slice(),
        };
        keystrokes
            .iter()
            .map(|keystroke| keystroke.trim())
            .filter(|keystroke| !keystroke.is_empty())
    }
}

/// One way to run a command.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Shortcut {
    /// As shown to the user: a GPUI keystroke, or the prefix and the key
    /// typed after it, separated by a space.
    label: String,
    /// The key that completes a prefix chord. `None` binds `label` directly
    /// through GPUI's keymap.
    chord: Option<Keystroke>,
}

impl Shortcut {
    fn direct(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            chord: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keymap {
    /// Parallel to `COMMANDS`, primary shortcut first.
    shortcuts: Vec<Vec<Shortcut>>,
    /// The keystrokes that start a chord, less any nothing can use. The
    /// first one is the prefix shown to the user.
    prefixes: Vec<Keystroke>,
    /// Keys that move the workspace picker's selection up and down.
    navigate_up: Vec<Keystroke>,
    navigate_down: Vec<Keystroke>,
    /// Keystrokes the focused pane receives as another keystroke. No command
    /// is bound to them, so GPUI's keymap never claims them first.
    pane_keys: Vec<(Keystroke, Keystroke)>,
}

impl Default for Keymap {
    /// The catalog under Herdr's own default `[keys]`, as when neither config
    /// file names a keystroke.
    fn default() -> Self {
        let pane_keys: Vec<_> = default_pane_keys().collect();
        let claimed = pane_keys
            .iter()
            .map(|(typed, _)| (identity(typed), "pane_keys"))
            .collect();
        Self::layer(
            vec![None; COMMANDS.len()],
            &claimed,
            &DaemonKeys::default(),
            pane_keys,
        )
    }
}

impl Keymap {
    /// Layers the daemon's `keys` and then `overrides` over the defaults. A
    /// keystroke the GUI config assigns moves to that command, so rebinding
    /// one key never requires unbinding its default or daemon owner too; two
    /// configured commands claiming it is an error. A command the GUI config
    /// names keeps exactly the keystrokes listed there. `pane_keys` take
    /// their keystrokes from every default and daemon command, but not from
    /// one the GUI config names.
    pub(crate) fn with_overrides(
        overrides: &BTreeMap<String, Binding>,
        pane_keys: &PaneKeys,
        keys: &DaemonKeys,
    ) -> Result<Self> {
        let mut configured = vec![None; COMMANDS.len()];
        for (name, binding) in overrides {
            let index = COMMANDS
                .iter()
                .position(|info| info.name == name)
                .ok_or_else(|| Error::UnknownKeybinding(name.clone()))?;
            let command = COMMANDS[index].name;
            let keystrokes: Vec<String> = binding.keystrokes().map(str::to_owned).collect();
            if keystrokes.len() > MAX_KEYSTROKES {
                return Err(Error::TooManyKeystrokes(command));
            }
            configured[index] = Some(keystrokes);
        }
        let mut claimed = Claimed::new();
        for (info, keystrokes) in COMMANDS.iter().zip(&configured) {
            for keystroke in keystrokes.iter().flatten() {
                let parsed = parse(info.name, keystroke)?;
                if let Some(first) = claimed.insert(identity(&parsed), info.name)
                    && first != info.name
                {
                    return Err(Error::DuplicateKeystroke {
                        keystroke: keystroke.clone(),
                        first,
                        second: info.name,
                    });
                }
            }
        }
        let pane_keys = resolve_pane_keys(pane_keys, default_pane_keys())?;
        for (typed, _) in &pane_keys {
            if let Some(command) = claimed.insert(identity(typed), "pane_keys") {
                return Err(Error::PaneKeyBound {
                    keystroke: typed.unparse(),
                    command,
                });
            }
        }
        Ok(Self::layer(configured, &claimed, keys, pane_keys))
    }

    /// Herdr owns and validates its own file, so a daemon binding this client
    /// cannot honor, or that collides with one already placed, is skipped
    /// rather than reported: the first daemon binding for a keystroke wins,
    /// as does any GUI-configured keystroke over the daemon's.
    fn layer(
        configured: Vec<Option<Vec<String>>>,
        claimed: &Claimed,
        keys: &DaemonKeys,
        pane_keys: Vec<(Keystroke, Keystroke)>,
    ) -> Self {
        // Keystrokes bound directly so far, which later layers cannot take.
        let mut taken: HashSet<_> = claimed.keys().cloned().collect();
        let prefixes: Vec<Keystroke> = keys
            .prefixes
            .iter()
            .filter(|prefix| usable_prefix(prefix) && taken.insert(identity(prefix)))
            .cloned()
            .collect();
        let mut chords = HashSet::new();
        let mut from_daemon = vec![Vec::new(); COMMANDS.len()];
        for (command, trigger) in &keys.bindings {
            let Some(index) = COMMANDS.iter().position(|info| info.command == *command) else {
                continue;
            };
            if configured[index].is_some() {
                continue;
            }
            let shortcut = match trigger {
                Trigger::Direct(keystroke) => {
                    if !has_modifier(keystroke) || !taken.insert(identity(keystroke)) {
                        continue;
                    }
                    Shortcut::direct(keystroke.unparse())
                }
                Trigger::Prefixed(keystroke) => {
                    // A prefix typed after a prefix sends it to the terminal
                    // instead.
                    let Some(prefix) = prefixes.first() else {
                        continue;
                    };
                    if prefixes
                        .iter()
                        .any(|prefix| identity(keystroke) == identity(prefix))
                        || !chords.insert(identity(keystroke))
                    {
                        continue;
                    }
                    Shortcut {
                        label: format!("{} {}", prefix.unparse(), keystroke.unparse()),
                        chord: Some(keystroke.clone()),
                    }
                }
            };
            from_daemon[index].push(shortcut);
        }
        let shortcuts = COMMANDS
            .iter()
            .zip(configured)
            .zip(from_daemon)
            .map(|((info, configured), from_daemon)| match configured {
                Some(keystrokes) => keystrokes.into_iter().map(Shortcut::direct).collect(),
                None => info
                    .shortcuts
                    .iter()
                    .filter(|shortcut| {
                        Keystroke::parse(shortcut)
                            .is_ok_and(|parsed| !taken.contains(&identity(&parsed)))
                    })
                    .map(|&shortcut| Shortcut::direct(shortcut))
                    .chain(from_daemon)
                    .collect(),
            })
            .collect();
        Self {
            shortcuts,
            prefixes,
            navigate_up: keys.navigate_up.clone(),
            navigate_down: keys.navigate_down.clone(),
            pane_keys,
        }
    }

    /// The keystroke the focused pane receives when `typed` is pressed.
    pub(crate) fn pane_key(&self, typed: &Keystroke) -> Option<&Keystroke> {
        self.pane_keys
            .iter()
            .find(|(bound, _)| typed_matches(typed, bound))
            .map(|(_, sent)| sent)
    }

    /// Every shortcut bound to `command`, primary first. A prefix chord reads
    /// as the prefix and the key after it, separated by a space.
    pub fn shortcuts(&self, command: Command) -> impl Iterator<Item = &str> {
        COMMANDS
            .iter()
            .position(|info| info.command == command)
            .and_then(|index| self.shortcuts.get(index))
            .into_iter()
            .flatten()
            .map(|shortcut| shortcut.label.as_str())
    }

    /// The shortcut shown beside `command`, or `""` when it is unbound.
    pub fn primary(&self, command: Command) -> &str {
        self.shortcuts(command).next().unwrap_or("")
    }

    /// Each keystroke GPUI binds directly, with the command it runs, in
    /// catalog order. Prefix chords are not among them; see `chord`.
    pub fn bindings(&self) -> impl Iterator<Item = (Command, &str)> {
        COMMANDS
            .iter()
            .zip(&self.shortcuts)
            .flat_map(|(info, shortcuts)| {
                shortcuts
                    .iter()
                    .filter(|shortcut| shortcut.chord.is_none())
                    .map(move |shortcut| (info.command, shortcut.label.as_str()))
            })
    }

    /// The first prefix as shown to the user, while chords can use one.
    pub(crate) fn prefix_label(&self) -> Option<String> {
        self.prefixes.first().map(Keystroke::unparse)
    }

    /// Whether `typed` is one of the keystrokes that start a chord.
    pub(crate) fn is_prefix(&self, typed: &Keystroke) -> bool {
        self.prefixes
            .iter()
            .any(|prefix| typed_matches(typed, prefix))
    }

    /// The command a chord runs when `typed` follows the prefix.
    pub(crate) fn chord(&self, typed: &Keystroke) -> Option<Command> {
        COMMANDS
            .iter()
            .zip(&self.shortcuts)
            .find(|(_, shortcuts)| {
                shortcuts.iter().any(|shortcut| {
                    shortcut
                        .chord
                        .as_ref()
                        .is_some_and(|chord| typed_matches(typed, chord))
                })
            })
            .map(|(info, _)| info.command)
    }

    /// Whether `typed`, alone or after the prefix as `prefixed` says, is one
    /// of `command`'s shortcuts.
    pub(crate) fn triggers(&self, command: Command, typed: &Keystroke, prefixed: bool) -> bool {
        COMMANDS
            .iter()
            .position(|info| info.command == command)
            .and_then(|index| self.shortcuts.get(index))
            .into_iter()
            .flatten()
            .any(|shortcut| match (&shortcut.chord, prefixed) {
                (Some(chord), true) => typed_matches(typed, chord),
                (None, false) => Keystroke::parse(&shortcut.label)
                    .is_ok_and(|bound| typed_matches(typed, &bound)),
                _ => false,
            })
    }

    /// Whether `typed` moves the workspace picker's selection: `Some(true)`
    /// up, `Some(false)` down. A bare character would be typing into its
    /// search field instead, and the picker keeps Escape, Enter, and Tab, so
    /// only other keys that cannot be text count.
    pub(crate) fn navigates_workspace(&self, typed: &Keystroke) -> Option<bool> {
        let text_safe = |bound: &&Keystroke| {
            has_modifier(bound)
                || (bound.key.chars().nth(1).is_some()
                    && !matches!(bound.key.as_str(), "escape" | "enter" | "tab"))
        };
        let matches = |keys: &[Keystroke]| {
            keys.iter()
                .filter(text_safe)
                .any(|bound| typed_matches(typed, bound))
        };
        if matches(&self.navigate_up) {
            Some(true)
        } else if matches(&self.navigate_down) {
            Some(false)
        } else {
            None
        }
    }
}

/// GPUI's own matching, so a shifted symbol such as `?` matches however the
/// keyboard reports it.
fn typed_matches(typed: &Keystroke, bound: &Keystroke) -> bool {
    typed.should_match(&KeybindingKeystroke::from_keystroke(bound.clone()))
}

/// A keystroke without one of these would stop typing from reaching the
/// terminal.
fn has_modifier(keystroke: &Keystroke) -> bool {
    let modifiers = keystroke.modifiers;
    modifiers.platform || modifiers.control || modifiers.alt || modifiers.function
}

/// Herdr documents `esc` and function keys as prefixes; any other bare key
/// would swallow ordinary typing.
fn usable_prefix(prefix: &Keystroke) -> bool {
    has_modifier(prefix)
        || prefix.key == "escape"
        || prefix
            .key
            .strip_prefix('f')
            .is_some_and(|number| number.parse::<u8>().is_ok())
}

/// The built-in pane keys, macOS only: Ghostty binds them there alone, and
/// elsewhere the platform key belongs to the desktop.
fn default_pane_keys() -> impl Iterator<Item = (Keystroke, Keystroke)> {
    DEFAULT_PANE_KEYS
        .iter()
        .filter(|_| cfg!(target_os = "macos"))
        .filter_map(|(typed, sent)| {
            Some((Keystroke::parse(typed).ok()?, Keystroke::parse(sent).ok()?))
        })
}

/// Layers the config's `[pane_keys]` over `defaults`. A keystroke spelled
/// differently still replaces its default, and an empty value removes it.
fn resolve_pane_keys(
    table: &PaneKeys,
    defaults: impl IntoIterator<Item = (Keystroke, Keystroke)>,
) -> Result<Vec<(Keystroke, Keystroke)>> {
    if table.len() > MAX_PANE_KEYS {
        return Err(Error::TooManyPaneKeys(MAX_PANE_KEYS));
    }
    let parse = |keystroke: &str| {
        Keystroke::parse(keystroke).map_err(|source| Error::InvalidPaneKey {
            keystroke: keystroke.to_owned(),
            source,
        })
    };
    let mut resolved: Vec<_> = defaults.into_iter().collect();
    let mut seen = HashSet::new();
    for (typed, sent) in table {
        let parsed = parse(typed.trim())?;
        // A bare character or space is typing, which must reach the pane as text.
        if !has_modifier(&parsed) && (parsed.key.chars().nth(1).is_none() || parsed.key == "space")
        {
            return Err(Error::PaneKeyWithoutModifier(typed.clone()));
        }
        if !seen.insert(identity(&parsed)) {
            return Err(Error::DuplicatePaneKey(typed.clone()));
        }
        resolved.retain(|(bound, _)| identity(bound) != identity(&parsed));
        let sent = sent.trim();
        if sent.is_empty() {
            continue;
        }
        let sent_parsed = parse(sent)?;
        if !crate::terminal::reaches_pane(&sent_parsed) {
            return Err(Error::UnsendablePaneKey {
                from: typed.clone(),
                to: sent.to_owned(),
            });
        }
        resolved.push((parsed, sent_parsed));
    }
    Ok(resolved)
}

fn parse(command: &'static str, keystroke: &str) -> Result<Keystroke> {
    let parsed = Keystroke::parse(keystroke).map_err(|source| Error::InvalidKeystroke {
        command,
        keystroke: keystroke.to_owned(),
        source,
    })?;
    if !has_modifier(&parsed) {
        return Err(Error::KeystrokeWithoutModifier {
            command,
            keystroke: keystroke.to_owned(),
        });
    }
    Ok(parsed)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
