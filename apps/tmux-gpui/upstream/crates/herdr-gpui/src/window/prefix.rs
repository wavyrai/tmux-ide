//! Herdr's prefix chords, as the TUI types them: the prefix arms the window,
//! and the next keystroke runs its chord's command or, when nothing is bound
//! to it, is swallowed. Typing the prefix twice sends it on to the focused
//! element as ordinary input, and Escape simply cancels. A chord typed in a
//! menu's text field closes the menu and runs, as it would from the terminal.
//!
//! The daemon's custom command shortcuts are matched here too, after the
//! keymap's own, and Herdr's resize mode claims every key until it ends.

use super::HerdrWindow;
use crate::controls::Command;
use gpui::{Context, Keystroke, Subscription, Window};
use herdr_client::protocol::ClientShellCommandAction;

impl HerdrWindow {
    /// GPUI calls interceptors before any binding or key handler sees the
    /// keystroke, so an armed prefix claims the next key wherever focus is.
    /// Interceptors are app-wide; each window answers only for itself.
    pub(crate) fn intercept_prefix(window: &Window, cx: &mut Context<Self>) -> Subscription {
        let own = window.window_handle().window_id();
        let view = cx.weak_entity();
        cx.intercept_keystrokes(move |event, window, cx| {
            if window.window_handle().window_id() != own {
                return;
            }
            let _ = view.update(cx, |this, cx| {
                if !matches!(
                    event.keystroke.key.as_str(),
                    "shift" | "shiftleft" | "shiftright"
                ) {
                    this.shift_taps.cancel();
                }
                this.prefix_keystroke(&event.keystroke, window, cx);
            });
        })
    }

    fn prefix_keystroke(
        &mut self,
        keystroke: &Keystroke,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.resize_mode {
            self.resize_keystroke(keystroke, window, cx);
            return;
        }
        let keymap = self.keymap();
        let is_prefix = keymap.is_prefix(keystroke);
        if !self.prefix_armed {
            if is_prefix {
                self.prefix_armed = true;
                cx.stop_propagation();
                cx.notify();
            } else if self.menu.page.is_none()
                && let Some((id, action)) = self.custom_command(keystroke, false)
            {
                cx.stop_propagation();
                self.invoke_custom_command(&id, action, cx);
            }
            return;
        }
        let chord = keymap.chord(keystroke);
        self.prefix_armed = false;
        cx.notify();
        if is_prefix {
            return;
        }
        cx.stop_propagation();
        let Some(command) = chord else {
            if let Some((id, action)) = self.custom_command(keystroke, true) {
                if self.menu.page.is_some() {
                    self.dismiss_menu(window, cx);
                }
                self.invoke_custom_command(&id, action, cx);
            }
            return;
        };
        // Commands wait while a menu page holds input, so the chord ends it
        // first. Run directly rather than through focus, which the menu held.
        if self.menu.page.is_some() {
            self.dismiss_menu(window, cx);
        }
        self.command(command, window, cx);
    }

    /// The selected daemon's custom command `keystroke` runs.
    fn custom_command(
        &self,
        keystroke: &Keystroke,
        prefixed: bool,
    ) -> Option<(String, ClientShellCommandAction)> {
        // As the palette and shortcut reference do, offer nothing while the
        // snapshot may be stale, so the key reaches the terminal instead.
        let snapshot = self
            .live
            .snapshot
            .as_ref()
            .filter(|_| self.live.status.is_connected())?;
        self.keymap()
            .custom_command(&snapshot.commands, keystroke, prefixed)
            .map(|command| (command.command_id.clone(), command.action))
    }

    /// Herdr's resize mode: h, j, k, l or the arrows resize the focused pane,
    /// Escape, Enter, or the mode's own shortcut ends it, and anything else
    /// is swallowed. Platform shortcuts such as quitting still work, and a
    /// menu, which takes keys of its own, ends the mode.
    fn resize_keystroke(
        &mut self,
        keystroke: &Keystroke,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.menu.page.is_some() {
            self.resize_mode = false;
            cx.notify();
            return;
        }
        if keystroke.modifiers.platform {
            return;
        }
        cx.stop_propagation();
        let keymap = self.keymap();
        if matches!(keystroke.key.as_str(), "escape" | "enter")
            || keymap.triggers(Command::ResizeMode, keystroke, true)
            || keymap.triggers(Command::ResizeMode, keystroke, false)
        {
            self.resize_mode = false;
            cx.notify();
            return;
        }
        let modifiers = keystroke.modifiers;
        if modifiers.control || modifiers.alt || modifiers.function {
            return;
        }
        let command = match keystroke.key.as_str() {
            "h" | "left" => Command::ResizeLeft,
            "j" | "down" => Command::ResizeDown,
            "k" | "up" => Command::ResizeUp,
            "l" | "right" => Command::ResizeRight,
            _ => return,
        };
        self.command(command, window, cx);
    }

    /// Leaving the window abandons a half-typed chord, as the TUI's prefix
    /// mode does not outlive its client, and ends resize mode.
    pub(super) fn disarm_prefix(&mut self) {
        self.prefix_armed = false;
        self.resize_mode = false;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use crate::{
        keymap::{DaemonKeys, Keymap},
        state::ConnectionStatus,
    };
    use gpui::{Keystroke, TestAppContext, VisualTestContext};
    use herdr_client::protocol::{ClientShellCommand, ClientShellCommandAction};
    use std::sync::Arc;

    /// Whether something handled the keystroke. Nothing binds `cmd-y` and
    /// the terminal ignores cmd keys, so only the prefix can claim it.
    fn press(keystroke: &str, cx: &mut VisualTestContext) -> bool {
        let handled = cx.update(|window, cx| {
            window.dispatch_keystroke(Keystroke::parse(keystroke).unwrap(), cx)
        });
        cx.run_until_parked();
        handled
    }

    #[gpui::test]
    fn the_prefix_runs_chords_and_swallows_other_keys(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        let table: toml::Table = "prefix = ['cmd+j', 'cmd+u']\ntoggle_sidebar = 'prefix+cmd+b'"
            .parse()
            .unwrap();
        view.update(cx, |view, _| {
            view.config.keybindings = Keymap::with_overrides(
                &Default::default(),
                &Default::default(),
                &DaemonKeys::from_table(Some(&table)),
            )
            .unwrap();
        });
        let state = |cx: &mut VisualTestContext| {
            view.read_with(cx, |view, _| (view.prefix_armed, view.sidebar_visible))
        };
        cx.update(|window, cx| {
            window.focus(&view.read(cx).focus.clone(), cx);
            window.draw(cx).clear(cx);
        });
        assert!(!press("cmd-y", cx));
        assert!(
            !press("cmd-b", cx),
            "the chord's key alone is not a binding"
        );
        assert_eq!(state(cx), (false, true));

        assert!(press("cmd-j", cx));
        assert_eq!(state(cx), (true, true));
        assert!(press("cmd-b", cx));
        assert_eq!(state(cx), (false, false), "the chord ran");

        // Any configured prefix arms the same chords.
        assert!(press("cmd-u", cx));
        assert_eq!(state(cx), (true, false));
        assert!(press("cmd-b", cx));
        assert_eq!(state(cx), (false, true), "the second prefix ran the chord");
        assert!(press("cmd-j", cx));
        assert!(!press("cmd-u", cx), "another prefix passes through too");
        assert_eq!(state(cx), (false, true));
        assert!(press("cmd-u", cx));
        assert!(press("cmd-b", cx));
        assert_eq!(state(cx), (false, false));

        // An unbound key after the prefix goes nowhere, as in the TUI.
        assert!(press("cmd-j", cx));
        assert!(press("cmd-y", cx));
        assert_eq!(state(cx), (false, false));
        assert!(!press("cmd-y", cx), "only the next key is claimed");

        // The prefix twice passes the second one through.
        assert!(press("cmd-j", cx));
        assert!(!press("cmd-j", cx));
        assert_eq!(state(cx), (false, false));

        assert!(press("cmd-j", cx));
        assert!(press("escape", cx));
        assert_eq!(state(cx), (false, false));
        assert!(press("cmd-j", cx));
        assert!(press("cmd-b", cx));
        assert_eq!(state(cx), (false, true));

        // From a menu's focused text field, the chord closes the menu and runs.
        view.update_in(cx, |view, window, cx| view.open_keybinds(window, cx));
        cx.run_until_parked();
        let search_focused = |cx: &mut VisualTestContext| {
            cx.update(|window, cx| {
                let view = view.read(cx);
                view.menu.page.is_some()
                    && view
                        .menu
                        .keybinds_search
                        .as_ref()
                        .is_some_and(|search| search.read(cx).focus.is_focused(window))
            })
        };
        assert!(search_focused(cx));
        assert!(press("cmd-j", cx));
        assert!(search_focused(cx), "the prefix alone leaves the menu open");
        assert!(press("cmd-b", cx));
        assert_eq!(state(cx), (false, false));
        view.read_with(cx, |view, _| assert!(view.menu.page.is_none()));

        // An unbound key there is swallowed and leaves the menu open.
        view.update_in(cx, |view, window, cx| view.open_keybinds(window, cx));
        cx.run_until_parked();
        assert!(press("cmd-j", cx));
        assert!(press("cmd-y", cx));
        assert!(search_focused(cx));
    }

    /// The shortcut reference and palette hide custom commands while the
    /// snapshot may be stale, so dispatch must not run them then either.
    #[gpui::test]
    fn custom_commands_run_only_while_connected(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        let typed = Keystroke::parse("ctrl-alt-y").unwrap();
        view.update(cx, |view, _| {
            Arc::make_mut(view.live.snapshot.as_mut().unwrap()).commands =
                vec![ClientShellCommand {
                    command_id: "plugin.y".into(),
                    description: None,
                    action: ClientShellCommandAction::PluginAction,
                    binding_label: "ctrl+alt+y".into(),
                    binding_labels: vec!["ctrl+alt+y".into()],
                }];
            for (status, runs) in [
                (ConnectionStatus::Connected, true),
                (ConnectionStatus::AwaitingSnapshot, true),
                (ConnectionStatus::Connecting, false),
                (ConnectionStatus::Disconnected, false),
                (ConnectionStatus::Detached, false),
            ] {
                view.live.status = status;
                assert_eq!(
                    view.custom_command(&typed, false).is_some(),
                    runs,
                    "{status:?}"
                );
            }
        });
    }
}
