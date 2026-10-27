mod plugin_shortcuts;

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn enabling_does_not_replay_undrained_disabled_ingress(cx: &mut gpui::TestAppContext) {
    use crate::{config::Config, notifications::tests::notification, state::ConnectionStatus};
    use herdr_client::{
        ClientEvent,
        protocol::{SemanticNotificationKind, ServerMessage},
    };
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let inbox = view.update(cx, |view, _| {
        // This fixture has no transport; polling must not start one.
        view.endpoints[0].enabled = false;
        view.endpoints[0].connection.inbox.clone()
    });
    let mut wire = notification("disabled ingress");
    wire.kind = SemanticNotificationKind::Custom;
    for _ in 0..2 {
        view.update(cx, |view, cx| {
            view.load_gui_config_with(|| Ok((Config::default(), Default::default())), cx)
        });
        cx.run_until_parked();
        {
            let mut state = inbox.lock().unwrap();
            state.status = ConnectionStatus::Connected;
            state.apply(ClientEvent::Message(ServerMessage::SemanticNotification(
                wire.clone(),
            )));
        }
        // Enabling cannot drain this inbox; the arrival fence must survive until later polling.
        let held = inbox.lock().unwrap();
        view.update(cx, |view, cx| {
            view.load_gui_config_with(
                || {
                    let mut config = Config::default();
                    config.notifications.enabled = true;
                    config.notifications.delay_seconds = 0;
                    Ok((config, Default::default()))
                },
                cx,
            )
        });
        cx.run_until_parked();
        assert_eq!(held.notifications.len(), 1);
        view.read_with(cx, |view, _| assert!(view.config.notifications.enabled));
        drop(held);
        view.update(cx, |view, cx| {
            view.poll_endpoints(cx);
            assert!(view.endpoints[0].toasts.entries.is_empty());
        });
        let mut fresh = wire.clone();
        fresh.title = "enabled ingress".into();
        inbox
            .lock()
            .unwrap()
            .apply(ClientEvent::Message(ServerMessage::SemanticNotification(
                fresh,
            )));
        view.update(cx, |view, cx| {
            view.poll_endpoints(cx);
            assert_eq!(view.endpoints[0].toasts.entries.len(), 1);
            assert_eq!(
                view.endpoints[0].toasts.entries[0].1.title,
                "enabled ingress"
            );
            assert!(view.endpoints[0].toasts.entries[0].1.visible);
        });
    }
}

#[gpui::test]
fn enabling_system_delivery_does_not_post_the_backlog(cx: &mut gpui::TestAppContext) {
    use crate::{
        config::{Config, NotificationDelivery},
        notifications::{Notice, take_system, tests::notification},
    };
    use std::time::Instant;
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, _| {
        assert_eq!(
            view.config.notifications.delivery(),
            NotificationDelivery::Off
        );
        let mut wire = notification("while off");
        wire.kind = herdr_client::protocol::SemanticNotificationKind::Custom;
        view.endpoints[0]
            .toasts
            .receive([Notice::new(wire, Instant::now())]);
    });
    view.update(cx, |view, cx| {
        view.load_gui_config_with(
            || {
                let mut config = Config::default();
                config.notifications.system = true;
                config.notifications.delay_seconds = 0;
                let theme = config.theme(false)?;
                Ok((config, theme))
            },
            cx,
        )
    });
    cx.run_until_parked();
    view.update(cx, |view, _| {
        assert_eq!(
            view.config.notifications.delivery(),
            NotificationDelivery::System
        );
        assert!(view.endpoints[0].toasts.enabled_since.is_some());
        view.tick_toasts(false, Instant::now());
        assert!(take_system(&mut view.endpoints, view.config.notifications).is_empty());
        assert!(view.endpoints[0].toasts.entries.is_empty());
    });
}

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn notification_reload_retimes_pending_clears_disabled_and_keeps_failed_settings(
    cx: &mut gpui::TestAppContext,
) {
    use crate::{
        config::{Config, NotificationConfig},
        notifications::{Notice, tests::notification},
    };
    use std::time::Instant;
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, _| {
        view.config.terminal.size = 24.;
        view.config.notifications = NotificationConfig {
            enabled: true,
            delay_seconds: 3600,
            ..Default::default()
        };
        view.endpoints[0]
            .toasts
            .receive([Notice::new(notification("pending"), Instant::now())]);
        view.tick_toasts(false, Instant::now());
        assert!(!view.endpoints[0].toasts.entries[0].1.visible);
    });
    view.update(cx, |view, cx| {
        view.load_gui_config_with(
            || {
                let mut config = Config::default();
                config.notifications.enabled = true;
                config.notifications.delay_seconds = 0;
                config.notifications.position =
                    herdr_client::protocol::ToastHerdrPosition::TopRight;
                config.terminal.size = 18.;
                config.layout.sidebar_gap = 16.;
                config.layout.mode =
                    crate::config::LayoutMode::from(crate::config::Density::Compact);
                let theme = config.theme(false)?;
                Ok((config, theme))
            },
            cx,
        )
    });
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        assert!(view.endpoints[0].toasts.entries[0].1.visible);
        assert_eq!(view.config.notifications.delay_seconds, 0);
        assert_eq!(view.config.terminal.size, 18.);
        assert_eq!(view.configured_terminal_size, 18.);
        assert_eq!(view.config.layout.sidebar_gap, 16.);
        assert_eq!(
            view.config.layout.mode,
            crate::config::LayoutMode::from(crate::config::Density::Compact)
        );
        view.set_terminal_font_size(20., cx);
        view.load_gui_config_with(|| Err(crate::Error::MissingHome), cx);
    });
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        assert!(view.config.notifications.enabled);
        assert!(view.endpoints[0].toasts.entries[0].1.visible);
        assert_eq!(view.config.terminal.size, 20.);
        assert_eq!(view.configured_terminal_size, 18.);
        assert_eq!(view.config.layout.sidebar_gap, 16.);
        assert_eq!(
            view.config.layout.mode,
            crate::config::LayoutMode::from(crate::config::Density::Compact)
        );
        view.load_gui_config_with(|| Ok((Config::default(), Default::default())), cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.config.notifications.enabled);
        assert!(view.endpoints[0].toasts.entries.is_empty());
        assert_eq!(view.config.terminal.size, Config::default().terminal.size);
        assert_eq!(view.configured_terminal_size, view.config.terminal.size);
        assert_eq!(view.config.layout, Config::default().layout);
    });
}

#[gpui::test]
fn config_reload_toggles_tab_flags_and_preserves_them_on_failure(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    for (confirm_close_tab, show_agents) in
        [(false, true), (true, false), (false, false), (true, true)]
    {
        view.update(cx, |view, cx| {
            view.load_gui_config_with(
                move || {
                    let config = crate::config::Config {
                        confirm_close_tab,
                        show_agents,
                        ..Default::default()
                    };
                    let theme = config.theme(false)?;
                    Ok((config, theme))
                },
                cx,
            );
        });
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            assert_eq!(
                (view.config.confirm_close_tab, view.config.show_agents),
                (confirm_close_tab, show_agents)
            );
            assert!(view.config_load.is_none());
            assert!(view.local_error.is_none());
        });
        for error in [crate::Error::MissingHome, crate::Error::EmptyTheme] {
            view.update(cx, |view, cx| {
                view.load_gui_config_with(move || Err(error), cx);
            });
            cx.run_until_parked();
            view.read_with(cx, |view, _| {
                assert_eq!(
                    (view.config.confirm_close_tab, view.config.show_agents),
                    (confirm_close_tab, show_agents)
                );
                assert!(view.config_load.is_none());
                assert!(view.local_error.is_some());
            });
        }
    }
}

#[gpui::test]
fn failed_config_load_still_restores_the_saved_github_sign_in(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.avatars = Some(crate::avatars::Avatars::new());
        view.load_gui_config_with(|| Err(crate::Error::MissingHome), cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.local_error.is_some());
        // The restore is queued under the settings already in effect; the
        // next poll reads the saved credential off the UI thread.
        assert!(view.menu.github.loading_profile());
        assert_eq!(
            view.menu.github.store(),
            crate::github::Store::select(&view.config)
        );
    });
}

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn config_load_is_coherent_bounded_and_cancellable(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.load_gui_config_with(
            || {
                let config = crate::config::Config {
                    theme: "Nord".into(),
                    ..Default::default()
                };
                let theme = config.theme(false)?;
                Ok((config, theme))
            },
            cx,
        );
        view.load_gui_config_with(|| panic!("only one config load at a time"), cx);
        assert_eq!(view.config.theme, "Default");
    });
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        assert_eq!(view.config.theme, "Nord");
        assert_eq!(view.theme, view.config.theme(false).unwrap());
        assert!(view.config_load.is_none());
        assert_eq!(view.config_load_revision, 1);
        view.load_gui_config_with(|| Err(crate::Error::EmptyTheme), cx);
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert_eq!(view.config.theme, "Nord");
            assert_eq!(view.theme, view.config.theme(false).unwrap());
            assert_eq!(view.config_load_revision, 2);
            assert!(
                view.local_error
                    .as_deref()
                    .unwrap()
                    .contains("theme must not be empty")
            );
            view.load_gui_config_with(|| Ok((Default::default(), Default::default())), cx);
            view.open_theme_picker(window, cx);
            assert!(view.config_load.is_none());
        });
    });
    cx.run_until_parked();
    view.update(cx, |view, _| {
        assert_eq!(view.config.theme, "Nord");
        assert_eq!(
            view.config_load_revision, 2,
            "cancelled loads are not acknowledged"
        );
    });
}

#[test]
fn shortcut_search_matches_labels_keys_and_sections() {
    for query in ["", "pane close", "CMD+W", "cmd-w", "workspaces"] {
        assert!(super::shortcut_matches(
            query,
            "cmd-w",
            "Close Pane",
            "WORKSPACES & PANES"
        ));
    }
    assert!(!super::shortcut_matches(
        "zoom",
        "cmd-w",
        "Close Pane",
        "WORKSPACES & PANES"
    ));
    assert!(super::shortcut_matches(
        "cmd shift p",
        "cmd-shift-p",
        "Command Palette",
        "APPLICATION"
    ));
    assert!(!super::shortcut_matches(
        "cmd+p",
        "cmd-d",
        "Split Right",
        "WORKSPACES & PANES"
    ));
}

#[test]
fn keycaps_split_modifiers_from_the_key() {
    let caps = |keystroke| super::keycaps(keystroke).collect::<Vec<_>>();
    assert_eq!(caps("cmd-shift-t"), ["Cmd", "Shift", "T"]);
    assert_eq!(caps("cmd--"), ["Cmd", "-"]);
    assert_eq!(caps("cmd-+"), ["Cmd", "+"]);
    assert_eq!(caps("f5"), ["F5"]);
    assert_eq!(caps("ctrl-b c"), ["Ctrl", "B", "C"]);
    assert_eq!(caps("ctrl-b -"), ["Ctrl", "B", "-"]);
    assert_eq!(caps("ctrl-b shift-tab"), ["Ctrl", "B", "Shift", "Tab"]);
}

/// A saved `[keybindings]` change must reach the live keymap, the palette,
/// and the keybindings page without restarting, and keep the console keys.
#[gpui::test]
#[allow(clippy::unwrap_used)]
fn config_reload_rebinds_the_keymap(cx: &mut gpui::TestAppContext) {
    use crate::{
        Command, RunCommand,
        config::Config,
        keymap::{Binding, Keymap},
    };
    use gpui::Keystroke;

    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|_, cx| crate::bind_keys(cx));
    let runs = |keystroke: &str, command: Command, cx: &mut gpui::VisualTestContext| {
        cx.update(|_, cx| {
            cx.key_bindings()
                .borrow()
                .all_bindings_for_input(&[Keystroke::parse(keystroke).unwrap()])
                .iter()
                .any(|binding| binding.action().partial_eq(&RunCommand { command }))
        })
    };
    assert!(runs("cmd-t", Command::Tab, cx));
    assert!(!runs("cmd-n", Command::Tab, cx));
    assert!(runs("cmd-shift-n", Command::Workspace, cx));

    view.update(cx, |view, cx| {
        view.load_gui_config_with(
            || {
                let overrides = [
                    ("new_workspace", Binding::One("cmd-t".into())),
                    ("toggle_sidebar", Binding::Many(Vec::new())),
                ]
                .into_iter()
                .map(|(name, binding)| (name.to_owned(), binding))
                .collect();
                let config = Config {
                    keybindings: Keymap::with_overrides(
                        &overrides,
                        &Default::default(),
                        &crate::keymap::DaemonKeys::default(),
                    )?,
                    ..Config::default()
                };
                Ok((config, Default::default()))
            },
            cx,
        )
    });
    cx.run_until_parked();
    assert!(runs("cmd-t", Command::Workspace, cx));
    assert!(!runs("cmd-t", Command::Tab, cx));
    assert!(!runs("cmd-shift-n", Command::Workspace, cx));
    assert!(!runs("cmd-b", Command::ToggleSidebar, cx));
    cx.update(|_, cx| {
        let keymap = cx.key_bindings();
        let keymap = keymap.borrow();
        let console = keymap.all_bindings_for_input(&[Keystroke::parse("cmd-l").unwrap()]);
        assert_eq!(console.len(), 1);
    });
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.keybindings.primary(Command::Workspace), "cmd-t");
        // Only Herdr's default chord is left once cmd-t moves away.
        assert_eq!(view.config.keybindings.primary(Command::Tab), "ctrl-b c");
    });

    view.update(cx, |view, cx| {
        view.load_gui_config_with(|| Ok((Config::default(), Default::default())), cx)
    });
    cx.run_until_parked();
    assert!(runs("cmd-t", Command::Tab, cx));
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.keybindings, Keymap::default())
    });
}
