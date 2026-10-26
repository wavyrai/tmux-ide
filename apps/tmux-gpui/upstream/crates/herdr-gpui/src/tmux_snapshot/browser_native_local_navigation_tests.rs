#![allow(clippy::unwrap_used)]
use super::*;
fn back(ledger: &mut Ledger, current: u64, request: u64) -> Rejected {
    let p = ledger.publication(current, true).unwrap();
    Rejected {
        request,
        from_request: current,
        revision: p.revision,
        action: p.back.unwrap(),
    }
}
#[test]
fn traversal_commits_only_on_matching_live_acceptance_and_preserves_forward_history() {
    let mut ledger = Ledger::default();
    ledger.seed(&[]);
    assert!(ledger.accept(1, "A"));
    assert!(ledger.accept(2, "B"));
    let command = back(&mut ledger, 2, 3);
    let (index, key) = ledger.admit(&command, 2, true).unwrap();
    ledger.begin(3, index, key);
    assert!(!ledger.accept(2, "A"));
    assert!(!ledger.accept(3, "B"));
    assert_eq!(ledger.index, Some(1));
    assert!(ledger.accept(3, "A"));
    assert!(!ledger.accept(3, "A"));
    assert_eq!(ledger.index, Some(0));
    assert!(ledger.publication(3, true).unwrap().forward.is_some());
    assert!(ledger.accept(4, "A"));
    assert_eq!(ledger.entries, ["A", "B"]);
    assert!(ledger.accept(5, "C"));
    assert_eq!(ledger.entries, ["A", "C"]);
}
#[test]
fn stale_tokens_background_and_canceled_attempts_cannot_move_history() {
    let mut ledger = Ledger::default();
    ledger.seed(&["B".into(), "A".into()]);
    let command = back(&mut ledger, 1, 2);
    assert!(ledger.admit(&command, 1, false).is_none());
    assert!(ledger.admit(&command, 1, true).is_none());
    let next = back(&mut ledger, 1, 3);
    let (index, key) = ledger.admit(&next, 1, true).unwrap();
    ledger.begin(3, index, key);
    ledger.cancel();
    assert!(!ledger.accept(3, "A"));
    assert_eq!(ledger.index, Some(1));
    let mut stale = next;
    stale.request = 4;
    ledger.publication(1, true);
    assert!(ledger.admit(&stale, 1, true).is_none());
}
#[test]
fn seed_is_once_only_deduplicated_and_history_is_bounded() {
    let mut ledger = Ledger::default();
    assert!(!ledger.accept(0, "before-seed"));
    ledger.seed(&["B".into(), "A".into(), "B".into()]);
    assert_eq!(ledger.entries, ["A", "B"]);
    ledger.seed(&["replacement".into()]);
    for request in 1..100 {
        ledger.accept(request, &format!("session-{request}"));
    }
    assert_eq!(ledger.entries.len(), 64);
    assert_eq!(ledger.entries.last().unwrap(), "session-99");
    let p = ledger.publication(100, true).unwrap();
    assert!(p.valid());
    assert_eq!(ledger.publication(100, true).unwrap().back, p.back);
    assert!(ledger.publication(100, false).is_none());
}

#[test]
fn route_locators_are_bounded_and_transition_continuations_are_exact() {
    let mut ledger = Ledger::default();
    ledger.seed(&[]);
    for request in 1..100 {
        let key = format!("key-{request}");
        ledger.accept(request, &key);
        ledger.remember(&key, "saved-machine");
    }
    assert_eq!(ledger.routes.len(), 64);
    ledger.remember("not-visited", "arbitrary-host");
    assert_eq!(ledger.routes.len(), 64);
    ledger.restore_transition((100, 62, "key-98".into()), "saved-machine");
    assert!(ledger.take_transition(99, "saved-machine").is_none());
    assert!(ledger.take_transition(100, "local").is_none());
    let pending = ledger.take_transition(100, "saved-machine").unwrap();
    ledger.cancel();
    ledger.restore_transition(pending, "saved-machine");
    assert!(ledger.accept(100, "key-98"));
    ledger.restore_transition((101, 61, "key-97".into()), "saved-machine");
    ledger.cancel();
    assert!(!ledger.accept(101, "key-97"));
}

#[test]
fn persisted_routes_restore_seeded_history_but_never_selection_authority() {
    use herdr_client::tmux_daemon::{FleetCachedRoute, FleetCachedSession};
    let route = |id: &str, key: &str| FleetCachedRoute {
        route_id: id.into(),
        environment_id: None,
        generation: None,
        seen_at: 1,
        sessions: vec![FleetCachedSession {
            id: key.into(),
            live_session_id: None,
            server: None,
            server_label: None,
            name: "Cached display".into(),
            pane_count: 1,
        }],
    };
    let mut ledger = Ledger::default();
    ledger.seed(&["current".into(), "earlier".into()]);
    assert!(ledger.machine("earlier").is_none());
    ledger.cache_routes(&[route("saved", "earlier"), route("unvisited", "other")]);
    assert_eq!(ledger.machine("earlier").map(String::as_str), Some("saved"));
    assert!(ledger.machine("other").is_none());
    let command = back(&mut ledger, 1, 2);
    let (index, key) = ledger.admit(&command, 1, true).unwrap();
    ledger.begin(2, index, key);
    // The cached locator never commits the history cursor or opens an issued scope.
    assert_eq!(ledger.index, Some(1));
    assert!(!ledger.accept(2, "different-fresh-session"));
    assert!(ledger.accept(2, "earlier"));
    ledger.cache_routes(&[]);
    assert!(ledger.machine("earlier").is_none());
}

#[test]
fn ambiguous_cached_aliases_do_not_select_an_arbitrary_machine() {
    use herdr_client::tmux_daemon::{FleetCachedRoute, FleetCachedSession};
    let route = |id: &str| FleetCachedRoute {
        route_id: id.into(),
        environment_id: None,
        generation: None,
        seen_at: 1,
        sessions: vec![FleetCachedSession {
            id: "key".into(),
            live_session_id: None,
            server: None,
            server_label: None,
            name: "display".into(),
            pane_count: 1,
        }],
    };
    let mut ledger = Ledger::default();
    ledger.seed(&["key".into()]);
    ledger.cache_routes(&[route("one"), route("one")]);
    assert_eq!(ledger.machine("key").map(String::as_str), Some("one"));
    ledger.cache_routes(&[route("one"), route("two"), route("one")]);
    assert!(ledger.machine("key").is_none());
    ledger.remember("key", "observed-live");
    assert_eq!(
        ledger.machine("key").map(String::as_str),
        Some("observed-live")
    );
    for n in 1..100 {
        ledger.accept(n, &format!("session-{n}"));
    }
    assert!(ledger.machine("key").is_none());
}

#[test]
fn verified_cached_aliases_join_but_conflicting_offline_generation_blocks_lookup() {
    use herdr_client::tmux_daemon::{FleetCachedRoute, FleetCachedSession};
    let route = |id: &str, generation: &str, key: &str| FleetCachedRoute {
        route_id: id.into(),
        environment_id: Some("environment".into()),
        generation: Some(generation.into()),
        seen_at: 1,
        sessions: vec![FleetCachedSession {
            id: key.into(),
            live_session_id: None,
            server: None,
            server_label: None,
            name: "display".into(),
            pane_count: 1,
        }],
    };
    let mut ledger = Ledger::default();
    ledger.seed(&["key".into()]);
    ledger.cache_routes(&[route("one", "same", "key"), route("two", "same", "key")]);
    assert_eq!(ledger.machine("key").map(String::as_str), Some("one"));
    // Even an alias without this session is evidence of an environment conflict.
    ledger.cache_routes(&[route("one", "new", "key"), route("two", "old", "other")]);
    assert!(ledger.machine("key").is_none());
    ledger.cache_routes(&[route("two", "new", "key")]);
    assert_eq!(ledger.machine("key").map(String::as_str), Some("two"));
    ledger.cache_routes(&[]);
    assert!(ledger.machine("key").is_none());
}
