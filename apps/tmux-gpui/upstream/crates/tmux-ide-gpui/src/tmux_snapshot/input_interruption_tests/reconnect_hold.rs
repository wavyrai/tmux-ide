//! PM, 12 Nov 2026: keys typed while the stream is being put back are never
//! silently ignored. For a short reconnect they wait in a small queue and go
//! to the same pane of the same session when the stream is back; otherwise
//! they are refused, all of them, and the pane says so.
use super::*;
use crate::tmux_snapshot::pending_input::Target;
use std::time::Duration;

const PANE: &str = "pane-a";

fn region() -> crate::tmux_snapshot::copy::Region {
    region_of(PANE)
}
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
/// A live session the user is typing into.
fn live(view: &mut SnapshotView, cx: &mut Context<SnapshotView>) {
    let mut state = view.browser_state.clone();
    state.request = view.browser_request;
    state.input_ready = true;
    state.presence_revision = 1;
    state.selected_session = Some("session".into());
    state.selected_pane = Some(PANE.into());
    state.input_targets = vec![Target {
        id: PANE.into(),
        token: "a".repeat(64),
    }];
    state.copy_region = Some(region());
    view.apply_browser_state(Some(state), cx);
}
/// What the terminal loop publishes while the catalog reconnects: the last
/// frame, read-only, with no input targets.
fn dropped(view: &SnapshotView, keys_lost: bool) -> browser::State {
    let mut state = view.browser_state.clone();
    state.input_ready = false;
    state.retained_preview = true;
    state.reconnect_attempt = Some(1);
    state.reconnect_keys_lost = keys_lost;
    state.input_targets.clear();
    state.copy_region = None;
    state
}
/// The stream is back on the same pane, with a new input token.
fn back(view: &SnapshotView) -> browser::State {
    let mut state = view.browser_state.clone();
    state.input_ready = true;
    state.retained_preview = false;
    state.reconnect_attempt = None;
    state.reconnect_keys_lost = false;
    state.input_targets = vec![Target {
        id: PANE.into(),
        token: "b".repeat(64),
    }];
    state.copy_region = Some(region());
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
fn view_with(
    cx: &mut TestAppContext,
) -> (
    Entity<SnapshotView>,
    mpsc::Receiver<browser::Command>,
    &mut VisualTestContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    (view, receiver, cx)
}

#[gpui::test]
fn keys_typed_during_a_short_reconnect_reach_the_same_pane_in_order(cx: &mut TestAppContext) {
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            view.replace_text_in_range(None, "ls", window, cx);
            view.terminal_key(&key("enter"), window, cx);
            view.replace_text_in_range(None, "pwd", window, cx);
            assert!(!view.input_interrupted, "a key was refused in a short hold");
            assert!(
                sent(&receiver).is_empty(),
                "a key was sent to a dead stream"
            );
            // Reconnecting, a second try: the keys keep waiting.
            let mut state = dropped(view, false);
            state.reconnect_attempt = Some(2);
            view.apply_browser_state(Some(state), cx);
            assert!(sent(&receiver).is_empty());
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            let token = Some("b".repeat(64));
            assert_eq!(
                sent(&receiver),
                [
                    (PANE.to_owned(), "ls".to_owned(), token.clone()),
                    (PANE.to_owned(), "Enter".to_owned(), token.clone()),
                    (PANE.to_owned(), "pwd".to_owned(), token),
                ]
            );
            assert!(!view.input_interrupted);
            assert!(view.pending_input.is_none());
            // Typing goes on as usual.
            view.replace_text_in_range(None, "x", window, cx);
            assert_eq!(sent(&receiver).len(), 1);
        })
    });
}

/// Three seconds from the drop, by the connection's clock. Keys typed later
/// are refused at once; keys already held are dropped together at the limit.
#[gpui::test]
fn a_reconnect_longer_than_three_seconds_refuses_every_held_key(cx: &mut TestAppContext) {
    for (typed_after, back_after, delivered) in [
        (0, 2900, true),
        (0, 3100, false),
        // The limit counts from the drop, not from the first key.
        (2000, 2900, true),
        (2000, 3100, false),
        (3100, 3200, false),
    ] {
        let (view, receiver, cx) = view_with(cx);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                live(view, cx);
                let state = dropped(view, false);
                view.apply_browser_state(Some(state), cx);
                view.age_connection_wait(Duration::from_millis(typed_after));
                view.replace_text_in_range(None, "held", window, cx);
                view.age_pending_input_by(Duration::from_millis(back_after - typed_after));
                if !delivered {
                    // The limit passes while still reconnecting: the pane says so.
                    view.browser_tick(cx);
                    assert!(view.input_interrupted, "{typed_after} {back_after}");
                    assert!(
                        view.not_sent_shown(),
                        "nothing told the user that the keys were refused"
                    );
                }
                let state = back(view);
                view.apply_browser_state(Some(state), cx);
                let got = sent(&receiver);
                assert_eq!(!got.is_empty(), delivered, "{typed_after} {back_after}");
                // The refusal lifts with the reconnect: no click is needed.
                assert!(!view.input_interrupted);
                view.replace_text_in_range(None, "next", window, cx);
                assert_eq!(sent(&receiver).len(), 1);
            })
        });
    }
}

/// Keys that were in flight when the stream dropped are gone. Sending what
/// was typed after them would run the end of a command without its start.
#[gpui::test]
fn nothing_is_held_when_keys_typed_before_the_drop_were_lost(cx: &mut TestAppContext) {
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, true);
            view.apply_browser_state(Some(state), cx);
            view.replace_text_in_range(None, "suffix", window, cx);
            assert!(view.input_interrupted);
            assert!(view.pending_input.is_none());
            assert!(view.not_sent_shown());
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            assert!(sent(&receiver).is_empty());
        })
    });
}

/// The queue is small: 32 keys or 256 bytes. One key too many refuses them
/// all; a part of what was typed is never sent.
#[gpui::test]
fn a_full_queue_refuses_everything_it_held(cx: &mut TestAppContext) {
    for case in ["keys", "bytes"] {
        let (view, receiver, cx) = view_with(cx);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                live(view, cx);
                let state = dropped(view, false);
                view.apply_browser_state(Some(state), cx);
                if case == "keys" {
                    for _ in 0..32 {
                        view.replace_text_in_range(None, "k", window, cx);
                    }
                } else {
                    view.replace_text_in_range(None, &"b".repeat(256), window, cx);
                }
                assert!(!view.input_interrupted, "{case}: the bound is smaller");
                view.replace_text_in_range(None, "x", window, cx);
                assert!(view.input_interrupted, "{case}");
                assert!(view.not_sent_shown(), "{case}");
                let state = back(view);
                view.apply_browser_state(Some(state), cx);
                assert!(sent(&receiver).is_empty(), "{case}");
            })
        });
    }
}

/// Any doubt about where the keys would land refuses them.
#[gpui::test]
fn held_keys_never_reach_another_pane_session_or_request(cx: &mut TestAppContext) {
    for case in [
        "other-pane",
        "other-session",
        "navigated",
        "home",
        "no-input-target",
        "window-left",
    ] {
        let (view, receiver, cx) = view_with(cx);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                live(view, cx);
                let state = dropped(view, false);
                view.apply_browser_state(Some(state), cx);
                view.replace_text_in_range(None, "held", window, cx);
                assert!(view.pending_input.is_some(), "{case}");
                let mut state = back(view);
                match case {
                    // The typed-in pane still takes input, but is not selected.
                    "other-pane" => {
                        state.selected_pane = Some("pane-b".into());
                        state.input_targets.push(Target {
                            id: "pane-b".into(),
                            token: "c".repeat(64),
                        });
                        state.copy_region = Some(region_of("pane-b"));
                    }
                    "other-session" => state.selected_session = Some("other".into()),
                    "navigated" => {
                        view.browser_request += 1;
                        state.request = view.browser_request;
                    }
                    "home" => state.surface = browser::Surface::Home,
                    "no-input-target" => state.input_targets.clear(),
                    "window-left" => state.presence_revision += 1,
                    _ => unreachable!(),
                }
                view.apply_browser_state(Some(state), cx);
                view.age_pending_input_by(Duration::from_millis(3100));
                view.browser_tick(cx);
                let delivered: Vec<_> = sent(&receiver)
                    .into_iter()
                    .filter(|(_, text, _)| text == "held")
                    .collect();
                assert!(delivered.is_empty(), "{case}: {delivered:?}");
                assert!(view.pending_input.is_none(), "{case}");
            })
        });
    }
}

/// A click or a wheel turn during the hold is still refused, and takes no
/// held key with it.
#[gpui::test]
fn only_keys_wait_in_the_reconnect_hold(cx: &mut TestAppContext) {
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            view.replace_text_in_range(None, "held", window, cx);
            view.queue_input(Input::Scroll(3), cx);
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            let got = sent(&receiver);
            assert_eq!(got.len(), 1, "{got:?}");
            assert_eq!(got[0].1, "held");
        })
    });
}

/// Review of 9c0da9fe, finding 1, the view's half: the loop reports a key
/// it dropped after the hold began. Keys held meanwhile are refused, all of
/// them, and the pane says so.
#[gpui::test]
fn held_keys_are_refused_when_the_hold_later_reports_lost_keys(cx: &mut TestAppContext) {
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            view.replace_text_in_range(None, "suffix", window, cx);
            assert!(view.pending_input.is_some());
            let state = dropped(view, true);
            view.apply_browser_state(Some(state), cx);
            assert!(view.pending_input.is_none());
            assert!(view.not_sent_shown());
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            assert!(sent(&receiver).is_empty());
        })
    });
}
