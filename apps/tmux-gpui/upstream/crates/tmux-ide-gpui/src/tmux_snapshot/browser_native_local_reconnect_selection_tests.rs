//! Card #871, review round 1 item 2: a pane selection moves the terminal
//! loop's route to a new request before the catalog hears of it. When the
//! catalog drops the route for recovery in between, its close names the old
//! request and misses the loop's route, and the loop refuses any later open
//! older than the request it holds. So the catalog adopts the selection.
use super::*;

fn selected(from_request: u64, request: u64, pane: &str) -> Command {
    Command::NativePaneSelected {
        id: "old-route".into(),
        from_request,
        request,
        pane: pane.into(),
    }
}

#[test]
fn a_selection_that_arrives_during_recovery_is_where_the_stream_reopens() {
    let (mut local, events) = attached();
    let target = local.active.as_ref().unwrap().target.clone();
    // A catalog error with a live route (`survive`): the route is dropped.
    local.reconnect_start().unwrap();
    assert!(local.active.is_none());
    local.command(selected(7, 8, "%1")).unwrap();
    assert_eq!(local.state.request, 8, "the reopen would be refused");
    assert_eq!(local.state.selected_pane.as_deref(), Some("%1"));
    assert_eq!(
        last_catalog(&events).request,
        8,
        "the loop is not told the catalog's request"
    );
    // The same daemon: one lease for the selected pane.
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(
        matches!(&local.stage, Some(Stage::Issue { selected, .. }) if selected == "%1"),
        "the lease is not for the selected pane"
    );
    // Rediscovery opens the selected pane too.
    local.reconnect_retry(Failure::Other).unwrap();
    local.reconnect_tick().unwrap();
    local.targets.insert("new-token".into(), target);
    local.reconnect_catalog().unwrap();
    assert!(
        matches!(&local.stage, Some(Stage::Open { preferred, .. }) if preferred.as_deref() == Some("%1")),
        "rediscovery does not open the selected pane"
    );
    assert_eq!(local.state.request, 8);
}

/// Only the selection from the request the catalog holds, and only while it
/// recovers: anything else is a notice for a route that is gone.
#[test]
fn other_selections_without_a_route_change_nothing() {
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    local.command(selected(6, 8, "%1")).unwrap();
    local.command(selected(7, 7, "%1")).unwrap();
    assert_eq!(local.state.request, 7);
    assert_eq!(local.state.selected_pane.as_deref(), Some("%2"));

    let (mut local, _events) = attached();
    local.active = None;
    local.command(selected(7, 8, "%1")).unwrap();
    assert_eq!(local.state.request, 7, "a selection moved a closed window");

    // The recovery opened a route of its own: that route decides.
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    let target = local.recovery.as_ref().unwrap().target.clone();
    local.active = Some(Route {
        id: "new-route".into(),
        request: 7,
        target,
        workspace: "fixture".into(),
        window: None,
        notice: None,
        window_panes: Vec::new(),
    });
    local.command(selected(7, 8, "%1")).unwrap();
    assert_eq!(local.state.request, 7, "a gone route's selection was taken");
}

/// A pane the lease does not list is not asked for by the rebind.
#[test]
fn a_selected_pane_outside_the_lease_keeps_the_rebind_on_a_listed_pane() {
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    local.command(selected(7, 8, "%9")).unwrap();
    assert_eq!(local.state.request, 8);
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(
        matches!(&local.stage, Some(Stage::Issue { selected, panes, .. }) if selected == "%2" && panes.len() == 2),
        "the lease asks for a pane it does not list"
    );
}
