#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{
    browser,
    connection::{self, Clock, Stage},
    fit_test_support::fixture_view,
};
use gpui::{Modifiers, TestAppContext, VisualTestContext};
use std::{cell::Cell, rc::Rc, sync::mpsc, time::SystemTime};

const S: fn(u64) -> Duration = Duration::from_millis;

fn clock() -> (Clock, Instant, Rc<Cell<Duration>>) {
    let start = Instant::now();
    let wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let offset = Rc::new(Cell::new(Duration::ZERO));
    let read = offset.clone();
    (
        Rc::new(move || (start + read.get(), wall + read.get())),
        start,
        offset,
    )
}

fn held(since: Instant, ms: u64, too_large: bool) -> PaneHeld {
    PaneHeld {
        since,
        retry_in: S(ms),
        too_large,
    }
}

#[test]
fn the_card_says_why_and_counts_down_in_whole_seconds() {
    let at = Instant::now();
    let large = held(at, 12_000, true);
    assert_eq!(
        held_words(large, at),
        "Can't open this session: a pane's scrollback is too long to send. \
         Clear it with tmux clear-history, or wait. Trying again in 12 s."
    );
    assert_eq!(
        held_words(large, at + S(500)),
        "Can't open this session: a pane's scrollback is too long to send. \
         Clear it with tmux clear-history, or wait. Trying again in 12 s."
    );
    assert!(held_words(large, at + S(1_000)).ends_with("Trying again in 11 s."));
    assert!(held_words(large, at + S(11_001)).ends_with("Trying again in 1 s."));
    assert!(held_words(large, at + S(12_000)).ends_with("Trying again…"));
    assert!(held_words(large, at + S(60_000)).ends_with("Trying again…"));
    assert_eq!(
        held_words(held(at, 2_000, false), at),
        "Can't open this session: tmux could not send a pane twice in a row. Trying again in 2 s."
    );
}

fn session_held(held: PaneHeld) -> browser::State {
    browser::State {
        surface: browser::Surface::Workspace,
        request: 7,
        input_ready: true,
        status: "Connected".into(),
        reconnect_attempt: Some(5),
        pane_held: Some(held),
        panes: vec![
            serde_json::from_value(serde_json::json!({
                "id": "pane-a", "label": "editor", "windowId": "window-1", "paneCount": null,
                "windowLabel": "editor"
            }))
            .unwrap(),
        ],
        selected_pane: Some("pane-a".into()),
        ..Default::default()
    }
}

fn open(
    cx: &mut TestAppContext,
    state: browser::State,
    clock: Clock,
) -> (
    gpui::Entity<SnapshotView>,
    &mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.connection.clock = clock;
            view.observe_connection(cx);
        })
    });
    (view, cx, receiver)
}

/// From the first held close, with no 2 s wait; the slot never says offline.
#[gpui::test]
fn a_held_session_says_so_at_once_in_the_card_and_the_slot(cx: &mut TestAppContext) {
    let (clock, start, at) = clock();
    let (view, cx, _receiver) = open(cx, session_held(held(start, 12_000, true)), clock);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-reconnect-card").is_some());
    let card = view.read_with(cx, |view, _| view.reconnect_card()).unwrap();
    assert!(card.ends_with("Trying again in 12 s."), "{card}");
    at.set(S(70_000));
    let (card, stage, words) = view.read_with(cx, |view, _| {
        (
            view.reconnect_card().unwrap(),
            view.connection_stage(),
            view.connection_words(),
        )
    });
    assert!(card.ends_with("Trying again…"), "{card}");
    assert_eq!(stage, Stage::Words);
    assert_eq!(words, HELD);
    // Without a hold the same drop is offline by now, as before.
    view.update(cx, |view, _| view.browser_state.pane_held = None);
    let (stage, words) = view.read_with(cx, |view, _| {
        (view.connection_stage(), view.connection_words())
    });
    assert_eq!(stage, Stage::Offline);
    assert_eq!(words, connection::RECONNECTING);
}

/// "Retry now" sends one try and reads "Trying…" until the next hold.
#[gpui::test]
fn retry_now_reads_trying_until_the_answer_and_sends_once(cx: &mut TestAppContext) {
    let (clock, start, at) = clock();
    let (view, cx, receiver) = open(cx, session_held(held(start, 30_000, false)), clock);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    while receiver.try_recv().is_ok() {}
    at.set(S(500));
    let retry = cx.debug_bounds("tmux-reconnect-retry").unwrap();
    cx.simulate_click(retry.center(), Modifiers::none());
    assert!(view.read_with(cx, |view, _| view.retry_trying()));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let retry = cx.debug_bounds("tmux-reconnect-retry").unwrap();
    cx.simulate_click(retry.center(), Modifiers::none());
    let sent: Vec<_> = (receiver.try_iter())
        .map(|c| serde_json::to_value(c).unwrap())
        .filter(|c| c["type"] == "retry-reconnect")
        .collect();
    assert_eq!(sent.len(), 1, "{sent:?}");
    // The daemon answers with a new hold: the button is "Retry now" again.
    at.set(S(900));
    view.update(cx, |view, _| {
        view.browser_state.pane_held = Some(held(start + S(900), 4_000, false));
    });
    assert!(!view.read_with(cx, |view, _| view.retry_trying()));
    // No answer at all: "Trying…" gives up after 10 s.
    view.update(cx, |view, _| {
        view.connection.retry_asked_at = Some(start + S(1_000))
    });
    at.set(S(10_999));
    assert!(view.read_with(cx, |view, _| view.retry_trying()));
    at.set(S(11_000));
    assert!(!view.read_with(cx, |view, _| view.retry_trying()));
}

#[gpui::test]
fn a_hold_once_the_stream_is_back_says_nothing(cx: &mut TestAppContext) {
    let (clock, start, _at) = clock();
    let mut state = session_held(held(start, 12_000, true));
    state.reconnect_attempt = None;
    let (view, cx, _receiver) = open(cx, state, clock);
    assert_eq!(view.read_with(cx, |view, _| view.reconnect_card()), None);
    assert_ne!(view.read_with(cx, |view, _| view.connection_words()), HELD);
}
