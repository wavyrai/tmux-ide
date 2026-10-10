//! GPUI actions the app registers and the keystrokes bound to them. Every
//! shortcut comes from the config's resolved `Keymap`, so the palette, the
//! menu bar, and the keymap cannot drift apart. The macOS Hide and Minimize
//! items are the exception: macOS reserves those keystrokes for every app,
//! so they stay fixed rather than user-rebindable.

use crate::controls::Command;
use gpui::{Action, App, KeyBinding, KeyDownEvent, Keystroke, Modifiers, actions};

actions!(
    herdr,
    [
        Quit,
        Hide,
        HideOthers,
        ShowAll,
        Minimize,
        PlaySound,
        RingBellPreview,
        ShowHerdrNotDetected,
        ShowLogs,
        CheckForUpdates,
        ShowUpdatePreview,
        ShowUpdateDownloadPreview,
        ShowUpdateHomebrewPreview
    ]
);

// Edit menu items. Each element registers only the ones it can perform, so
// GPUI disables the rest while that element has focus.
actions!(edit, [Cut, Copy, Paste, SelectAll]);

/// No element sets this context, so these bindings never match a keystroke.
/// They exist only so the Edit menu shows its standard shortcuts. The focused
/// element's key handler keeps owning Cmd-X/C/V/A, as it did before the menu.
const EDIT_MENU_LABELS: &str = "EditMenuLabels";

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
    }
}

#[derive(Clone, PartialEq, serde::Deserialize, Action)]
#[action(no_json)]
pub(crate) struct RunCommand {
    pub(crate) command: Command,
}

/// Picks the sidebar layout, from View > Layout.
#[derive(Clone, PartialEq, serde::Deserialize, Action)]
#[action(no_json)]
pub(crate) struct SetLayout {
    pub(crate) mode: crate::config::LayoutMode,
}

#[derive(Clone, PartialEq, serde::Deserialize, Action)]
#[action(no_json)]
pub(crate) struct ShowToastPreview {
    pub(crate) kind: herdr_client::protocol::SemanticNotificationKind,
}

/// QA: posts an OS notification for the focused pane after a short delay.
#[derive(Clone, PartialEq, serde::Deserialize, Action)]
#[action(no_json)]
pub(crate) struct ShowSystemNotificationPreview;

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, PartialEq, serde::Deserialize, Action)]
#[action(no_json)]
pub(crate) struct SetBadgePreview {
    pub(crate) enabled: bool,
}

/// Binds the active window's server keymap when its device opted into one,
/// otherwise the keymap from the last validated config, or the catalog
/// defaults before any config has loaded.
pub(crate) fn bind_keys(cx: &mut App) {
    let keymap = cx
        .try_global::<crate::window::ActiveServerKeymap>()
        .and_then(|active| active.0.clone())
        .or_else(|| {
            cx.try_global::<crate::app::InitialAppearance>()
                .map(|appearance| appearance.config.keybindings.clone())
        })
        .unwrap_or_default();
    cx.bind_keys(keymap.bindings().map(|(command, keystroke)| {
        if command == Command::Quit {
            KeyBinding::new(keystroke, Quit, None)
        } else {
            KeyBinding::new(keystroke, RunCommand { command }, None)
        }
    }));
    cx.bind_keys(crate::log_window::key_bindings());
    cx.bind_keys(crate::settings_window::key_bindings());
    let [cut, copy, paste, select_all] = EDIT_KEYS;
    cx.bind_keys([
        KeyBinding::new(cut, Cut, Some(EDIT_MENU_LABELS)),
        KeyBinding::new(copy, Copy, Some(EDIT_MENU_LABELS)),
        KeyBinding::new(paste, Paste, Some(EDIT_MENU_LABELS)),
        KeyBinding::new(select_all, SelectAll, Some(EDIT_MENU_LABELS)),
    ]);
    // Bound last so a config keystroke can never steal a reserved macOS
    // shortcut: later bindings take precedence at the same context depth.
    #[cfg(target_os = "macos")]
    {
        let [hide, hide_others, minimize] = SYSTEM_KEYS;
        cx.bind_keys([
            KeyBinding::new(hide, Hide, None),
            KeyBinding::new(hide_others, HideOthers, None),
            KeyBinding::new(minimize, Minimize, None),
        ]);
    }
}

/// The Edit menu's keystrokes: cut, copy, paste, and select all.
const EDIT_KEYS: [&str; 4] = ["cmd-x", "cmd-c", "cmd-v", "cmd-a"];

/// macOS's Hide, Hide Others, and Minimize, bound there alone.
const SYSTEM_KEYS: [&str; 3] = ["cmd-h", "cmd-alt-h", "cmd-m"];

/// Keystrokes bound outside the `Keymap`. A daemon custom command's direct
/// keystroke is matched before any binding, so one of these would otherwise
/// take Paste or Hide away from the app.
pub(crate) fn reserved_keystrokes() -> impl Iterator<Item = &'static str> {
    let system: &[&str] = if cfg!(target_os = "macos") {
        &SYSTEM_KEYS
    } else {
        &[]
    };
    EDIT_KEYS.into_iter().chain(system.iter().copied())
}

/// Replaces every binding after a config reload. The menu bar reads its
/// shortcut labels from the keymap when it is installed, so it is rebuilt too.
pub(crate) fn rebind_keys(cx: &mut App) {
    cx.clear_key_bindings();
    bind_keys(cx);
    crate::menus::install(cx);
}
