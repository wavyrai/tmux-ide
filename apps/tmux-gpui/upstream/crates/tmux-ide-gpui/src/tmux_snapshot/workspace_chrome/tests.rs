#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use std::sync::{Arc, mpsc};
fn pane(id: &str, window: Option<&str>) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: "Pane".into(),
        pane_count: None,
        window_id: window.map(str::to_owned),
        browser_icon: None,
        display_name_source: None,
        window_label: Some("Same window label".into()),
    }
}
fn make_view(
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
            request: 7,
            surface: browser::Surface::Workspace,
            input_ready: true,
            sessions: vec![pane("session-a", None)],
            panes: vec![
                pane("pane-a", Some("window-a")),
                pane("pane-b", Some("window-b")),
            ],
            selected_session: Some("session-a".into()),
            ..Default::default()
        },
    )
}

#[gpui::test]
fn home_and_browse_clicks_do_not_send_terminal_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    // Home is the sidebar's first row now (#746).
    assert!(cx.debug_bounds("application-home").is_none());
    let home = cx.debug_bounds("tmux-sidebar-home").unwrap();
    let sidebar = cx.debug_bounds("tmux-sidebar-viewport").unwrap();
    assert!(home.left() >= sidebar.left() && home.right() <= sidebar.right());
    cx.simulate_click(home.center(), Modifiers::default());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Home { request: 8 }
    ));
    assert!(receiver.try_recv().is_err());
    assert!(view.read_with(cx, |view, _| view.frame.is_none()
        && !view.browser_state.input_ready));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.request = view.browser_request;
            view.browser_state.home_phase = browser::HomePhase::Live;
        });
        window.draw(cx).clear(cx);
    });
    let browse = cx.debug_bounds("application-new-session").unwrap();
    cx.simulate_click(browse.center(), Modifiers::default());
    assert!(view.read_with(cx, |view, _| view.new_session.is_none()));
    assert!(
        receiver.try_recv().is_err(),
        "unavailable creation must not send terminal input"
    );
}

#[gpui::test]
fn stale_application_listener_and_disconnected_controls_are_inert(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // Exercise the dispatch used by actual listeners with a retained request;
            // GPUI may redraw between simulated mouse-down and mouse-up.
            view.dispatch_application_tab(6, ApplicationTab::Home, window, cx);
            assert_eq!(view.browser_request, 7);
            assert!(view.frame.is_some());
            view.browser_commands = None;
            view.dispatch_application_tab(7, ApplicationTab::Home, window, cx);
            view.dispatch_application_tab(7, ApplicationTab::Terminals, window, cx);
            assert!(view.picker.is_none());
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn separate_window_pane_row_click_uses_exact_identity_not_duplicate_label(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    // Windows are listed in the sidebar now (#746); both carry the same label.
    assert!(cx.debug_bounds("workspace-window-1").is_none());
    let second = cx.debug_bounds("tmux-sidebar-pane:pane-b").unwrap();
    cx.simulate_click(second.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Pane { request:8,id } if id == "pane-b")
    );
    assert!(receiver.try_recv().is_err());
    assert!(!view.read_with(cx, |view, _| view.browser_state.input_ready));
}

#[gpui::test]
fn absent_or_replaced_remembered_session_opens_picker_without_replay(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.surface = browser::Surface::Home;
            view.browser_state.selected_session = None;
            view.browser_state.selected_pane = None;
            view.browser_state.input_ready = false;
            view.frame = None;
            for remembered in [None, Some("retired-session".to_owned())] {
                view.picker = None;
                view.last_workspace_session = remembered;
                // Same display label in the replacement catalog cannot authorize old ID.
                view.browser_state.sessions = vec![pane("replacement-session", None)];
                view.dispatch_application_tab(7, ApplicationTab::Terminals, window, cx);
                assert!(view.picker.is_some());
                assert_eq!(view.browser_request, 7);
                assert!(!view.browser_state.input_ready);
                assert!(receiver.try_recv().is_err());
            }
        })
    });
}

#[gpui::test]
fn refresh_remembers_verified_selection_and_closed_channel_retires_authority(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select(Selection::Refresh, window, cx);
            assert_eq!(view.last_workspace_session.as_deref(), Some("session-a"));
            assert_eq!(view.browser_request, 8);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Refresh { request: 8 }
            ));
            // An unverified selection must never replace the remembered verified ID.
            view.browser_state.selected_session = Some("foreign-session".into());
            view.select(Selection::Home, window, cx);
            assert_eq!(view.last_workspace_session.as_deref(), Some("session-a"));
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Home { request: 9 }
            ));
        })
    });
    assert!(receiver.try_recv().is_err());
    drop(receiver);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.home_phase = browser::HomePhase::Live;
            view.dispatch_application_tab(9, ApplicationTab::Terminals, window, cx);
            assert_eq!(view.browser_request, 10);
            assert!(view.browser_commands.is_none());
            assert!(view.frame.is_none());
            assert_eq!(view.browser_state.surface, browser::Surface::Home);
            assert!(!view.browser_state.input_ready);
        })
    });
}

#[gpui::test]
fn retained_home_catalog_cannot_reopen_session_before_live_ack(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.surface = browser::Surface::Home;
            view.last_workspace_session = Some("session-a".into());
            view.browser_state.selected_session = None;
            view.browser_state.selected_pane = None;
            view.browser_state.input_ready = false;
            view.frame = None;
            for phase in [browser::HomePhase::Loading, browser::HomePhase::Unavailable] {
                view.picker = None;
                view.browser_state.home_phase = phase;
                view.dispatch_application_tab(7, ApplicationTab::Terminals, window, cx);
                assert_eq!(view.browser_request, 7);
                assert_eq!(view.browser_state.surface, browser::Surface::Home);
                assert!(!view.browser_state.input_ready);
                assert!(receiver.try_recv().is_err());
            }
        })
    });
}

#[gpui::test]
fn metadata_only_pane_row_actual_click_selects_pane_despite_interrupted_input(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.selected_pane = None;
        view.browser_state.frame = None;
        view.browser_state.regions.clear();
        view.browser_state.input_ready = false;
        view.browser_state.status = "Choose a pane or window".into();
        view.frame = None;
        view.painted_frame = None;
        view.input_geometry = None;
        view.input_cell_width = None;
        view.input_interrupted = true;
        window.blur(cx);
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    assert!(view.read_with(cx, |view, _| {
        view.browser_state.selected_session.as_deref() == Some("session-a")
            && view.browser_state.selected_pane.is_none()
            && view.frame.is_none()
            && view.input_interrupted
    }));
    let row = cx.debug_bounds("tmux-sidebar-pane:pane-a").unwrap();
    assert!(row.size.width > px(0.) && row.size.height > px(0.));
    cx.simulate_click(row.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Pane { request: 8, id } if id == "pane-a")
    );
    assert!(
        receiver.try_recv().is_err(),
        "navigation must not send terminal input or resize"
    );
    assert!(
        view.read_with(cx, |view, _| {
            view.browser_request == 8
                && view.input_interrupted
                && view.frame.is_none()
                && !view.browser_state.input_ready
        }),
        "pane navigation must not rearm interrupted input or fabricate a frame"
    );
}

#[path = "titlebar_tabs.rs"]
mod titlebar_tabs;

#[gpui::test]
fn windows_are_sidebar_subheadings_not_titlebar_tabs(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    assert!(cx.debug_bounds("workspace-window-0").is_none());
    // New window is in the menu bar (Cmd-T), not the title bar.
    assert!(cx.debug_bounds("workspace-window-strip").is_none());
    assert!(cx.debug_bounds("workspace-new-window").is_none());
    let a = cx.debug_bounds("tmux-sidebar-pane:pane-a").unwrap();
    let b = cx.debug_bounds("tmux-sidebar-pane:pane-b").unwrap();
    let sidebar = cx.debug_bounds("tmux-sidebar-viewport").unwrap();
    assert!(a.left() >= sidebar.left() && a.right() <= sidebar.right());
    assert!(a.bottom() <= b.top(), "panes follow the window order");
    assert!(receiver.try_recv().is_err(), "drawing never navigates");
}
