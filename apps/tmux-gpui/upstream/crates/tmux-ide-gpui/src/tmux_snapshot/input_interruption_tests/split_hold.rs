//! Keys typed after a split reach the pane the split creates, never the old
//! pane and never a guess; any doubt keeps today's latch.
use super::*;
use crate::tmux_snapshot::pane_actions::{Action, SplitDirection, Target as ActionTarget};
use crate::tmux_snapshot::pending_input::Target;

const OLD: &str = "pane-a";
const NEW: &str = "pane-new";

fn choice(id: &str) -> browser::Choice {
    browser::Choice {
        pane_count: None,
        id: id.into(),
        label: id.into(),
        window_id: None,
        window_label: None,
        browser_icon: None,
        display_name_source: None,
    }
}
fn region(id: &str) -> crate::tmux_snapshot::copy::Region {
    crate::tmux_snapshot::copy::Region {
        id: id.into(),
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        wrapped: vec![false],
    }
}
fn ready(view: &mut SnapshotView) {
    view.browser_state.request = view.browser_request;
    view.browser_state.input_ready = true;
    view.browser_state.presence_revision = 1;
    view.browser_state.selected_session = Some("session".into());
    view.browser_state.panes = vec![choice(OLD)];
    view.browser_state.input_targets = vec![Target {
        id: OLD.into(),
        token: "a".repeat(64),
    }];
    view.browser_state.copy_region = Some(region(OLD));
    view.browser_state.pane_actions = Some(browser::PaneActions {
        token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
        id: OLD.into(),
        zoomed: false,
    });
}
fn split(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    let target = ActionTarget::capture(&view.browser_state).unwrap();
    let direction = SplitDirection::Right;
    assert!(view.dispatch_captured_pane_action(&target, Action::Split { direction }, window, cx));
}
/// What the worker publishes while it re-issues the stream after a split.
fn reissuing(view: &SnapshotView) -> browser::State {
    let mut state = view.browser_state.clone();
    state.input_ready = false;
    state.retained_preview = true;
    state.input_targets.clear();
    state.pane_actions = None;
    state.copy_region = None;
    state
}
/// The re-issued stream, at the pane tmux focuses after the split.
fn reissued(view: &SnapshotView, focused: &str) -> browser::State {
    let mut state = view.browser_state.clone();
    state.input_ready = true;
    state.retained_preview = false;
    state.panes = vec![choice(OLD), choice(NEW)];
    state.selected_pane = Some(focused.into());
    state.regions = serde_json::from_str(&format!(
        r#"[{{"id":"{OLD}","left":0,"top":0,"width":1,"height":1}},{{"id":"{NEW}","left":0,"top":0,"width":1,"height":1}}]"#
    ))
    .unwrap();
    state.input_targets = vec![Target {
        id: focused.into(),
        token: "b".repeat(64),
    }];
    state.copy_region = Some(region(focused));
    state
}
fn sent(receiver: &mpsc::Receiver<browser::Command>) -> Vec<(String, String, Option<String>)> {
    receiver
        .try_iter()
        .filter_map(|command| match command {
            browser::Command::Input {
                id,
                input: Input::Text(text),
                input_target,
                ..
            } => Some((id, text, input_target)),
            _ => None,
        })
        .collect()
}

#[gpui::test]
fn keys_typed_after_a_split_reach_the_new_pane_without_a_click(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready(view);
            split(view, window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::PaneAction { .. }
            ));
            // Typed before the worker has applied the split: held, not sent to the old pane.
            view.replace_text_in_range(None, "one", window, cx);
            let state = reissuing(view);
            view.apply_browser_state(Some(state), cx);
            view.replace_text_in_range(None, "two", window, cx);
        })
    });
    // A key, not only text, typed while the stream is re-issued.
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            assert!(receiver.try_recv().is_err(), "nothing reaches a pane yet");
            assert!(!view.input_interrupted);
            let state = reissued(view, NEW);
            view.apply_browser_state(Some(state), cx);
            let delivered: Vec<_> = receiver
                .try_iter()
                .filter_map(|command| match command {
                    browser::Command::Input {
                        id,
                        input,
                        input_target,
                        ..
                    } => Some((id, input, input_target)),
                    _ => None,
                })
                .collect();
            let token = Some("b".repeat(64));
            assert_eq!(delivered.len(), 3, "{:?}", delivered.len());
            assert!(delivered.iter().all(|(id, _, t)| id == NEW && *t == token));
            assert_eq!(delivered[0].1, Input::Text("one".into()));
            assert_eq!(delivered[1].1, Input::Text("two".into()));
            assert!(!view.input_interrupted);
            assert!(!view.status_line().starts_with("Input interrupted"));
        })
    });
}

/// Without typing, a split leaves input ready as before, with no message.
#[gpui::test]
fn a_split_without_typing_needs_no_click(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready(view);
            split(view, window, cx);
            let state = reissuing(view);
            view.apply_browser_state(Some(state), cx);
            let state = reissued(view, NEW);
            view.apply_browser_state(Some(state), cx);
            view.age_pending_input();
            let state = view.browser_state.clone();
            view.apply_browser_state(Some(state), cx);
            assert!(!view.input_interrupted);
            receiver.try_iter().for_each(drop);
            view.replace_text_in_range(None, "next", window, cx);
            assert_eq!(sent(&receiver), vec![(NEW.into(), "next".into(), None)]);
        })
    });
}

/// Any doubt about where held keys would land drops them and keeps the latch.
#[gpui::test]
fn held_keys_are_dropped_with_the_latch_when_the_target_is_in_doubt(cx: &mut TestAppContext) {
    for case in [
        "focus-stays-on-old-pane",
        "action-not-applied",
        "new-pane-without-reissue",
        "navigated",
        "no-input-target",
        "other-session",
        "timed-out",
    ] {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
        receiver.try_iter().for_each(drop);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                ready(view);
                split(view, window, cx);
                view.replace_text_in_range(None, "held", window, cx);
                if !matches!(case, "action-not-applied" | "new-pane-without-reissue") {
                    let state = reissuing(view);
                    view.apply_browser_state(Some(state), cx);
                }
                let mut state = match case {
                    "focus-stays-on-old-pane" | "action-not-applied" => reissued(view, OLD),
                    _ => reissued(view, NEW),
                };
                match case {
                    "navigated" => view.browser_request += 1,
                    "no-input-target" => state.input_targets.clear(),
                    "other-session" => state.selected_session = Some("other".into()),
                    "timed-out" => view.age_pending_input(),
                    _ => {}
                }
                if case == "navigated" {
                    state.request = view.browser_request;
                }
                view.apply_browser_state(Some(state), cx);
                // A target that never resolves gives up at the deadline.
                view.age_pending_input();
                let state = view.browser_state.clone();
                view.apply_browser_state(Some(state), cx);
                let delivered: Vec<_> = sent(&receiver)
                    .into_iter()
                    .filter(|(_, text, _)| text == "held")
                    .collect();
                assert!(delivered.is_empty(), "{case}: {delivered:?}");
                assert!(view.input_interrupted, "{case}");
            })
        });
    }
}

/// Zoom keeps the stream: keys go straight to the pane, nothing is held.
#[gpui::test]
fn zoom_holds_nothing(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready(view);
            let target = ActionTarget::capture(&view.browser_state).unwrap();
            let desired = crate::tmux_snapshot::pane_actions::Zoom::Zoomed;
            assert!(view.dispatch_captured_pane_action(
                &target,
                Action::Zoom { desired },
                window,
                cx
            ));
            assert!(view.pending_input.is_none());
            receiver.try_iter().for_each(drop);
            view.replace_text_in_range(None, "z", window, cx);
            assert_eq!(sent(&receiver), vec![(OLD.into(), "z".into(), None)]);
        })
    });
}

/// A split never replaces keys another hold already owns.
#[gpui::test]
fn a_split_keeps_an_existing_hold(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready(view);
            let f = view.frame.as_ref().unwrap().view();
            view.capture_viewport_input(f.width() + 1, f.height());
            view.replace_text_in_range(None, "resize", window, cx);
            assert!(view.pending_input.is_some());
            split(view, window, cx);
            assert!(!view.split_hold_waiting());
            assert!(view.pending_input.is_some());
        })
    });
}
