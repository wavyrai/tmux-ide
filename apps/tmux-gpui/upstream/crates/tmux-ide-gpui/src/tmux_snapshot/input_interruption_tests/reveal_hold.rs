//! Review of ccbf7006: a window shown again is held a moment for its hidden
//! panes' fresh state. The switch may not be the app's own (a tmux binding
//! typed into the pane, another client). Keys typed during that hold are
//! never dropped and never leave input blocked: they go to the pane selected
//! once the window is up, in order, and nothing goes to the window left.
use super::*;
use crate::tmux_snapshot::pending_input::Target;
use std::time::Duration;

fn region_of(pane: &str) -> crate::tmux_snapshot::copy::Region {
    crate::tmux_snapshot::copy::Region {
        id: pane.into(),
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        wrapped: vec![false],
    }
}
/// Ready for input on `pane`.
fn ready(view: &SnapshotView, pane: &str, token: char) -> browser::State {
    let mut state = view.browser_state.clone();
    state.request = view.browser_request;
    state.input_ready = true;
    state.reveal_hold = false;
    state.presence_revision = 1;
    state.selected_session = Some("session".into());
    state.selected_pane = Some(pane.into());
    state.input_targets = vec![Target {
        id: pane.into(),
        token: token.to_string().repeat(64),
    }];
    state.copy_region = Some(region_of(pane));
    state
}
/// What the terminal loop publishes during a reveal hold: the window left is
/// still up, without input.
fn revealing(view: &SnapshotView) -> browser::State {
    let mut state = view.browser_state.clone();
    state.input_ready = false;
    state.reveal_hold = true;
    state
}
fn sent(receiver: &mpsc::Receiver<browser::Command>) -> Vec<(String, String, Option<String>)> {
    receiver
        .try_iter()
        .filter_map(|command| match command {
            browser::Command::Input {
                id,
                input: Input::Text(text) | Input::Key(text),
                input_target,
                ..
            } => Some((id, text, input_target)),
            _ => None,
        })
        .collect()
}

#[gpui::test]
fn keys_typed_while_a_window_shown_again_is_held_reach_the_pane_selected_after(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let state = ready(view, "pane-a", 'a');
            view.apply_browser_state(Some(state), cx);
            // A tmux binding switched the window: the hold starts.
            let state = revealing(view);
            view.apply_browser_state(Some(state), cx);
            view.replace_text_in_range(None, "ls", window, cx);
            view.terminal_key(&key("enter"), window, cx);
            assert!(!view.input_interrupted, "a key was refused during the hold");
            assert!(sent(&receiver).is_empty(), "a key went to the window left");
            // The window shown again is up, on its own pane.
            let state = ready(view, "pane-b", 'b');
            view.apply_browser_state(Some(state), cx);
            let token = Some("b".repeat(64));
            assert_eq!(
                sent(&receiver),
                [
                    ("pane-b".to_owned(), "ls".to_owned(), token.clone()),
                    ("pane-b".to_owned(), "Enter".to_owned(), token.clone()),
                ]
            );
            assert!(
                !view.input_interrupted,
                "input stayed blocked after the hold"
            );
            view.replace_text_in_range(None, "x", window, cx);
            // Typing goes on as usual, to the same pane.
            let later = sent(&receiver);
            assert_eq!(later.len(), 1);
            assert_eq!((later[0].0.as_str(), later[0].1.as_str()), ("pane-b", "x"));
        });
    });
}

/// A hold that does not end in time (the window never takes input within
/// REVEAL_LIMIT) drops its keys and says so in the status line: never a silent
/// loss.
#[gpui::test]
fn keys_held_past_the_reveal_limit_are_refused_aloud(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let state = ready(view, "pane-a", 'a');
            view.apply_browser_state(Some(state), cx);
            let state = revealing(view);
            view.apply_browser_state(Some(state), cx);
            view.replace_text_in_range(None, "ls", window, cx);
            view.age_pending_input_by(Duration::from_secs(4));
            let state = ready(view, "pane-b", 'b');
            view.apply_browser_state(Some(state), cx);
            assert!(sent(&receiver).is_empty(), "late keys were sent");
            assert!(view.input_interrupted);
            assert!(
                view.status_line().starts_with("Input interrupted"),
                "the loss was not shown: {}",
                view.status_line()
            );
        });
    });
}
