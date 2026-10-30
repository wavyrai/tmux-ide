#![allow(clippy::unwrap_used)]
use super::*;
mod attention;
mod commands;
mod direct_navigation;
mod fleet;
mod fleet_disconnect;
mod fleet_retry;
mod help;
mod machine;
mod navigation_keys;
mod popover;
mod saved_machines;
mod session_continuation;
mod session_history;
mod session_popover;
mod session_tabs;
use crate::tmux_snapshot::presence::Presence;
use core::prelude::v1::test;
use std::sync::{Arc, mpsc};
fn choice(id: &str, label: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: label.into(),
        pane_count: None,
        window_id: None,
        browser_icon: None,
        window_label: None,
    }
}
/// Fills the one-slot command queue, then `submit`s a form: it must show an
/// error and send nothing past the filler.
pub(super) fn assert_full_queue_refused(
    view: &mut SnapshotView,
    receiver: &mpsc::Receiver<browser::Command>,
    submit: impl FnOnce(&mut SnapshotView),
) {
    // An earlier refusal may have left its own error; this one must set it again.
    if let Some(picker) = view.picker.as_mut() {
        picker.error = None;
    }
    view.browser_commands
        .as_ref()
        .unwrap()
        .try_send(browser::Command::Home { request: 99 })
        .unwrap();
    submit(view);
    assert!(view.picker.as_ref().unwrap().error.is_some());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Home { request: 99 }
    ));
    assert!(receiver.try_recv().is_err());
}

/// A form prepared by `prepare`, focused by `keys` on its Enter target, whose
/// request then goes stale: the Enter keyup and every button in `buttons` must
/// leave it open (`open`) and send nothing.
pub(super) fn assert_stale_form_inert(
    cx: &mut TestAppContext,
    prepare: fn(&mut SnapshotView, &mut Window, &mut Context<SnapshotView>),
    typed: Option<&str>,
    keys: &str,
    buttons: &[&'static str],
    open: fn(&SnapshotView) -> bool,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    if let Some(typed) = typed {
        cx.simulate_input(typed);
    }
    cx.simulate_keystrokes(keys);
    cx.update(|_, cx| view.update(cx, |v, _| v.browser_request += 1));
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    assert!(view.read_with(cx, |v, _| open(v)), "{keys}: keyup");
    cx.update(|w, cx| w.draw(cx).clear(cx));
    for id in buttons {
        let bounds = cx.debug_bounds(id).unwrap();
        cx.simulate_click(bounds.center(), Modifiers::default());
        assert!(view.read_with(cx, |v, _| open(v)), "{keys}: {id}");
    }
    assert!(receiver.try_recv().is_err(), "{keys}: no command");
}

/// A Workspace whose selected pane offers pane actions, with input interrupted.
pub(super) fn ready_pane(view: &mut SnapshotView, zoomed: bool) {
    view.browser_state.surface = browser::Surface::Workspace;
    view.browser_state.request = view.browser_request;
    view.browser_state.selected_session = Some("session-a".into());
    view.browser_state.pane_actions = Some(browser::PaneActions {
        token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
        id: "pane-a".into(),
        zoomed,
    });
    view.input_interrupted = true;
}

pub(super) fn make_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    crate::tmux_snapshot::fit_test_support::fixture_view(
        window,
        cx,
        sender,
        7,
        browser::State {
            input_ready: true,
            sessions: vec![choice("session-a", "Session Alpha")],
            panes: vec![choice("pane-a", "Editor")],
            ..Default::default()
        },
    )
}

#[test]
fn ranking_is_bounded_and_identity_based() {
    let state = browser::State {
        sessions: (0..100)
            .map(|i| choice(&format!("id-{i}"), "same label"))
            .collect(),
        ..Default::default()
    };
    assert_eq!(rows(&state, "").len(), 32);
    assert_eq!(
        rows(&state, "^Session")[0].target,
        Target::Session("id-0".into())
    );
    assert!(!current(&state, &Target::Pane("id-0".into())));
    assert!(rows(&state, "notpresent").is_empty());
}
#[gpui::test]
fn search_input_owns_typing_composition_and_selection_revalidates(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.open_picker(window, cx));
        window.draw(cx).clear(cx);
    });
    cx.simulate_input("Editor");
    view.read_with(cx, |view, cx| {
        assert_eq!(
            view.picker.as_ref().unwrap().search.read(cx).text(),
            "Editor"
        )
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let search = view.picker.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", Some(1..1), window, cx)
            });
            for key in ["enter", "escape", "cmd-k"] {
                view.picker_key(
                    &crate::tmux_snapshot::fit_test_support::key_down(key),
                    window,
                    cx,
                );
                assert!(view.picker.is_some());
            }
            view.replace_text_in_range(None, "must not reach terminal", window, cx);
            view.queue_input(
                crate::tmux_snapshot::keys::Input::Paste("blocked".into()),
                cx,
            );
            view.browser_state.panes.clear();
            view.choose_picker(Target::Pane("pane-a".into()), window, cx);
            assert_eq!(view.browser_request, 7);
            view.close_picker(window, cx);
            assert!(view.terminal_focus.is_focused(window));
        })
    });
    assert!(receiver.try_iter().all(|command| matches!(
        command,
        browser::Command::Presence { .. }
            | browser::Command::Input {
                input: crate::tmux_snapshot::keys::Input::Resize { .. },
                ..
            }
    )));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker(window, cx);
            view.choose_picker(Target::Session("session-a".into()), window, cx);
            assert!(view.picker.is_none());
        })
    });
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::Session{id,..} if id=="session-a")
    );
}

#[gpui::test]
fn paste_escape_and_catalog_retirement_preserve_input_latch(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.input_interrupted = true;
            view.open_picker(window, cx);
        });
        cx.write_to_clipboard(ClipboardItem::new_string("Editor".into()));
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-v");
    view.read_with(cx, |view, cx| {
        assert_eq!(
            view.picker.as_ref().unwrap().search.read(cx).text(),
            "Editor"
        )
    });
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_none());
        assert!(view.input_interrupted);
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker(window, cx);
            view.browser_request += 1;
            view.refresh_picker(cx);
            assert!(view.picker.is_none());
            view.open_picker(window, cx);
            view.browser_commands = None;
            view.refresh_picker(cx);
            assert!(view.picker.is_none());
            assert!(view.input_interrupted);
        })
    });
    assert!(receiver.try_iter().all(|command| !matches!(
        command,
        browser::Command::Input {
            input: crate::tmux_snapshot::keys::Input::Text(_)
                | crate::tmux_snapshot::keys::Input::Paste(_)
                | crate::tmux_snapshot::keys::Input::Key(_)
                | crate::tmux_snapshot::keys::Input::Bytes(_),
            ..
        }
    )));
}

#[gpui::test]
fn shortcut_opens_from_unselected_no_focus_and_after_selection_blur(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        window.blur(cx);
        view.frame = None;
        view.browser_state = browser::State {
            sessions: vec![choice("session-a", "Session Alpha")],
            ..Default::default()
        };
        view.presence = Presence::new(true);
        view
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-k");
    view.read_with(cx, |view, _| {
        assert!(
            view.picker.is_some(),
            "initial unfocused browser must receive CmdK"
        )
    });
    cx.simulate_input("Session");
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_none());
        assert!(!view.browser_state.input_ready);
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-k");
    view.read_with(cx, |view, _| {
        assert!(
            view.picker.is_some(),
            "selection blur must retain browser shortcuts"
        )
    });
    cx.simulate_keystrokes("escape");
    cx.simulate_input("must not enter terminal");
    assert!(receiver.try_iter().all(|command| matches!(
        command,
        browser::Command::Presence { .. } | browser::Command::Session { .. }
    )));
}

#[gpui::test]
fn theme_picker_isolated_and_selection_waits_for_publication(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.update(|window,cx| {
        view.update(cx,|view,cx| {
            view.browser_state.appearance=Some(serde_json::from_value(serde_json::json!({
                "selected":"dark","system":"dark","error":null,
                "theme":{"canvas":1,"background":2,"foreground":3,"cursor":4,"surface":5,"active":6,"muted":7,"accent":8,"palette":vec![9;256]},
                "options":[{"id":"dark","name":"Dark"},{"id":"light","name":"Light"}]
            })).unwrap());
            view.open_theme_picker(window,cx);
        });
        window.draw(cx).clear(cx);
    });
    while receiver.try_recv().is_ok() {}
    cx.simulate_input("Light");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert_eq!(
                view.picker.as_ref().unwrap().search.read(cx).text(),
                "Light"
            );
            let request = view.browser_request;
            let pane = view.browser_state.selected_pane.clone();
            view.choose_picker(Target::Theme("light".into()), window, cx);
            assert_eq!(view.browser_request, request);
            assert_eq!(view.browser_state.selected_pane, pane);
            assert_eq!(
                view.browser_state.appearance.as_ref().unwrap().selected,
                "dark"
            );
            let search = view.picker.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", None, window, cx)
            });
            view.picker_key(
                &crate::tmux_snapshot::fit_test_support::key_down("enter"),
                window,
                cx,
            );
            assert!(view.picker.is_some());
            assert!(view.marked.is_empty());
        })
    });
    assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Theme{id} if id=="light"));
    assert!(receiver.try_recv().is_err());
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let query = view
                .picker
                .as_ref()
                .unwrap()
                .search
                .read(cx)
                .text()
                .to_owned();
            let interrupted = view.input_interrupted;
            view.browser_state.appearance.as_mut().unwrap().selected = "light".into();
            view.refresh_picker(cx);
            assert_eq!(view.picker.as_ref().unwrap().search.read(cx).text(), query);
            assert_eq!(view.input_interrupted, interrupted);
            assert_eq!(view.theme().background, 2);
        })
    });
    drop(receiver);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.choose_picker(Target::Theme("dark".into()), window, cx);
            assert_eq!(
                view.picker.as_ref().unwrap().error,
                Some("Theme command queue unavailable — try again")
            );
            assert_eq!(
                view.browser_state.appearance.as_ref().unwrap().selected,
                "light"
            );
        })
    });
}

#[gpui::test]
fn system_notifications_are_change_only_and_do_not_select(cx: &mut TestAppContext) {
    use crate::tmux_snapshot::appearance::System;
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let request = view.browser_request;
            view.publish_system(System::Dark);
            view.publish_system(System::Dark);
            view.publish_system(System::Light);
            view.publish_system(System::Light);
            assert_eq!(view.browser_request, request);
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Appearance {
            system: System::Dark
        }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Appearance {
            system: System::Light
        }
    ));
    assert!(receiver.try_recv().is_err());
}

mod machine_management;

mod pane_commands;

mod fleet_servers;

mod machine_remove;

mod attention_context;

mod machine_edit;

mod pane_close;

mod new_agent;

mod sidebar_visibility;

mod fonts;
mod header_scope;
mod reference;

#[path = "tests/font_controls.rs"]
mod font_controls;
#[path = "tests/font_listing.rs"]
mod font_listing;

mod unavailable_window_control;

mod scoped_surface;

mod developer_mode;

mod diagnostics;

mod pane_shortcuts;
