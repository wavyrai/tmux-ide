//! Reconnect reliability (19 Nov 2026): a reconnect never loses input it can
//! still deliver. Up to 512 keys wait, go to the same pane in order exactly
//! once, all or nothing; what cannot be delivered is counted in the pane. A
//! link that is only suspect (the Mac woke, the network changed) holds keys
//! the same way until its probe is answered.
use super::reconnect_hold::{PANE, back, dropped, live, sent, view_with};
use super::*;
use std::time::Duration;

fn type_keys(
    view: &mut SnapshotView,
    keys: &[&str],
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
) {
    for k in keys {
        if *k == "enter" {
            view.terminal_key(&key("enter"), window, cx);
        } else {
            view.replace_text_in_range(None, k, window, cx);
        }
    }
}

/// 512 keys, letters with an Enter among them: delivered in order, exactly
/// once, with the letters joined so they fit the queues to the stream.
#[gpui::test]
fn five_hundred_twelve_held_keys_arrive_in_order_exactly_once(cx: &mut TestAppContext) {
    let letters: Vec<String> = (0..511usize)
        .map(|i| char::from(b"abcdefghijklmnopqrstuvwxyz"[i % 26]).to_string())
        .collect();
    let mut typed: Vec<&str> = letters.iter().map(String::as_str).collect();
    typed.insert(300, "enter");
    assert_eq!(typed.len(), 512);
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            type_keys(view, &typed, window, cx);
            assert!(
                !view.input_interrupted,
                "a key was refused within the bound"
            );
            assert!(sent(&receiver).is_empty());
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            let got = sent(&receiver);
            let token = Some("b".repeat(64));
            assert!(
                got.iter().all(|(id, _, t)| id == PANE && *t == token),
                "{got:?}"
            );
            let joined: Vec<&str> = got.iter().map(|(_, text, _)| text.as_str()).collect();
            let before: String = letters[..300].concat();
            let after: String = letters[300..].concat();
            assert_eq!(joined, [before.as_str(), "Enter", after.as_str()]);
            assert!(view.pending_input.is_none());
            assert_eq!(view.connection.keys_not_sent, 0);
            // Nothing is sent twice.
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            view.browser_tick(cx);
            assert!(sent(&receiver).is_empty());
        })
    });
}

/// Keys that cannot be delivered are all dropped, and the pane says how many,
/// counting the ones typed after them too. The count goes with the latch.
#[gpui::test]
fn the_pane_counts_the_keys_a_reconnect_could_not_deliver(cx: &mut TestAppContext) {
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            type_keys(view, &["l", "s", "enter"], window, cx);
            view.age_pending_input_by(Duration::from_millis(5100));
            view.browser_tick(cx);
            assert!(view.not_sent_shown());
            assert_eq!(view.connection.keys_not_sent, 3);
            type_keys(view, &["x"], window, cx);
            assert_eq!(view.connection.keys_not_sent, 4);
            assert_eq!(
                view.pane_notice().as_deref(),
                Some("4 keys not sent. Type them again when the connection is back.")
            );
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            assert!(sent(&receiver).is_empty(), "a dropped key came back");
            assert_eq!(view.connection.keys_not_sent, 0);
            assert!(!view.input_interrupted);
        })
    });
}

/// A session re-created under the same name has another live id: its new
/// stream, even on a pane of the same id, gets none of the held keys.
#[gpui::test]
fn a_re_created_session_gets_none_of_the_held_keys(cx: &mut TestAppContext) {
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            type_keys(view, &["rm", "enter"], window, cx);
            let mut state = back(view);
            state.selected_session = Some("session-re-created".into());
            view.apply_browser_state(Some(state), cx);
            view.browser_tick(cx);
            assert!(sent(&receiver).is_empty());
            assert!(view.pending_input.is_none());
            assert_eq!(view.connection.keys_not_sent, 2);
        })
    });
}

/// Once the first held key is sent the rest follow, even when the queue to
/// the stream is full and the hold's limit passes before they fit.
#[gpui::test]
fn a_delivery_once_begun_finishes_past_the_limit(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(2);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            receiver.try_iter().for_each(drop);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            type_keys(view, &["a", "enter", "b", "enter", "c"], window, cx);
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            let mut got = sent(&receiver);
            assert_eq!(got.len(), 2, "the queue takes two");
            assert!(!view.reconnect_hold_waiting(), "delivering, not waiting");
            view.age_pending_input_by(Duration::from_secs(10));
            while view.pending_input.is_some() {
                view.browser_tick(cx);
                got.extend(sent(&receiver));
                assert!(got.len() <= 5, "{got:?}");
            }
            let texts: Vec<&str> = got.iter().map(|(_, text, _)| text.as_str()).collect();
            assert_eq!(texts, ["a", "Enter", "b", "Enter", "c"]);
            assert!(!view.input_interrupted);
            assert_eq!(view.connection.keys_not_sent, 0);
        })
    });
}

/// A live stream whose link is probed (the Mac woke): keys wait for the
/// probe's answer and then go to the same stream, under the same token.
#[gpui::test]
fn keys_typed_while_the_link_is_probed_wait_for_its_answer(cx: &mut TestAppContext) {
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let mut state = view.browser_state.clone();
            state.link_probe = true;
            view.apply_browser_state(Some(state), cx);
            type_keys(view, &["ls", "enter"], window, cx);
            assert!(!view.input_interrupted);
            assert!(sent(&receiver).is_empty(), "a key went into a suspect link");
            // Probing takes no time limit of its own: the stream bounds it.
            view.age_pending_input_by(Duration::from_millis(4900));
            view.browser_tick(cx);
            assert!(view.pending_input.is_some());
            let mut state = view.browser_state.clone();
            state.link_probe = false;
            view.apply_browser_state(Some(state), cx);
            let token = Some("a".repeat(64));
            assert_eq!(
                sent(&receiver),
                [
                    (PANE.to_owned(), "ls".to_owned(), token.clone()),
                    (PANE.to_owned(), "Enter".to_owned(), token),
                ]
            );
        })
    });
}

/// The probe found the link dead: the drop continues the hold, its limit
/// counted from the drop, and the keys go to the new stream.
#[gpui::test]
fn a_failed_probe_becomes_a_drop_and_the_keys_follow_the_new_stream(cx: &mut TestAppContext) {
    // However long the probe was unanswered before the drop.
    for (probed_for, back_after_drop, delivered) in [
        (5000, 4900, true),
        (5000, 5100, false),
        (1000, 4900, true),
        (1000, 5100, false),
    ] {
        let (view, receiver, cx) = view_with(cx);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                live(view, cx);
                let mut state = view.browser_state.clone();
                state.link_probe = true;
                view.apply_browser_state(Some(state), cx);
                type_keys(view, &["held"], window, cx);
                // The pong limit passes: the stream ends as silent. The held
                // frame's publication probes nothing (`browser_native_hold`).
                view.age_pending_input_by(Duration::from_millis(probed_for));
                let mut state = dropped(view, false);
                state.link_probe = false;
                view.apply_browser_state(Some(state), cx);
                view.browser_tick(cx);
                assert!(view.pending_input.is_some(), "the drop ended the hold");
                view.age_pending_input_by(Duration::from_millis(back_after_drop));
                view.browser_tick(cx);
                let state = back(view);
                view.apply_browser_state(Some(state), cx);
                let got = sent(&receiver);
                if delivered {
                    assert_eq!(
                        got,
                        [(PANE.to_owned(), "held".to_owned(), Some("b".repeat(64)))]
                    );
                } else {
                    assert!(got.is_empty(), "{got:?}");
                    assert!(view.pending_input.is_none());
                }
            })
        });
    }
}

/// A probe is answered or becomes a drop within the stream's pong limit. One
/// that does neither holds keys for twice the reconnect limit, then drops
/// them all and says how many.
#[gpui::test]
fn a_probe_that_never_ends_drops_the_held_keys_at_twice_the_limit(cx: &mut TestAppContext) {
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let mut state = view.browser_state.clone();
            state.link_probe = true;
            view.apply_browser_state(Some(state), cx);
            type_keys(view, &["ls", "enter"], window, cx);
            view.age_pending_input_by(Duration::from_millis(9900));
            view.browser_tick(cx);
            assert!(
                view.pending_input.is_some(),
                "dropped before twice the limit"
            );
            view.age_pending_input_by(Duration::from_millis(200));
            view.browser_tick(cx);
            assert!(view.pending_input.is_none(), "held past twice the limit");
            assert!(view.input_interrupted);
            assert_eq!(view.connection.keys_not_sent, 2);
            assert!(sent(&receiver).is_empty());
        })
    });
}

/// Held text is joined only up to what one input carries (1024 UTF-16
/// units): the rest follows as the next input, in order.
#[gpui::test]
fn held_text_is_joined_up_to_one_input_and_no_further(cx: &mut TestAppContext) {
    let (view, receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            let (a, b) = ("a".repeat(512), "b".repeat(512));
            type_keys(view, &[&a, &b, "c", "d"], window, cx);
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            let got = sent(&receiver);
            let texts: Vec<&str> = got.iter().map(|(_, text, _)| text.as_str()).collect();
            assert_eq!(texts, [format!("{a}{b}").as_str(), "cd"]);
        })
    });
}

/// The pane's card counts the keys that wait, from 2 s into the hold. On a
/// link that is only probed there is nothing to retry: no "Retry now".
#[gpui::test]
fn the_card_counts_held_keys_and_offers_no_retry_while_only_probing(cx: &mut TestAppContext) {
    for probing in [false, true] {
        let (view, _receiver, cx) = view_with(cx);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                live(view, cx);
                let mut state = if probing {
                    view.browser_state.clone()
                } else {
                    dropped(view, false)
                };
                state.link_probe = probing;
                view.apply_browser_state(Some(state), cx);
                type_keys(view, &["l", "s"], window, cx);
                assert_eq!(view.reconnect_card(), None, "a card before 2 s");
                view.age_pending_input_by(Duration::from_millis(2100));
                assert_eq!(
                    view.reconnect_card().as_deref(),
                    Some("Reconnecting… 2 keys wait to be sent."),
                    "probing: {probing}"
                );
            });
            window.draw(cx).clear(cx);
        });
        assert!(cx.debug_bounds("tmux-reconnect-card").is_some());
        assert_eq!(
            cx.debug_bounds("tmux-reconnect-retry").is_some(),
            !probing,
            "probing: {probing}"
        );
    }
}

/// The stream is replaced again while held keys are still going out: the
/// rest never goes to the newer stream, and the pane says how many.
#[gpui::test]
fn a_stream_replaced_mid_delivery_gets_none_of_the_rest(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(2);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            receiver.try_iter().for_each(drop);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            type_keys(view, &["a", "enter", "b", "enter", "c"], window, cx);
            let state = back(view);
            view.apply_browser_state(Some(state), cx);
            assert_eq!(sent(&receiver).len(), 2, "the queue takes two");
            let mut state = back(view);
            state.input_targets[0].token = "c".repeat(64);
            view.apply_browser_state(Some(state), cx);
            view.browser_tick(cx);
            assert!(
                sent(&receiver).is_empty(),
                "held keys reached a newer stream"
            );
            assert!(view.pending_input.is_none());
            assert_eq!(view.connection.keys_not_sent, 3);
        })
    });
}

/// Leaving the session forgets the count with the notice.
#[gpui::test]
fn the_count_goes_when_the_session_is_left(cx: &mut TestAppContext) {
    let (view, _receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            type_keys(view, &["l", "s"], window, cx);
            view.age_pending_input_by(Duration::from_millis(5100));
            view.browser_tick(cx);
            assert_eq!(view.connection.keys_not_sent, 2);
            let mut state = view.browser_state.clone();
            state.surface = browser::Surface::Home;
            view.apply_browser_state(Some(state), cx);
            assert_eq!(view.connection.keys_not_sent, 0);
        })
    });
}

/// The hold's limit is reported when it passes, with no key, tick or
/// publication to notice it.
#[gpui::test]
fn the_limit_is_reported_when_it_passes_without_another_event(cx: &mut TestAppContext) {
    let (view, _receiver, cx) = view_with(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            live(view, cx);
            let state = dropped(view, false);
            view.apply_browser_state(Some(state), cx);
            type_keys(view, &["l", "s"], window, cx);
            // The wake reads the test's clock; the limit, the real one.
            view.age_pending_input_by(Duration::from_millis(5100));
        })
    });
    cx.executor().advance_clock(Duration::from_millis(5200));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.pending_input.is_none(), "nothing noticed the limit");
        assert_eq!(view.connection.keys_not_sent, 2);
    });
}

/// A probe hold is only for a live stream that takes input. A probed stream
/// that does not, shows a split's preview or is already reconnecting holds
/// nothing on the probe's account: the key is refused.
#[gpui::test]
fn a_probed_stream_that_takes_no_input_holds_no_key(cx: &mut TestAppContext) {
    for case in ["input-not-ready", "preview", "reconnecting-live"] {
        let (view, receiver, cx) = view_with(cx);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                live(view, cx);
                let mut state = view.browser_state.clone();
                state.link_probe = true;
                match case {
                    "input-not-ready" => state.input_ready = false,
                    "preview" => state.retained_preview = true,
                    _ => state.reconnect_attempt = Some(1),
                }
                view.apply_browser_state(Some(state), cx);
                type_keys(view, &["x"], window, cx);
                assert!(view.pending_input.is_none(), "{case}: the key was held");
                assert!(view.input_interrupted, "{case}: the key was not refused");
                assert!(sent(&receiver).is_empty(), "{case}");
            })
        });
    }
}

/// Keys that do not join (a letter, Enter, a letter, Enter) go out one
/// command each, through a channel of 32 into the terminal loop's queue,
/// which refuses the newest command when it is full. A hold never has more
/// of them than fit: every held key reaches the loop's queue in order, even
/// when nothing leaves that queue meanwhile, or none is sent and the pane
/// says how many (review of #863, item 2).
#[gpui::test]
fn held_keys_that_do_not_join_all_reach_the_loop_or_none_is_sent(cx: &mut TestAppContext) {
    use crate::tmux_snapshot::browser::loop_admits;
    // The bound itself (33) comes last, so the harm shows first without it.
    for keys in [32usize, 100, 512, 33] {
        // The size of the real channel to the terminal loop.
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                live(view, cx);
                receiver.try_iter().for_each(drop);
                let state = dropped(view, false);
                view.apply_browser_state(Some(state), cx);
                let typed: Vec<&str> = (0..keys)
                    .map(|i| if i % 2 == 0 { "k" } else { "enter" })
                    .collect();
                type_keys(view, &typed, window, cx);
                // Refused together: the pane says how many.
                let refused = view.input_interrupted;
                let not_sent = if refused { keys } else { 0 };
                assert_eq!(view.connection.keys_not_sent, not_sent, "{keys} keys");
                let state = back(view);
                view.apply_browser_state(Some(state), cx);
                // The loop's queue, with nothing leaving it: the worst case.
                let mut queue = std::collections::VecDeque::new();
                for _ in 0..keys {
                    for command in receiver.try_iter() {
                        assert!(
                            loop_admits(&mut queue, command),
                            "{keys} keys: the loop refused a held key after {}",
                            queue.len()
                        );
                    }
                    if view.pending_input.is_none() {
                        break;
                    }
                    view.browser_tick(cx);
                }
                let got: Vec<String> = queue
                    .into_iter()
                    .filter_map(|command| match command {
                        browser::Command::Input {
                            input: Input::Text(text) | Input::Key(text),
                            ..
                        } => Some(text),
                        _ => None,
                    })
                    .collect();
                if refused {
                    assert!(got.is_empty(), "{keys} keys: a part was sent");
                } else {
                    let expected: Vec<&str> = (0..keys)
                        .map(|i| if i % 2 == 0 { "k" } else { "Enter" })
                        .collect();
                    assert_eq!(got, expected, "{keys} keys");
                }
                assert_eq!(refused, keys > 32, "{keys} keys: the bound is 32 inputs");
            })
        });
    }
}
