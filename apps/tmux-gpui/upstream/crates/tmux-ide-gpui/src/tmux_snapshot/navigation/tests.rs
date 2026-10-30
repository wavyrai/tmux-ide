#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{SnapshotView, browser};
use core::prelude::v1::test;
use gpui::{prelude::*, *};
use std::sync::mpsc;

fn pane(id: &str, window: Option<&str>) -> Choice {
    Choice {
        id: id.into(),
        label: "Pane".into(),
        pane_count: None,
        window_id: window.map(str::to_owned),
        browser_icon: None,
        window_label: Some("Same name".into()),
    }
}

#[test]
fn duplicate_names_keep_distinct_windows_and_selected_pane() {
    let choices = windows(
        &[
            pane("a", Some("one")),
            pane("b", Some("two")),
            pane("c", Some("one")),
        ],
        Some("c"),
    );
    assert_eq!(choices.len(), 2);
    assert_eq!(choices[0].id, "one");
    assert_eq!(choices[0].pane, "c");
    assert!(choices[0].selected);
    assert_eq!(choices[1].id, "two");
    assert_eq!(choices[1].pane, "b");
    assert!(!choices[1].selected);
}

#[test]
fn absent_window_identity_and_stale_selection_do_not_invent_targets() {
    let choices = windows(&[pane("a", None), pane("b", Some("two"))], Some("removed"));
    assert_eq!(choices.len(), 1);
    assert_eq!(choices[0].pane, "b");
    assert!(!choices[0].selected);
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
fn window_dispatch_rejects_stale_identity_without_retiring_current_frame(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let original = view.browser_state.clone();
            let frame = view.frame.clone().unwrap();
            let target = WindowChoice {
                id: "window-b".into(),
                label: "Same name".into(),
                pane: "pane-b".into(),
                selected: false,
            };
            // Exact method called by the real listener; simulate_click may redraw
            // between mouse down/up and cannot preserve an obsolete listener.
            for case in ["request", "removed pane", "moved window", "session"] {
                view.browser_state = original.clone();
                let mut request = 7;
                let mut session = "session-a";
                match case {
                    "request" => request = 6,
                    "removed pane" => view.browser_state.panes.retain(|p| p.id != "pane-b"),
                    "moved window" => {
                        view.browser_state.panes[1].window_id = Some("window-c".into())
                    }
                    "session" => session = "old-session",
                    _ => unreachable!(),
                }
                view.select_window(request, session, &target, window, cx);
                assert_eq!(view.browser_request, 7, "{case}");
                assert!(view.browser_state.input_ready, "{case}");
                assert_eq!(
                    view.browser_state.selected_pane.as_deref(),
                    Some("pane-a"),
                    "{case}"
                );
                assert!(
                    view.frame.as_ref().is_some_and(|f| (f).same(&frame)),
                    "{case}"
                );
                assert!(receiver.try_recv().is_err(), "{case}: no command");
            }
            view.browser_state = original;
            view.select_window(7, "session-a", &target, window, cx);
            assert_eq!(view.browser_request, 8);
            assert!(view.frame.is_none());
            assert!(!view.browser_state.input_ready);
        });
    });
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Pane {request:8,id} if id == "pane-b")
    );
    assert!(receiver.try_recv().is_err());
}
