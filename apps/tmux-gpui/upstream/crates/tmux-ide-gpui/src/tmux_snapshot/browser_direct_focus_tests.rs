use super::*;
#[test]
fn focus_proof_is_stable_without_authority_but_never_grants_input() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    let source = snapshot();
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, true, 1, 0)
        .unwrap();
    let token = s.input_targets[0].token.clone();
    adapter
        .apply(&mut s, &window(source.clone(), 2, "one"), false, true, 2, 0)
        .unwrap();
    assert_eq!(s.native_focus_target.as_ref().unwrap().token, token);
    assert!(!s.input_ready);
    assert!(s.input_targets.is_empty());
    assert!(adapter.resolve("pane", Some(&token)).is_none());
    adapter
        .apply(&mut s, &window(source.clone(), 3, "two"), false, true, 3, 0)
        .unwrap();
    assert_ne!(s.native_focus_target.as_ref().unwrap().token, token);
    let mut incoherent = window(source, 4, "two");
    incoherent.coherent = false;
    adapter
        .apply(&mut s, &incoherent, false, true, 3, 0)
        .unwrap();
    assert!(s.native_focus_target.is_none());
}

#[test]
fn historical_lifetime_proof_does_not_grant_input_and_changes_on_replacement() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    let source = with_history();
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, true, 4, 0)
        .unwrap();
    let token = s.input_targets[0].token.clone();
    adapter.scroll(Scroll::Home);
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, true, 4, 0)
        .unwrap();
    assert!(s.history_offset > 0);
    assert_eq!(s.native_focus_target.as_ref().unwrap().token, token);
    assert!(!s.input_ready);
    assert!(s.input_targets.is_empty());
    assert!(adapter.resolve("pane", Some(&token)).is_none());
    adapter
        .apply(&mut s, &window(source, 2, "two"), true, true, 4, 0)
        .unwrap();
    assert_ne!(s.native_focus_target.as_ref().unwrap().token, token);
}
