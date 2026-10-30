#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::presence::Presence;
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
            surface: browser::Surface::Home,
            home_phase: browser::HomePhase::Live,
            input_ready: true,
            sessions: vec![choice("session-a", "Session Alpha")],
            panes: vec![choice("pane-a", "Editor")],
            selected_session: Some("session-a".into()),
            ..Default::default()
        },
    )
}

#[test]
fn phase_and_catalog_are_truthful_without_inventing_counts_or_targets() {
    let mut state = browser::State {
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Loading,
        sessions: vec![choice("one", "same"), choice("two", "same")],
        ..Default::default()
    };
    assert_eq!(summary(&state, true), "Loading sessions…");
    assert!(!current(&state, true, 7, 7, "one"));
    state.home_phase = browser::HomePhase::Unavailable;
    assert_eq!(summary(&state, true), "Session catalog unavailable");
    assert!(!current(&state, true, 7, 7, "one"));
    state.home_phase = browser::HomePhase::Live;
    assert_eq!(summary(&state, true), "2 live sessions");
    assert!(current(&state, true, 7, 7, "two"));
    assert!(!current(&state, true, 7, 7, "same"));
    assert!(!current(&state, true, 8, 7, "two"));
    assert!(!current(&state, false, 7, 7, "two"));
    assert_eq!(summary(&state, false), "Session catalog unavailable");
    state.sessions.clear();
    assert_eq!(summary(&state, true), "No live sessions");
    assert!(!current(&state, true, 7, 7, "two"));
}

type Dispatch = fn(&mut SnapshotView, u64, &mut Window, &mut Context<SnapshotView>);

/// Every entry point that carries the request it was offered under, from
/// Home: a stale request (6 against 7) sends nothing, and the current one sends.
#[gpui::test]
fn stale_request_is_refused_by_each_direct_entry_point(cx: &mut TestAppContext) {
    const RETRY: &str = "fe470cdc-82bb-48d5-8fc4-1fa68025c8e4";
    let rows: [(&str, Dispatch); 4] = [
        ("home_select", |v, request, w, cx| {
            v.home_select(request, "session-a", w, cx)
        }),
        ("home_refresh", |v, request, w, cx| {
            v.home_refresh(request, w, cx)
        }),
        ("dispatch_application_tab", |v, request, w, cx| {
            v.last_workspace_session = Some("session-a".into());
            v.dispatch_application_tab(
                request,
                crate::tmux_snapshot::workspace_chrome::ApplicationTab::Terminals,
                w,
                cx,
            )
        }),
        ("retry_fleet_machine", |v, request, w, cx| {
            v.browser_state.fleet = Some(
                serde_json::from_value(serde_json::json!({
                    "groups":[{"id":"remote","label":"Build","state":"disconnected",
                        "conflict":false,"retry":RETRY,"omittedSessions":0,"sessions":[]}],
                    "omittedGroups":0
                }))
                .unwrap(),
            );
            v.retry_fleet_machine(request, RETRY, w, cx);
        }),
    ];
    for (name, dispatch) in rows {
        let (sender, receiver) = mpsc::sync_channel(64);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        receiver.try_iter().for_each(drop);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                dispatch(view, 6, window, cx);
                assert_eq!(view.browser_request, 7, "{name}: request moved");
                assert!(receiver.try_recv().is_err(), "{name}: stale request sent");
                dispatch(view, 7, window, cx);
                assert!(
                    receiver.try_recv().is_ok(),
                    "{name}: current request did not send"
                );
            })
        });
    }
}

#[gpui::test]
fn home_dispatch_fences_request_surface_catalog_and_channel(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        let frame = view.frame.clone().unwrap();
        view.home_select(7, "Session Alpha", window, cx);
        view.browser_state.surface = browser::Surface::Workspace;
        view.home_select(7, "session-a", window, cx);
        view.home_refresh(7, window, cx);
        view.browser_state.surface = browser::Surface::Home;
        view.browser_state.home_phase = browser::HomePhase::Unavailable;
        view.home_select(7, "session-a", window, cx);
        view.browser_state.home_phase = browser::HomePhase::Live;
        let sender = view.browser_commands.take();
        view.home_select(7, "session-a", window, cx);
        view.home_refresh(7, window, cx);
        view.browser_commands = sender;
        assert_eq!(view.browser_request, 7);
        assert!((view.frame.as_ref().unwrap()).same(&frame));
        assert!(view.browser_state.input_ready);
        assert!(receiver.try_recv().is_err());
        view.home_select(7, "session-a", window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Session { request: 8, id } if id == "session-a"));
        assert!(view.frame.is_none());
        assert!(!view.browser_state.input_ready);
        assert!(receiver.try_recv().is_err());
    }));
}

#[path = "tests/render.rs"]
mod render;

#[path = "tests/filters.rs"]
mod filters;

#[path = "tests/fleet.rs"]
mod fleet;

#[path = "tests/filter_keys.rs"]
mod filter_keys;

#[path = "tests/context.rs"]
mod context;

#[path = "tests/preferences.rs"]
mod preferences;

#[path = "tests/fleet_admission.rs"]
mod fleet_admission;

#[path = "tests/action_admission.rs"]
mod action_admission;

#[path = "tests/fleet_layout.rs"]
mod fleet_layout;

#[path = "tests/columns.rs"]
mod columns;

#[path = "tests/local_setup.rs"]
mod local_setup;

#[path = "tests/ink.rs"]
mod ink;

#[path = "tests/states.rs"]
mod states;

#[path = "tests/state_ink.rs"]
mod state_ink;

#[test]
fn fleet_summary_counts_use_singular_for_one() {
    let fleet = |machines: usize, sessions: usize| {
        let sessions: Vec<_> = (0..sessions)
            .map(|i| serde_json::json!({"id":format!("s{i}"),"name":"main","paneCount":1,"sessionId":null,"selection":"pick"}))
            .collect();
        let groups: Vec<_> = (0..machines)
            .map(|i| serde_json::json!({"id":format!("m{i}"),"label":"Mac","state":"ready","conflict":false,"omittedSessions":0,"sessions":if i == 0 { sessions.clone() } else { vec![] }}))
            .collect();
        browser::State {
            fleet: Some(
                serde_json::from_value(serde_json::json!({"groups":groups,"omittedGroups":0}))
                    .unwrap(),
            ),
            ..Default::default()
        }
    };
    assert_eq!(
        summary(&fleet(0, 0), true),
        "0 machines · 0 available sessions"
    );
    assert_eq!(
        summary(&fleet(1, 1), true),
        "1 machine · 1 available session"
    );
    assert_eq!(
        summary(&fleet(2, 2), true),
        "2 machines · 2 available sessions"
    );
}
