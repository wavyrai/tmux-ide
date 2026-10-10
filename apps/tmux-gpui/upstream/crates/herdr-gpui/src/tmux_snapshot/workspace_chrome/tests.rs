#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{decode, presence::Presence};
use core::prelude::v1::test;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, mpsc},
};
fn pane(id: &str, window: Option<&str>) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: "Pane".into(),
        pane_count: None,
        window_id: window.map(str::to_owned),
        window_label: Some("Same window label".into()),
    }
}
fn make_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let focus = cx.focus_handle();
    focus.focus(window, cx);
    let mut presence = Presence::new(true);
    presence.flush(&sender);
    presence.acknowledge(1);
    let frame = Arc::new(
        decode::frame(include_bytes!("../../../../../../fixtures/snapshot.json")).unwrap(),
    );
    SnapshotView {
        presence,
        _activation: None,
        _appearance: None,
        last_system: None,
        glass: Default::default(),
        last_workspace_session: None,
        pending_session_open: None,
        frame: Some(frame.clone()),
        browsing: true,
        terminal_focus: focus,
        input_interrupted: false,
        picker: None,
        pane_actions: None,
        new_session: None,
        new_session_queued: None,
        window_reveal: Default::default(),
        resize_gesture: Default::default(),
        last_resize: None,
        marked: String::new(),
        marked_selection: None,
        input_geometry: Some((
            Bounds::new(point(px(0.), px(0.)), size(px(500.), px(500.))),
            Bounds::default(),
        )),
        input_cell_width: Some(10.),
        painted_frame: Some(frame.clone()),
        selection: None,
        divider: None,
        wheel: crate::terminal::WheelRemainder::default(),
        browser_request: 7,
        browser_state: browser::State {
            surface: browser::Surface::Workspace,
            input_ready: true,
            sessions: vec![pane("session-a", None)],
            panes: vec![
                pane("pane-a", Some("window-a")),
                pane("pane-b", Some("window-b")),
            ],
            selected_session: Some("session-a".into()),
            selected_pane: Some("pane-a".into()),
            frame: Some(frame),
            regions: serde_json::from_str(
                r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1}]"#,
            )
            .unwrap(),
            ..Default::default()
        },
        browser_commands: Some(sender),
        _browser_task: None,
        _task: None,
        painter: Rc::new(RefCell::new(
            crate::terminal_painter::TerminalPainter::default(),
        )),
    }
}

#[gpui::test]
fn application_clicks_return_to_verified_session_without_terminal_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let terminals = cx.debug_bounds("application-terminals").unwrap();
    assert_eq!(terminals.size.height, px(36.));
    cx.simulate_click(terminals.center(), Modifiers::default());
    assert!(receiver.try_recv().is_err());
    assert!(view.read_with(cx, |view, _| view.picker.is_none()));
    let home = cx.debug_bounds("application-home").unwrap();
    cx.simulate_click(home.center(), Modifiers::default());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Home { request: 8 }
    ));
    assert!(receiver.try_recv().is_err());
    assert!(view.read_with(cx, |view, _| view.frame.is_none()
        && !view.browser_state.input_ready));
    cx.update(|window, cx| {
        // Current Home catalog acknowledgement, after the transition's Loading state.
        view.update(cx, |view, _| {
            view.browser_state.home_phase = browser::HomePhase::Live;
        });
        window.draw(cx).clear(cx);
    });
    let terminals = cx.debug_bounds("application-terminals").unwrap();
    cx.simulate_click(terminals.center(), Modifiers::default());
    assert!(view.read_with(cx, |view, _| view.picker.is_none()
        && view.last_workspace_session.as_deref() == Some("session-a")));
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Session { request:9,id } if id == "session-a")
    );
    assert!(receiver.try_recv().is_err());
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
            view.browser_state.surface = browser::Surface::Home;
            view.last_workspace_session = Some("session-a".into());
            view.dispatch_application_tab(6, ApplicationTab::Terminals, window, cx);
            assert!(view.picker.is_none());
            view.browser_commands = None;
            view.dispatch_application_tab(7, ApplicationTab::Home, window, cx);
            view.dispatch_application_tab(7, ApplicationTab::Terminals, window, cx);
            assert!(view.picker.is_none());
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn separate_window_tab_click_uses_exact_identity_not_duplicate_label(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let second = cx.debug_bounds("workspace-window-1").unwrap();
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
fn metadata_only_window_tab_actual_click_selects_pane_despite_interrupted_input(
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
    let tab = cx.debug_bounds("workspace-window-0").unwrap();
    let header = cx.debug_bounds("titlebar").unwrap();
    let application_tab = cx.debug_bounds("application-terminals").unwrap();
    let status = cx.debug_bounds("tmux-status-viewport").unwrap();
    assert!(tab.size.width > px(0.) && tab.size.height > px(0.));
    assert!(tab.top() >= application_tab.bottom());
    assert!(tab.top() >= header.bottom());
    assert!(tab.bottom() <= status.top());
    cx.simulate_click(tab.center(), Modifiers::default());
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

#[gpui::test]
fn authoritative_far_window_selection_is_revealed_in_narrow_strip(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = view.browser_request;
        view.browser_state.panes = (0..12)
            .map(|index| browser::Choice {
                id: format!("pane-{index}"),
                label: format!("Pane {index}"),
                pane_count: None,
                window_id: Some(format!("window-{index}")),
                window_label: Some(format!("Window {index} with a deliberately long title")),
            })
            .collect();
        view.browser_state.selected_pane = Some("pane-0".into());
        // Catalog-only geometry: this check does not need or invent terminal pixels.
        view.browser_state.regions.clear();
        view.browser_state.frame = None;
        view.browser_state.input_ready = false;
        view.frame = None;
        view.painted_frame = None;
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // Authoritative selection can arrive from picker/navigation; rendering
            // must reveal it without dispatching another selection or terminal input.
            view.browser_state.selected_pane = Some("pane-11".into());
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    // Allow layout-dependent reveal to settle on the next normal draw.
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let strip = cx.debug_bounds("workspace-window-strip").unwrap();
    let selected = cx.debug_bounds("workspace-window-11").unwrap();
    assert!(strip.size.width > px(0.));
    assert!(selected.size.width > px(0.));
    assert!(
        selected.left() >= strip.left() && selected.right() <= strip.right(),
        "selected window must be fully visible: selected={selected:?}, strip={strip:?}"
    );
    assert!(
        receiver.try_recv().is_err(),
        "reveal must not dispatch navigation/input"
    );
    // A user deliberately scrolling away wins over unchanged output redraws.
    view.update(cx, |view, _| {
        view.window_reveal.scroll.set_offset(point(px(0.), px(0.)))
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |view, _| {
        assert_eq!(view.window_reveal.scroll.offset().x, px(0.))
    });
    // Same labels, same selected semantic window, new catalog order: resolve the
    // current index instead of retaining the old twelfth-item reveal.
    view.update(cx, |view, cx| {
        view.browser_state.panes.rotate_right(1);
        cx.notify();
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let strip = cx.debug_bounds("workspace-window-strip").unwrap();
    let selected = cx.debug_bounds("workspace-window-0").unwrap();
    assert!(selected.left() >= strip.left() && selected.right() <= strip.right());
    // Select a different semantic window, then narrow the window. Both must
    // reveal it without changing canonical selection or emitting input.
    view.update(cx, |view, cx| {
        view.browser_state.selected_pane = Some("pane-10".into());
        cx.notify();
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_resize(size(px(520.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let strip = cx.debug_bounds("workspace-window-strip").unwrap();
    let selected = cx.debug_bounds("workspace-window-11").unwrap();
    assert!(selected.left() >= strip.left() && selected.right() <= strip.right());
    assert!(receiver.try_recv().is_err());
}

#[test]
fn unmeasurable_reveal_schedules_once_then_recovers_on_measured_layout() {
    let key = RevealKey {
        session: "session".into(),
        selected: "window".into(),
        windows: vec![("window".into(), "Window".into())],
        viewport_width: px(640.),
        measured_width: px(0.),
    };
    let mut reveal = WindowReveal::default();
    assert_eq!(
        reveal.observe(key.clone(), false),
        RevealEffect::MeasureOnce
    );
    for _ in 0..100 {
        assert_eq!(reveal.observe(key.clone(), false), RevealEffect::None);
    }
    assert!(reveal.revealed.is_none());
    let measured = RevealKey {
        measured_width: px(416.),
        ..key.clone()
    };
    assert_eq!(reveal.observe(measured.clone(), true), RevealEffect::Reveal);
    assert_eq!(reveal.observe(measured, true), RevealEffect::None);
    let changed = RevealKey {
        selected: "other".into(),
        ..key
    };
    assert_eq!(
        reveal.observe(changed.clone(), false),
        RevealEffect::MeasureOnce
    );
    assert_eq!(reveal.observe(changed, false), RevealEffect::None);
}
