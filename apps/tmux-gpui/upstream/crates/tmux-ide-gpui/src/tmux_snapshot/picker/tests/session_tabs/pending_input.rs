use super::*;
use crate::tmux_snapshot::keys::Input;

fn pending_input_case(cx: &mut TestAppContext, accepted: bool) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, _| prepare(v));
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f9");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::SessionTab {
        request: 8, from_request: 7, action, ..
    } if action == B)
    );
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            assert!(v.session_tabs.pending.is_some());
            assert!(v.browser_state.input_ready);
            assert!(!v.input_interrupted);
            // Exercise the shared terminal admission path, not a mocked bridge.
            // No acknowledgement has arrived; the old pane remains selected.
            v.queue_input(Input::Text("EARLY_PREFIX".into()), cx);
            v.queue_input(Input::Key("Enter".into()), cx);
            let leaked = receiver.try_iter().collect::<Vec<_>>();
            assert!(
                leaked.is_empty(),
                "pending activation must not queue terminal input"
            );
            assert!(
                v.input_interrupted,
                "a rejected prefix must latch, never resume as a suffix"
            );

            let mut state = v.browser_state.clone();
            if accepted {
                state.request = 8;
                state.selected_pane = Some("pane-b".into());
                state.panes = vec![choice("pane-b", "Other pane")];
                state.regions[0].id = "pane-b".into();
                state.session_tabs.as_mut().unwrap().request = 8;
                state.session_tab_result = None;
                // This represents fresh target authority, not permission from cached pixels.
                state.input_ready = true;
            } else {
                state.session_tab_result = Some(result(8, B, Outcome::Rejected));
            }
            v.apply_browser_state(Some(state), cx);
            assert!(v.session_tabs.pending.is_none());
            assert_eq!(v.browser_request, if accepted { 8 } else { 7 });
            assert_eq!(
                v.browser_state.selected_pane.as_deref(),
                Some(if accepted { "pane-b" } else { "pane-a" })
            );
            assert!(v.frame.is_some());
            v.queue_input(Input::Text("LATE_SUFFIX".into()), cx);
            v.queue_input(Input::Key("Enter".into()), cx);
            assert!(
                receiver.try_recv().is_err(),
                "acceptance/refusal must not replay or unlock rejected input"
            );
            assert!(v.input_interrupted);
        });
    });
    // Only an explicit ready click re-arms the established input latch.
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop); // Rendering may legitimately queue a resize.
    let first_cell = view.read_with(cx, |v, _| v.test_cell_point(0.25, 0.25));
    cx.simulate_click(first_cell, Modifiers::default());
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            assert!(!v.input_interrupted);
            v.queue_input(Input::Text("FRESH_COMMAND".into()), cx);
        });
    });
    let expected_request = if accepted { 8 } else { 7 };
    let expected_id = if accepted { "pane-b" } else { "pane-a" };
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Input { input_target: None,
        request, id, input: Input::Text(text)
    } if request == expected_request && id == expected_id && text == "FRESH_COMMAND")
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn pending_tab_input_stays_interrupted_after_refusal(cx: &mut TestAppContext) {
    pending_input_case(cx, false);
}

#[gpui::test]
fn pending_tab_input_stays_interrupted_after_acceptance(cx: &mut TestAppContext) {
    pending_input_case(cx, true);
}
