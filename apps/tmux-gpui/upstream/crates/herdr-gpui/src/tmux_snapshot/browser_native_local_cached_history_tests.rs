#![allow(clippy::unwrap_used)]
use super::*;
#[test]
#[ignore = "requires isolated SSH fleet and persisted catalog fixture"]
fn new_owner_restores_remote_history_from_cached_catalog() {
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_OWNED_SSH").as_deref(),
        Ok("private-fixture")
    );
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_CACHED_HISTORY").as_deref(),
        Ok("owned-catalog")
    );
    let record = std::env::var_os("TMUX_IDE_TEST_LOCAL_RECORD").unwrap();
    let profile = std::env::var("TMUX_IDE_TEST_SAVED_PROFILE").unwrap();
    let expected = std::env::var("TMUX_IDE_TEST_CACHED_LIVE").unwrap();
    assert!(!expected.is_empty());
    // A fresh actor has never attached this remote route. Background catalogs
    // do not seed the navigation ledger: persisted keys still locate its history.
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let home = until(&bridge, |state| {
        state.home_phase == HomePhase::Live
            && preferences_ready(state)
            && state
                .machines
                .as_ref()
                .is_some_and(|m| m.available && !m.pending)
            && state
                .session_history
                .as_ref()
                .is_some_and(|h| h.back.is_some())
    });
    assert!(home.frame.is_none());
    assert!(home.selected_session.is_none());
    let history = home.session_history.unwrap();
    bridge
        .commands
        .send(Command::SessionHistory {
            request: home.request + 1,
            from_request: home.request,
            revision: history.revision,
            action: history.back.unwrap(),
        })
        .unwrap();
    let live = until(&bridge, |state| {
        state.request == home.request + 1
            && state.frame.is_some()
            && state.selected_session.as_deref() == Some(&expected)
            && state
                .session_history
                .as_ref()
                .is_some_and(|h| h.forward.is_some())
    });
    assert!(
        live.fleet
            .as_ref()
            .unwrap()
            .groups
            .iter()
            .any(|group| group.id == profile)
    );
    assert!(live.session_history_rejected.is_none());
    drop(bridge);
    owner.shutdown().unwrap();
    eprintln!("NATIVE_CACHED_HISTORY_VERIFIED");
}
