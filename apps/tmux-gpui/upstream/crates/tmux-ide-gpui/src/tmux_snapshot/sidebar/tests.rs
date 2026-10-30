#![allow(clippy::unwrap_used)]
use super::*;
#[path = "control_focus_tests.rs"]
mod control_focus_tests;
#[path = "keyboard_tests.rs"]
mod keyboard_tests;
use crate::tmux_snapshot::{SnapshotView, presence::Presence};
use core::prelude::v1::test;
use std::sync::mpsc;
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
            sessions: vec![
                choice("session-a", "Same name"),
                choice("session-b", "Same name"),
            ],
            panes: vec![choice("pane-a", "Editor")],
            selected_session: Some("session-a".into()),
            ..Default::default()
        },
    )
}

#[test]
fn sessions_are_the_only_rows_and_identity_does_not_follow_labels() {
    let state = browser::State {
        sessions: vec![choice("s1", "same"), choice("s2", "same")],
        selected_session: Some("s2".into()),
        panes: vec![choice("p1", "editor"), choice("p2", "shell")],
        selected_pane: Some("p2".into()),
        ..Default::default()
    };
    let rows = rows(&state);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].target, Some(Target::Session("s1".into())));
    assert_eq!(rows[1].target, Some(Target::Session("s2".into())));
    assert!(!rows[0].selected);
    assert!(rows[1].selected);
    assert!(!current(&state, &Target::Session("same".into())));
    // Window-strip routing retains the exact selected-session/pane fence.
    assert!(current(
        &state,
        &Target::Pane {
            session: "s2".into(),
            id: "p1".into()
        }
    ));
    assert!(!current(
        &state,
        &Target::Pane {
            session: "s1".into(),
            id: "p1".into()
        }
    ));
    let mut removed = state;
    removed.sessions.clear();
    assert!(super::rows(&removed).is_empty());
    assert!(!current(&removed, &Target::Session("s2".into())));
    assert!(!current(
        &removed,
        &Target::Pane {
            session: "s2".into(),
            id: "p1".into()
        }
    ));
}

#[gpui::test]
fn actual_session_click_routes_exact_id_and_long_labels_fit(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|_, cx| cx.set_global(crate::sidebar::layout_tests::PaintedProbes::default()));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            for session in &mut view.browser_state.sessions {
                session.label = "界😀 session ".repeat(20);
                session.pane_count = Some(9_007_199_254_740_991);
            }
        });
        window.draw(cx).clear(cx);
    });
    for (row, label) in [
        ("tmux-sidebar-row-0", "tmux-sidebar-label-0"),
        ("tmux-sidebar-row-1", "tmux-sidebar-label-1"),
    ] {
        let row = cx.debug_bounds(row).unwrap();
        let label = cx.debug_bounds(label).unwrap();
        assert!(row.left() >= px(0.) && row.right() <= px(224.));
        assert!(row.size.height > px(0.));
        assert!(row.left() <= label.left());
        assert!(label.right() <= row.right());
        assert!(label.size.width > px(0.));
    }
    for (count, row) in [
        ("tmux-sidebar-count-0", "tmux-sidebar-row-0"),
        ("tmux-sidebar-count-1", "tmux-sidebar-row-1"),
    ] {
        let count = cx.debug_bounds(count).unwrap();
        let row = cx.debug_bounds(row).unwrap();
        assert!(count.left() >= row.left() && count.right() <= row.right());
    }
    assert!(cx.debug_bounds("tmux-sidebar-row-2").is_none());
    cx.update(|_, cx| {
        let probes = &cx.global::<crate::sidebar::layout_tests::PaintedProbes>().0;
        let probe = probes.get(&"界😀 session ".repeat(20)).unwrap();
        assert!(probe.bounds.left() >= px(0.) && probe.bounds.right() <= px(224.));
        assert!(probe.mask.right() <= px(224.));
        assert!(probe.width > px(0.));
    });
    receiver.try_iter().for_each(drop);
    let session = cx.debug_bounds("tmux-sidebar-row-1").unwrap();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let frame = view.frame.clone().unwrap();
            view.select_sidebar(6, &Target::Session("session-b".into()), window, cx);
            view.select_sidebar(7, &Target::Session("removed".into()), window, cx);
            let sender = view.browser_commands.take();
            view.select_sidebar(7, &Target::Session("session-b".into()), window, cx);
            view.browser_commands = sender;
            assert_eq!(view.browser_request, 7);
            assert!((view.frame.as_ref().unwrap()).same(&frame));
            assert!(view.browser_state.input_ready);
        })
    });
    assert!(
        receiver.try_recv().is_err(),
        "stale listeners cannot select"
    );
    cx.simulate_click(session.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::Session{request:8,id} if id=="session-b")
    );
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| assert!(!view.browser_state.input_ready));
}

#[path = "fleet_tests.rs"]
mod fleet_tests;
#[path = "workspace_agents.rs"]
mod workspace_agents;

#[path = "fleet_agent_tests.rs"]
mod fleet_agent_tests;

#[path = "narrow_layout_tests.rs"]
mod narrow_layout_tests;

#[path = "reveal_tests.rs"]
mod reveal_tests;

#[path = "session_design_tests.rs"]
mod session_design_tests;

#[path = "agents_ink_tests.rs"]
mod agents_ink_tests;

#[path = "footer_tests.rs"]
mod footer_tests;
