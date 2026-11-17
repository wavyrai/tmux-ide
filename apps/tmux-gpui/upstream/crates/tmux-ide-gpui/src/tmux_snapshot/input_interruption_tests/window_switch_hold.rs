//! #806: keys typed after choosing a pane of another window, in a session
//! streamed one window at a time, reach that pane once its window's stream
//! is up; never the old window, and never a guess.
use super::*;
use crate::tmux_snapshot::pending_input::Target;

const OLD: &str = "pane-a";
const FAR: &str = "pane-far";
const OTHER: &str = "pane-other";

fn choice(id: &str, window: &str) -> browser::Choice {
    browser::Choice {
        pane_count: None,
        id: id.into(),
        label: id.into(),
        window_id: Some(window.into()),
        window_label: None,
        largest_window: None,
        browser_icon: None,
        display_name_source: None,
    }
}
fn ready(view: &mut SnapshotView, window_stream: bool) {
    view.browser_state.request = view.browser_request;
    view.browser_state.input_ready = true;
    view.browser_state.presence_revision = 1;
    view.browser_state.surface = browser::Surface::Workspace;
    view.browser_state.selected_session = Some("session".into());
    view.browser_state.selected_pane = Some(OLD.into());
    view.browser_state.window_stream = window_stream;
    view.browser_state.frame = view.frame.clone();
    view.browser_state.copy_region = Some(region(OLD));
    view.browser_state.panes = vec![
        choice(OLD, "window.one"),
        choice(FAR, "window.two"),
        choice(OTHER, "window.two"),
    ];
    view.browser_state.input_targets = vec![Target {
        id: OLD.into(),
        token: "a".repeat(64),
    }];
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
/// The new window's stream, up on `selected`.
fn switched(view: &SnapshotView, selected: &str) -> browser::State {
    let mut state = view.browser_state.clone();
    state.request = view.browser_request;
    state.input_ready = true;
    state.retained_preview = false;
    state.selected_pane = Some(selected.into());
    state.copy_region = Some(region(selected));
    state.regions = serde_json::from_str(&format!(
        r#"[{{"id":"{FAR}","left":0,"top":0,"width":1,"height":1}},{{"id":"{OTHER}","left":0,"top":0,"width":1,"height":1}}]"#
    ))
    .unwrap();
    state.input_targets = vec![
        Target {
            id: FAR.into(),
            token: "b".repeat(64),
        },
        Target {
            id: OTHER.into(),
            token: "c".repeat(64),
        },
    ];
    state
}
fn sent(receiver: &mpsc::Receiver<browser::Command>) -> Vec<(String, Option<String>)> {
    receiver
        .try_iter()
        .filter_map(|command| match command {
            browser::Command::Input {
                id, input_target, ..
            } => Some((id, input_target)),
            _ => None,
        })
        .collect()
}

#[gpui::test]
fn keys_typed_during_a_window_switch_reach_the_chosen_pane(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready(view, true);
            view.select(Selection::Pane(FAR.into()), window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Pane { .. }
            ));
            assert!(view.pending_input.is_some(), "the switch must hold keys");
            view.replace_text_in_range(None, "one", window, cx);
            view.replace_text_in_range(None, "two", window, cx);
            assert!(sent(&receiver).is_empty(), "nothing reaches the old window");
            assert!(!view.input_interrupted);
            let state = switched(view, FAR);
            view.apply_browser_state(Some(state), cx);
            let token = Some("b".repeat(64));
            assert_eq!(
                sent(&receiver),
                vec![(FAR.into(), token.clone()), (FAR.into(), token)]
            );
            assert!(!view.input_interrupted);
        })
    });
}

/// Any doubt drops the held keys with the latch.
#[gpui::test]
fn keys_held_for_a_window_switch_are_dropped_when_in_doubt(cx: &mut TestAppContext) {
    for case in [
        "other-pane",
        "no-target",
        "timed-out",
        "other-session",
        "navigated",
    ] {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
        receiver.try_iter().for_each(drop);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                ready(view, true);
                view.select(Selection::Pane(FAR.into()), window, cx);
                receiver.try_iter().for_each(drop);
                view.replace_text_in_range(None, "held", window, cx);
                let mut state = switched(view, if case == "other-pane" { OTHER } else { FAR });
                match case {
                    "no-target" => state.input_targets.retain(|t| t.id != FAR),
                    "timed-out" => view.age_pending_input(),
                    "other-session" => state.selected_session = Some("elsewhere".into()),
                    "navigated" => {
                        view.browser_request += 1;
                        state.request = view.browser_request;
                    }
                    _ => {}
                }
                view.apply_browser_state(Some(state), cx);
                // A target that never binds gives up at the deadline.
                view.age_pending_input();
                let state = view.browser_state.clone();
                view.apply_browser_state(Some(state), cx);
                view.replace_text_in_range(None, "next", window, cx);
                assert!(sent(&receiver).is_empty(), "{case}");
                assert!(view.input_interrupted, "{case}");
            })
        });
    }
}

/// A session streamed whole switches windows inside its stream: no hold.
#[gpui::test]
fn a_whole_session_stream_starts_no_switch_hold(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready(view, false);
            view.select(Selection::Pane(FAR.into()), window, cx);
            assert!(view.pending_input.is_none());
        })
    });
}

/// The new stream up on another pane drops the held keys at once, without
/// waiting for the deadline: they must not reach that pane either.
#[gpui::test]
fn a_switch_that_lands_on_another_pane_latches_at_once(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready(view, true);
            view.select(Selection::Pane(FAR.into()), window, cx);
            receiver.try_iter().for_each(drop);
            view.replace_text_in_range(None, "held", window, cx);
            let state = switched(view, OTHER);
            view.apply_browser_state(Some(state), cx);
            assert!(sent(&receiver).is_empty());
            assert!(view.input_interrupted);
            assert!(view.pending_input.is_none());
        })
    });
}
