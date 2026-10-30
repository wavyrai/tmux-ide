//! GPUI actions the native app registers.

use crate::controls::Command;
use gpui::{Action, KeyDownEvent, Keystroke, Modifiers, actions};

actions!(herdr, [Quit]);

// Edit menu items. Each element registers only the ones it can perform, so
// GPUI disables the rest while that element has focus.
actions!(edit, [Cut, Copy, Paste, SelectAll]);

/// The keystroke an Edit menu item stands for. A menu click replays it
/// through the focused element's own key handler, so choosing the item and
/// pressing its shortcut cannot behave differently.
pub(crate) fn edit_key(key: &str) -> KeyDownEvent {
    KeyDownEvent {
        keystroke: Keystroke {
            modifiers: Modifiers {
                platform: true,
                ..Modifiers::default()
            },
            key: key.into(),
            key_char: None,
        },
        is_held: false,
        prefer_character_input: false,
        layout: None,
    }
}

#[derive(Clone, PartialEq, serde::Deserialize, Action)]
#[action(no_json)]
pub(crate) struct RunCommand {
    pub(crate) command: Command,
}
