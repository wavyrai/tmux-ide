use super::*;

fn prepare(view: &mut SnapshotView) {
    view.browser_state.input_ready = true;
    view.browser_state.request = 7;
    view.browser_state.presence_revision = 1;
    view.browser_state.selected_session = Some("session".into());
    view.browser_state.input_targets = vec![crate::tmux_snapshot::pending_input::Target {
        id: "pane-b".into(),
        token: "a".repeat(64),
    }];
    view.browser_state.regions = serde_json::from_str(r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1},{"id":"pane-b","left":1,"top":0,"width":1,"height":1}]"#).unwrap();
}
fn confirmation(view: &SnapshotView) -> browser::State {
    let mut state = view.browser_state.clone();
    state.request = view.browser_request;
    state.input_ready = true;
    state.copy_region = Some(crate::tmux_snapshot::copy::Region {
        id: "pane-b".into(),
        left: 1,
        top: 0,
        width: 1,
        height: 1,
        wrapped: vec![false],
    });
    state
}
#[gpui::test]
fn immediate_text_and_enter_wait_for_exact_selection_then_send_once(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        prepare(view);
        view.select(Selection::Pane("pane-b".into()), window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Pane { .. }));
        view.replace_text_in_range(None, "P000", window, cx);
        view.terminal_key(&key("enter"), window, cx);
        assert!(receiver.try_recv().is_err());
        assert!(!view.input_interrupted);
        let state = confirmation(view);
        view.apply_browser_state(Some(state.clone()), cx);
        for expected in [Input::Text("P000".into()), Input::Key("Enter".into())] {
            assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Input { input_target: Some(ref target),request: 8, id, input} if id == "pane-b" && input == expected && target == &"a".repeat(64)));
        }
        view.apply_browser_state(Some(state), cx);
        assert!(receiver.try_recv().is_err(), "confirmation must never replay input");
    }));
}
#[gpui::test]
fn replaced_target_and_disconnect_discard_unsent_input_and_block_suffix(cx: &mut TestAppContext) {
    for disconnect in [false, true] {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        receiver.try_iter().for_each(drop);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                prepare(view);
                view.select(Selection::Pane("pane-b".into()), window, cx);
                assert!(matches!(
                    receiver.try_recv().unwrap(),
                    browser::Command::Pane { .. }
                ));
                view.replace_text_in_range(None, "prefix", window, cx);
                let mut state = confirmation(view);
                state.input_targets[0].token = "b".repeat(64);
                view.apply_browser_state(if disconnect { None } else { Some(state) }, cx);
                assert!(view.input_interrupted);
                view.replace_text_in_range(None, "suffix", window, cx);
                view.terminal_key(&key("enter"), window, cx);
                assert!(receiver.try_recv().is_err());
            })
        });
    }
}

#[gpui::test]
fn pending_input_drops_on_timeout_presence_or_new_navigation(cx: &mut TestAppContext) {
    for change in 0..3 {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        receiver.try_iter().for_each(drop);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                prepare(view);
                view.select(Selection::Pane("pane-b".into()), window, cx);
                assert!(matches!(
                    receiver.try_recv().unwrap(),
                    browser::Command::Pane { .. }
                ));
                view.replace_text_in_range(None, "prefix", window, cx);
                match change {
                    0 => view.age_pending_input(),
                    1 => view.presence.set_active(false),
                    _ => view.browser_request += 1,
                }
                view.expire_pending_input(cx);
                assert!(view.input_interrupted);
                assert!(view.pending_input.is_none());
                view.replace_text_in_range(None, "suffix", window, cx);
                assert!(receiver.try_recv().is_err());
            })
        });
    }
}
#[gpui::test]
fn pending_ime_commit_and_paste_keep_order_through_loading_publication(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        prepare(view);
        view.select(Selection::Pane("pane-b".into()), window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Pane { .. }));
        view.replace_and_mark_text_in_range(None, "é", Some(1..1), window, cx);
        let mut loading = confirmation(view);
        loading.input_ready = false;
        view.apply_browser_state(Some(loading), cx);
        assert_eq!(view.marked, "é");
        view.replace_text_in_range(None, "é", window, cx);
        view.queue_input(Input::Paste("one\ntwo".into()), cx);
        view.terminal_key(&key("enter"), window, cx);
        assert!(receiver.try_recv().is_err());
        view.apply_browser_state(Some(confirmation(view)), cx);
        for expected in [Input::Text("é".into()), Input::Paste("one\ntwo".into()), Input::Key("Enter".into())] {
            assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Input { input_target: Some(ref target),request: 8, id, input} if id == "pane-b" && input == expected && target == &"a".repeat(64)));
        }
        assert!(receiver.try_recv().is_err());
    }));
}

#[gpui::test]
fn old_helper_and_queue_overflow_never_release_a_command_suffix(cx: &mut TestAppContext) {
    for overflow in [false, true] {
        let (sender, receiver) = mpsc::sync_channel(128);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        receiver.try_iter().for_each(drop);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                prepare(view);
                if !overflow {
                    view.browser_state.input_targets.clear();
                }
                view.select(Selection::Pane("pane-b".into()), window, cx);
                assert!(matches!(
                    receiver.try_recv().unwrap(),
                    browser::Command::Pane { .. }
                ));
                for _ in 0..if overflow { 65 } else { 1 } {
                    view.replace_text_in_range(None, "x", window, cx);
                }
                assert!(view.input_interrupted);
                assert!(view.pending_input.is_none());
                view.apply_browser_state(Some(confirmation(view)), cx);
                view.terminal_key(&key("enter"), window, cx);
                assert!(receiver.try_recv().is_err());
            })
        });
    }
}

#[gpui::test]
fn stale_ready_publication_cannot_flush_and_channel_failure_never_retries(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        prepare(view);
        view.select(Selection::Pane("pane-b".into()), window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Pane { .. }));
        view.replace_text_in_range(None, "prefix", window, cx);
        view.terminal_key(&key("enter"), window, cx);
        let mut stale = confirmation(view);
        stale.request = 7;
        view.apply_browser_state(Some(stale), cx);
        assert!(receiver.try_recv().is_err());
        assert!(view.pending_input.is_some());
        let (sender, tiny) = mpsc::sync_channel(1);
        view.browser_commands = Some(sender);
        let ready = confirmation(view);
        view.apply_browser_state(Some(ready.clone()), cx);
        assert!(matches!(tiny.try_recv().unwrap(), browser::Command::Input {input: Input::Text(ref text), ..} if text == "prefix"));
        assert!(view.input_interrupted, "failed Enter cannot become a later retry");
        view.apply_browser_state(Some(ready), cx);
        assert!(tiny.try_recv().is_err());
    }));
}

#[gpui::test]
fn helper_rejection_latches_until_explicit_reselect_without_replaying(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        prepare(view);
        view.select(Selection::Pane("pane-b".into()), window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Pane { .. }));
        view.replace_text_in_range(None, "old", window, cx);
        let mut rejected = confirmation(view);
        rejected.input_target_rejected = true;
        view.apply_browser_state(Some(rejected.clone()), cx);
        assert!(view.input_interrupted);
        assert!(!view.terminal_input_ready());
        view.replace_text_in_range(None, "suffix", window, cx);
        view.terminal_key(&key("enter"), window, cx);
        assert!(receiver.try_recv().is_err());
        view.select(Selection::Pane("pane-b".into()), window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Pane {request:9, ..}));
        assert!(!view.input_interrupted);
        assert!(view.pending_input.is_none(), "recovery cannot hold prior uncertain input");
        let mut ready = confirmation(view);
        ready.input_target_rejected = false;
        view.apply_browser_state(Some(ready), cx);
        view.replace_text_in_range(None, "fresh", window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Input {input_target:None, request:9, id, input:Input::Text(text)} if id=="pane-b" && text=="fresh"));
        assert!(receiver.try_recv().is_err());
    }));
}
