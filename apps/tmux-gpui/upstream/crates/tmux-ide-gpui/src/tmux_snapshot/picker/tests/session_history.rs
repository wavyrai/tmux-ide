use super::*;
use crate::tmux_snapshot::session_history::Capability;
const BACK: &str = "11111111-1111-4111-8111-111111111111";
const FORWARD: &str = "22222222-2222-4222-8222-222222222222";
fn prepare(v: &mut SnapshotView) {
    v.browser_state.request = 7;
    v.browser_state.surface = browser::Surface::Workspace;
    v.browser_state.session_history = Some(Capability {
        revision: 3,
        back: Some(BACK.into()),
        forward: Some(FORWARD.into()),
    });
}
#[gpui::test]
fn f8_rejection_preserves_terminal_then_shift_f8_accepts_loading(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f8");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::SessionHistory{request:8,from_request:7,revision:3,action} if action==BACK)
    );
    cx.simulate_keystrokes("f8");
    assert!(receiver.try_recv().is_err());
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            assert_eq!(v.browser_request, 7);
            assert!(v.frame.is_some());
            assert!(v.browser_state.input_ready);
            let pending = v.session_history.pending.clone().unwrap();
            let mut unrelated = v.browser_state.clone();
            unrelated.session_history_rejected =
                Some(crate::tmux_snapshot::session_history::Rejected {
                    action: FORWARD.into(),
                    ..pending.clone()
                });
            v.apply_browser_state(Some(unrelated), cx);
            assert!(v.session_history.pending.is_some());
            let mut rejected = v.browser_state.clone();
            rejected.session_history_rejected = Some(pending);
            v.apply_browser_state(Some(rejected), cx);
            assert!(v.session_history.pending.is_none());
            assert_eq!(v.browser_request, 7);
            assert!(v.frame.is_some());
            assert!(v.browser_state.input_ready);
        })
    });
    cx.simulate_keystrokes("shift-f8");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::SessionHistory{request:9,action,..} if action==FORWARD)
    );
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let mut accepted = v.browser_state.clone();
            accepted.request = 9;
            accepted.frame = None;
            accepted.input_ready = false;
            accepted.session_history_rejected = None;
            v.apply_browser_state(Some(accepted), cx);
            assert_eq!(v.browser_request, 9);
            assert!(v.frame.is_none());
            assert!(v.session_history.pending.is_none());
        })
    });
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn history_guards_do_not_leak_terminal_keys(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| view.update(cx, |v, _| v.marked = "compose".into()));
    cx.simulate_keystrokes("f8 shift-f8");
    assert!(receiver.try_recv().is_err());
    cx.update(|_, cx| {
        view.update(cx, |v, _| {
            v.marked.clear();
            v.presence.set_active(false);
        })
    });
    cx.simulate_keystrokes("f8");
    assert!(receiver.try_recv().is_err());
    cx.update(|_, cx| {
        view.update(cx, |v, _| {
            v.presence.set_active(true);
            assert!(!v.presence.ready());
        })
    });
    cx.simulate_keystrokes("f8");
    assert!(receiver.try_recv().is_err());
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            v.presence.flush(v.browser_commands.as_ref().unwrap());
            v.presence.acknowledge(3);
            assert!(v.presence.ready());
            receiver.try_iter().for_each(drop);
            v.picker_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("f8").unwrap(),
                    is_held: true,
                    prefer_character_input: false,
                    layout: None,
                },
                w,
                cx,
            );
            assert!(receiver.try_recv().is_err());
            v.open_commands(w, cx);
            v.picker_key(
                &crate::tmux_snapshot::fit_test_support::key_down("f8"),
                w,
                cx,
            );
            assert!(receiver.try_recv().is_err());
            v.picker = None;
            v.browser_state.session_history = None;
        })
    });
    cx.simulate_keystrokes("f8 shift-f8");
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn history_allocator_exceeds_other_rejected_attempts_and_queue_full_preserves_frame(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            prepare(v);
            v.attention.last_request = 12;
            v.palette.last_request = 15;
        });
        w.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("f8");
    view.read_with(cx, |v, _| {
        assert!(v.session_history.pending.is_none());
        assert!(v.frame.is_some());
        assert_eq!(v.browser_request, 7);
        assert_eq!(v.next_navigation_request(), Some(17));
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Presence { .. }
    ));
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("f8");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::SessionHistory { request: 17, .. }
    ));
}

#[gpui::test]
fn queued_history_background_rejection_and_new_navigation_do_not_rollback(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f8");
    receiver.try_recv().unwrap();
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let old = v.session_history.pending.clone().unwrap();
            v.presence.set_active(false);
            assert!(v.session_history.pending.is_some());
            let mut rejected = v.browser_state.clone();
            rejected.session_history_rejected = Some(old.clone());
            v.apply_browser_state(Some(rejected), cx);
            assert!(v.frame.is_some());
            assert_eq!(v.browser_request, 7);
            assert!(v.session_history.pending.is_none());
            // A newer independently admitted navigation supersedes the historical attempt.
            v.browser_request = 9;
            v.session_history.pending = Some(old);
            let mut late = v.browser_state.clone();
            late.request = 8;
            v.apply_browser_state(Some(late), cx);
            assert_eq!(v.browser_request, 9);
            assert!(v.session_history.pending.is_none());
        })
    });
}
