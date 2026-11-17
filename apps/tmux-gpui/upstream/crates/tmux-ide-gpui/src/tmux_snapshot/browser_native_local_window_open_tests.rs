//! #806: a session over the limit opens one window when the daemon names its
//! windows; Home counts the largest window, not the session.
use super::*;
use herdr_client::tmux_daemon::InventoryWindow;

const MIXED: &str = "mixed";

fn win(id: &str, active: bool, range: std::ops::Range<usize>) -> InventoryWindow {
    InventoryWindow {
        id: id.into(),
        active,
        panes: range.map(|i| format!("pane.p{i}")).collect(),
    }
}
fn opened(local: &mut Local, windows: Option<Vec<InventoryWindow>>, preferred: Option<&str>) {
    local
        .open(4, key(local, SMALL), preferred.map(Into::into))
        .unwrap();
    let Some(Stage::Open { target, .. }) = local.stage.take() else {
        panic!("open missing");
    };
    local
        .completed(
            Stage::Open {
                target,
                preferred: preferred.map(Into::into),
            },
            CatalogResult::Opened {
                workspace_name: "fixture".into(),
                panes: panes(30),
                windows,
            },
        )
        .unwrap();
}
fn issued(local: &Local) -> (Option<String>, Vec<String>, String) {
    let Some(Stage::Issue {
        window,
        panes,
        selected,
        ..
    }) = &local.stage
    else {
        panic!("expected an issue, got Home");
    };
    (window.clone(), panes.clone(), selected.clone())
}

#[test]
fn a_large_session_issues_its_active_window_only() {
    let (mut local, _events) = loaded(3);
    let windows = vec![win("window.a", false, 0..20), win("window.b", true, 20..30)];
    opened(&mut local, Some(windows.clone()), None);
    let (window, issued_panes, selected) = issued(&local);
    assert_eq!(window.as_deref(), Some("window.b"));
    assert_eq!(issued_panes, windows[1].panes);
    assert_eq!(selected, "pane.p20");
    assert_eq!(local.window_notice, None);
    // The issue request names that window.
    let CatalogAction::Issue { selection, .. } = local.stage.as_ref().unwrap().action() else {
        panic!("expected an issue action");
    };
    assert_eq!(selection.window.as_deref(), Some("window.b"));
    assert_eq!(selection.visible_panes, windows[1].panes);
}

#[test]
fn a_selected_pane_opens_its_window_and_a_passed_over_window_says_so() {
    let (mut local, _events) = loaded(3);
    let windows = vec![win("window.a", false, 0..20), win("window.b", true, 20..30)];
    opened(&mut local, Some(windows), Some("pane.p3"));
    let (window, _, selected) = issued(&local);
    assert_eq!(
        (window.as_deref(), selected.as_str()),
        (Some("window.a"), "pane.p3")
    );
    assert_eq!(local.window_notice, None);

    let (mut local, _events) = loaded(3);
    let windows = vec![win("window.a", false, 0..5), win("window.b", true, 5..30)];
    opened(&mut local, Some(windows), None);
    let (window, _, _) = issued(&local);
    assert_eq!(window.as_deref(), Some("window.a"));
    assert_eq!(local.window_notice, Some(window::OTHER_WINDOW));
}

#[test]
fn a_session_that_fits_is_issued_whole_and_names_no_window() {
    let (mut local, _events) = loaded(3);
    local.open(4, key(&local, SMALL), None).unwrap();
    let stage = local.stage.take().unwrap();
    local
        .completed(
            stage,
            CatalogResult::Opened {
                workspace_name: "fixture".into(),
                panes: panes(12),
                windows: Some(vec![win("window.a", true, 0..12)]),
            },
        )
        .unwrap();
    let (window, issued_panes, _) = issued(&local);
    assert_eq!((window, issued_panes.len()), (None, 12));
}

#[test]
fn no_window_that_fits_returns_home_naming_the_largest_window() {
    let (mut local, events) = loaded(3);
    local.open(4, key(&local, SMALL), None).unwrap();
    let stage = local.stage.take().unwrap();
    local
        .completed(
            stage,
            CatalogResult::Opened {
                workspace_name: "fixture".into(),
                panes: panes(55),
                windows: Some(vec![
                    win("window.a", true, 0..25),
                    win("window.b", false, 25..55),
                ]),
            },
        )
        .unwrap();
    drain(&events);
    assert!(matches!(local.stage, Some(Stage::Servers)));
    let notice = local.state.home_notice.as_deref().unwrap();
    assert!(
        notice.starts_with(
            "The largest window of “small” has 30 panes. This app opens windows with up to 24."
        ),
        "{notice}"
    );
}

#[test]
fn an_agent_open_issues_the_agents_window() {
    let (mut local, _events) = loaded(3);
    local.open(5, key(&local, SMALL), None).unwrap();
    let Some(Stage::Open { target, .. }) = local.stage.take() else {
        panic!("open missing");
    };
    let selection = selection(&local, &target);
    local
        .completed(
            Stage::AgentOpen {
                target,
                selection: Box::new(selection),
            },
            CatalogResult::AgentOpened(OpenedAgent {
                workspace_name: "fixture".into(),
                panes: panes(30),
                selected: "pane.p0".into(),
                windows: Some(vec![
                    win("window.a", false, 0..10),
                    win("window.b", true, 10..30),
                ]),
            }),
        )
        .unwrap();
    let (window, issued_panes, selected) = issued(&local);
    assert_eq!(window.as_deref(), Some("window.a"));
    assert_eq!((issued_panes.len(), selected.as_str()), (10, "pane.p0"));
}

/// Home judges by windows when the daemon reports the largest one: a session
/// whose windows all fit opens plainly; one with a window too large still
/// opens, with a note, since another window may fit; one whose only window
/// is too large is refused (lead, 17 Nov).
#[test]
fn home_counts_the_largest_window_not_the_session() {
    let (mut local, events) = fixture();
    let mut catalog = catalog(3);
    for session in &mut catalog.sessions[0].sessions {
        session.largest_window_pane_count = Some(match session.session_name.as_str() {
            BIG => 25,
            HUGE => 1,
            _ => 3,
        });
    }
    catalog.sessions[0].sessions.push(Session {
        largest_window_pane_count: Some(30),
        ..session(MIXED, 38, Some(2))
    });
    local.receive_catalog(catalog, false).unwrap();
    drain(&events);
    let label = |local: &Local, name: &str| {
        let choice = local.state.sessions.iter().find(|c| c.label == name);
        choice.unwrap().pane_count_label().unwrap()
    };
    assert_eq!(label(&local, HUGE), "38 panes");
    assert_eq!(label(&local, BIG), "25 panes · too many");
    assert_eq!(
        label(&local, MIXED),
        "38 panes · a window has more than 24 panes"
    );
    local.open(8, key(&local, BIG), None).unwrap();
    assert!(
        local.stage.is_none(),
        "a too-large window must not reach the daemon"
    );
    let notice = local.state.home_notice.as_deref().unwrap();
    assert!(
        notice.starts_with("The largest window of “big” has 25 panes."),
        "{notice}"
    );
    local.open(9, key(&local, HUGE), None).unwrap();
    assert!(matches!(local.stage, Some(Stage::Open { .. })));
    assert!(local.state.home_notice.is_none());
}

#[test]
fn a_session_with_one_window_too_large_still_opens_on_another() {
    let (mut local, events) = fixture();
    let mut catalog = catalog(3);
    catalog.sessions[0].sessions.push(Session {
        largest_window_pane_count: Some(30),
        ..session(MIXED, 38, Some(2))
    });
    local.receive_catalog(catalog, false).unwrap();
    drain(&events);
    local.open(9, key(&local, MIXED), None).unwrap();
    assert!(local.state.home_notice.is_none());
    let Some(Stage::Open { target, preferred }) = local.stage.take() else {
        panic!("a session with a window that may fit must open");
    };
    local
        .completed(
            Stage::Open { target, preferred },
            CatalogResult::Opened {
                workspace_name: "fixture".into(),
                panes: panes(38),
                windows: Some(vec![
                    win("window.a", true, 0..30),
                    win("window.b", false, 30..38),
                ]),
            },
        )
        .unwrap();
    let (window, issued_panes, _) = issued(&local);
    assert_eq!(
        (window.as_deref(), issued_panes.len()),
        (Some("window.b"), 8)
    );
    assert_eq!(local.window_notice, Some(window::OTHER_WINDOW));
}

/// A pane of another window, chosen while a window is streamed, opens the
/// session again on that pane's window.
#[test]
fn choosing_a_pane_of_another_window_reissues_for_its_window() {
    let (mut local, _events) = loaded(3);
    let windows = vec![win("window.a", false, 0..20), win("window.b", true, 20..30)];
    opened(&mut local, Some(windows.clone()), None);
    assert_eq!(issued(&local).0.as_deref(), Some("window.b"));
    // As the window stream's labels list them: every window's panes.
    local.state.panes = (0..30)
        .map(|i| Choice {
            id: format!("pane.p{i}"),
            label: format!("pane.p{i}"),
            pane_count: None,
            window_id: None,
            browser_icon: None,
            display_name_source: None,
            window_label: None,
            largest_window: None,
        })
        .collect();
    local.stage = None;
    let request = local.state.request + 1;
    local
        .command(Command::Pane {
            request,
            id: "pane.p3".into(),
        })
        .unwrap();
    let Some(Stage::Open { target, preferred }) = local.stage.take() else {
        panic!("expected the session to open again");
    };
    assert_eq!(preferred.as_deref(), Some("pane.p3"));
    local
        .completed(
            Stage::Open { target, preferred },
            CatalogResult::Opened {
                workspace_name: "fixture".into(),
                panes: panes(30),
                windows: Some(windows),
            },
        )
        .unwrap();
    let (window, _, selected) = issued(&local);
    assert_eq!(
        (window.as_deref(), selected.as_str()),
        (Some("window.a"), "pane.p3")
    );
}
