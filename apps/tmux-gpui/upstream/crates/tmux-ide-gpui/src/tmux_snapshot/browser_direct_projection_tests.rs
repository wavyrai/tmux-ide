use super::*;
use herdr_client::tmux_delivery::{DeferredHistory, History};
#[test]
fn alternate_projection_allows_leased_input_but_not_copy_or_history_until_materialized() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    let mut partial = (*snapshot()).clone();
    partial.modes.alternate_screen = true;
    partial.history = History::Deferred(DeferredHistory {
        rows: 2,
        digest: "0123456789abcdef".into(),
    });
    adapter
        .apply(
            &mut s,
            &window(Arc::new(partial.clone()), 7, "one"),
            true,
            1,
            0,
        )
        .unwrap();
    assert!(s.input_ready);
    assert!(s.selection_identity.is_none());
    assert_eq!(s.history_offset, 0);
    adapter.scroll_after_materialize(Scroll::Home);
    assert!(adapter.needs_materialization());
    // Complete-seed transfer retains paint while the controller withdraws readiness.
    adapter
        .apply(&mut s, &window(Arc::new(partial), 7, "one"), false, 1, 1)
        .unwrap();
    assert!(!s.input_ready);
    assert!(s.selection_identity.is_none());
    assert_eq!(s.history_offset, 0);
    let mut full = (*snapshot()).clone();
    full.history = vec![full.grid[0].clone(), full.grid[1].clone()].into();
    adapter
        .apply(&mut s, &window(Arc::new(full), 7, "one"), true, 1, 2)
        .unwrap();
    assert_eq!(s.history_offset, 2);
    assert!(!s.input_ready);
    assert!(s.selection_identity.is_some());
    assert!(!adapter.needs_materialization());
}
