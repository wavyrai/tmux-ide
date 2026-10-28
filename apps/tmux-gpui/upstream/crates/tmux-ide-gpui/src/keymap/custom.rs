//! The daemon's `[[keys.command]]` shortcuts, matched against the resolved
//! keymap. Herdr resolves its own actions before custom commands, so a
//! keystroke the keymap, a pane key, the app's reserved bindings, or the
//! prefix already holds never reaches one, and of two custom commands sharing
//! a trigger only the first runs. Dispatch and the shortcut reference both
//! answer through `Keymap::reach`, so neither can claim a shortcut the other
//! disagrees with.

use super::{Keymap, MAX_KEYSTROKES, Trigger, daemon, has_modifier, identity, typed_matches};
use gpui::{Keystroke, Modifiers};
use herdr_client::protocol::ClientShellCommand;
use std::collections::HashSet;

/// Daemon labels listed per command. Each can spell up to nine keystrokes
/// (`1..9`), so this bounds the reference however many a host sends.
const MAX_LISTED: usize = 16;

/// Whether a custom command's binding runs here, and if not, why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reach {
    Runs,
    /// The keymap, a pane key, a reserved app shortcut, or the prefix itself
    /// holds the keystroke first.
    Shadowed,
    /// An earlier custom command holds the same trigger.
    Taken,
    /// A direct keystroke without a modifier would swallow typing.
    NeedsModifier,
    /// No usable prefix is configured, so no chord can reach it.
    NoPrefix,
    /// Past the aliases one command may carry.
    OverLimit,
    /// The label spells nothing this client can type, such as Herdr's
    /// `hyper` modifier.
    Unsupported,
}

/// One of a custom command's bindings as the shortcut reference shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CustomBinding {
    /// As other shortcuts read: `-`-joined keystrokes, a space after the
    /// prefix.
    pub(crate) label: String,
    pub(crate) reach: Reach,
}

type Identity = (Modifiers, String);

impl Keymap {
    /// The daemon custom command `typed` runs, alone or after the prefix as
    /// `prefixed` says.
    pub(crate) fn custom_command<'a>(
        &self,
        commands: &'a [ClientShellCommand],
        typed: &Keystroke,
        prefixed: bool,
    ) -> Option<&'a ClientShellCommand> {
        // Matching first keeps ordinary typing from checking every trigger
        // against the whole keymap, so the bound set is built only on a match.
        let mut bound = None;
        commands.iter().find(|command| {
            custom_triggers(command)
                .filter(|trigger| match trigger {
                    Trigger::Prefixed(keystroke) => prefixed && typed_matches(typed, keystroke),
                    Trigger::Direct(keystroke) => !prefixed && typed_matches(typed, keystroke),
                })
                .any(|trigger| {
                    let bound = bound.get_or_insert_with(|| self.bound_directly());
                    self.reach(&trigger, bound) == Reach::Runs
                })
        })
    }

    /// Every binding of each command, parallel to `commands`, including those
    /// that cannot run here so a conflict stays discoverable. A trigger
    /// listed twice is shown once.
    pub(crate) fn custom_bindings(
        &self,
        commands: &[ClientShellCommand],
    ) -> Vec<Vec<CustomBinding>> {
        let bound = self.bound_directly();
        let mut claimed = HashSet::new();
        commands
            .iter()
            .map(|command| {
                let mut seen = HashSet::new();
                let mut bindings = Vec::new();
                let labels = command.binding_labels.iter().take(MAX_LISTED);
                for (index, raw) in labels.enumerate() {
                    let triggers = daemon::triggers(raw);
                    if triggers.is_empty() {
                        if let Some(label) = self.unsupported_label(raw)
                            && seen.insert(label.clone())
                        {
                            bindings.push(CustomBinding {
                                label,
                                reach: Reach::Unsupported,
                            });
                        }
                        continue;
                    }
                    for (_, trigger) in triggers {
                        let label = self.custom_label(&trigger);
                        if !seen.insert(label.clone()) {
                            continue;
                        }
                        let reach = match self.reach(&trigger, &bound) {
                            _ if index >= MAX_KEYSTROKES => Reach::OverLimit,
                            Reach::Runs if !claimed.insert(trigger_identity(&trigger)) => {
                                Reach::Taken
                            }
                            reach => reach,
                        };
                        bindings.push(CustomBinding { label, reach });
                    }
                }
                bindings
            })
            .collect()
    }

    /// Whether `trigger` can reach a custom command through this keymap,
    /// given the keystrokes `bound_directly` reports.
    fn reach(&self, trigger: &Trigger, bound: &HashSet<Identity>) -> Reach {
        match trigger {
            Trigger::Prefixed(_) if self.prefixes.is_empty() => Reach::NoPrefix,
            // Any prefix typed after a prefix passes it through instead.
            Trigger::Prefixed(keystroke) => {
                if self.is_prefix(keystroke) || self.chord(keystroke).is_some() {
                    Reach::Shadowed
                } else {
                    Reach::Runs
                }
            }
            Trigger::Direct(keystroke) if !has_modifier(keystroke) => Reach::NeedsModifier,
            Trigger::Direct(keystroke) => {
                if self.is_prefix(keystroke)
                    || self.pane_key(keystroke).is_some()
                    || bound.contains(&identity(keystroke))
                {
                    Reach::Shadowed
                } else {
                    Reach::Runs
                }
            }
        }
    }

    /// Keystrokes GPUI binds directly: the keymap's, then the app's own.
    fn bound_directly(&self) -> HashSet<Identity> {
        let keymap = self.bindings().map(|(_, label)| label);
        let reserved = crate::actions::reserved_keystrokes().map(|label| -> &str { label });
        keymap
            .chain(reserved)
            .filter_map(|label| Keystroke::parse(label).ok())
            .map(|keystroke| identity(&keystroke))
            .collect()
    }

    fn custom_label(&self, trigger: &Trigger) -> String {
        match trigger {
            Trigger::Direct(keystroke) => keystroke.unparse(),
            Trigger::Prefixed(keystroke) => {
                format!("{} {}", self.prefix_word(), keystroke.unparse())
            }
        }
    }

    /// A label this client cannot parse, spelled like the others so it still
    /// reads as separate keys and matches a key search. `None` when it names
    /// no key at all.
    fn unsupported_label(&self, raw: &str) -> Option<String> {
        let raw = raw.trim();
        let (prefix, body) = match raw.strip_prefix("prefix+") {
            Some(body) => (Some(self.prefix_word()), body),
            None => (None, raw),
        };
        let keys = body
            .split('+')
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_lowercase)
            .collect::<Vec<_>>()
            .join("-");
        if keys.is_empty() {
            return None;
        }
        Some(match prefix {
            Some(prefix) => format!("{prefix} {keys}"),
            None => keys,
        })
    }

    /// The prefix as chord labels show it, or a placeholder word while no
    /// usable prefix exists.
    fn prefix_word(&self) -> String {
        self.prefix_label().unwrap_or_else(|| "prefix".to_owned())
    }
}

/// The triggers a custom command's daemon labels spell, as Herdr writes
/// them (`prefix+g`, `ctrl+alt+g`). `binding_label` is only for display: it
/// drops the `prefix+` that tells a chord from a direct keystroke.
fn custom_triggers(command: &ClientShellCommand) -> impl Iterator<Item = Trigger> + '_ {
    command
        .binding_labels
        .iter()
        .take(MAX_KEYSTROKES)
        .flat_map(|label| daemon::triggers(label))
        .map(|(_, trigger)| trigger)
}

fn trigger_identity(trigger: &Trigger) -> (bool, Identity) {
    match trigger {
        Trigger::Direct(keystroke) => (false, identity(keystroke)),
        Trigger::Prefixed(keystroke) => (true, identity(keystroke)),
    }
}
