//! A header drag's swap through the native transport: the target is named
//! by the input token the drag captured.
#![allow(clippy::unwrap_used)]
use super::super::selection_tests::fixture;
use super::*;
use crate::tmux_snapshot::pane_actions::Action;

fn swap(target_token: String) -> Action {
    Action::Swap {
        target: "right".into(),
        target_token,
    }
}

#[test]
fn a_swap_from_the_selected_pane_is_submitted_for_its_geometry() {
    let (mut active, mut state, observed, peer) = fixture(true);
    let token = state.pane_actions.as_ref().unwrap().token.clone();
    let right = state
        .input_targets
        .iter()
        .find(|t| t.id == "right")
        .unwrap()
        .token
        .clone();
    active.action("left", &token, swap(right), 1).unwrap();
    assert!(
        active.actions.busy(),
        "the swap is the pane action in flight"
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        active.poll(&mut state, true, 2).unwrap();
        if observed
            .try_iter()
            .any(|v| v["type"] == "authority-request" && v["authority"] == "geometry")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the swap never asked for geometry"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        state.pane_actions.is_none(),
        "no second action while it runs"
    );
    active.controller.retire();
    peer.join().unwrap();
}

#[test]
fn a_swap_whose_target_token_is_stale_is_never_sent() {
    let (mut active, state, _observed, peer) = fixture(true);
    let token = state.pane_actions.as_ref().unwrap().token.clone();
    assert!(
        active
            .action("left", &token, swap("stale".into()), 1)
            .is_err()
    );
    assert!(!active.actions.busy());
    // Nor a swap of a pane with itself.
    let left = state
        .input_targets
        .iter()
        .find(|t| t.id == "left")
        .unwrap()
        .token
        .clone();
    let itself = Action::Swap {
        target: "left".into(),
        target_token: left,
    };
    assert!(active.action("left", &token, itself, 1).is_err());
    assert!(!active.actions.busy());
    active.controller.retire();
    peer.join().unwrap();
}
