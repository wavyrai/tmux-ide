use super::*;

#[test]
fn blur_and_refocus_expire_captured_targets_without_changing_rows() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    let shown = window(snapshot(), 1, "one");
    adapter.apply(&mut s, &shown, true, true, 1, 0).unwrap();
    let input_token = s.input_targets[0].token.clone();
    let token = action_token(&input_token, 1, 0);
    let frame = s.frame.clone().unwrap();
    adapter.apply(&mut s, &shown, false, true, 2, 1).unwrap();
    assert!(adapter.resolve_action("pane", &token).is_none());
    adapter.apply(&mut s, &shown, true, true, 3, 2).unwrap();
    assert!(s.input_ready);
    assert!(adapter.resolve_action("pane", &token).is_none());
    assert!(
        adapter
            .resolve_action("pane", &action_token(&s.input_targets[0].token, 3, 0))
            .is_some()
    );
    assert_eq!(input_token, s.input_targets[0].token);
    assert!(frame.same(s.frame.as_ref().unwrap()));
}

#[test]
fn admitted_actions_expire_menu_tokens_but_preserve_input_identity() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter
        .apply(&mut s, &window(snapshot(), 1, "one"), true, true, 1, 0)
        .unwrap();
    let input = &s.input_targets[0].token;
    let action = action_token(input, 1, adapter.action_revision());
    assert!(adapter.resolve_action("pane", &action).is_some());
    adapter.consume_action().unwrap();
    assert!(adapter.resolve_action("pane", &action).is_none());
    assert!(adapter.resolve("pane", Some(input)).is_some());
    assert!(
        adapter
            .resolve_action("pane", &action_token(input, 1, adapter.action_revision()))
            .is_some()
    );
}
