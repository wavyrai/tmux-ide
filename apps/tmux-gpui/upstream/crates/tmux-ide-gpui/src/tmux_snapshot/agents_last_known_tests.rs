//! Last-known agent marks (#362 follow-up): shown only once the drop has
//! lasted long enough for quiet reconnect's words (#357's 8 s), and drawn in
//! the muted ink, with "needs input" kept visible and tagged.
use super::*;
use crate::tmux_snapshot::{
    connection::{Clock, WORDS_AFTER},
    fit_test_support::fixture_view,
};
use core::prelude::v1::test;
use gpui::{TestAppContext, VisualTestContext};
use std::{cell::Cell, rc::Rc, sync::mpsc, time::Duration};

fn clock() -> (Clock, Rc<Cell<Duration>>) {
    let start = std::time::Instant::now();
    let wall = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let offset = Rc::new(Cell::new(Duration::ZERO));
    let read = offset.clone();
    (
        Rc::new(move || (start + read.get(), wall + read.get())),
        offset,
    )
}

/// A session window whose stream dropped, with the agent lane paused.
fn dropped(
    cx: &mut TestAppContext,
    last_known: bool,
) -> (
    Entity<SnapshotView>,
    &mut VisualTestContext,
    Rc<Cell<Duration>>,
) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let state = crate::tmux_snapshot::browser::State {
        surface: crate::tmux_snapshot::browser::Surface::Workspace,
        request: 7,
        input_ready: true,
        ..Default::default()
    };
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, at) = clock();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.connection.clock = clock;
            view.browser_state.agents_last_known = last_known;
            view.browser_state.reconnect_attempt = Some(1);
            view.observe_connection(cx);
        })
    });
    (view, cx, at)
}

#[gpui::test]
fn last_known_marks_show_from_the_words_threshold_on(cx: &mut TestAppContext) {
    let (view, cx, at) = dropped(cx, true);
    for (after, shown) in [
        (Duration::ZERO, false),
        (WORDS_AFTER - Duration::from_millis(100), false),
        (WORDS_AFTER, true),
        (Duration::from_secs(600), true),
    ] {
        at.set(after);
        view.read_with(cx, |view, _| {
            assert_eq!(view.agents_shown_last_known(), shown, "{after:?}");
        });
    }
    // The link is back but the re-read hasn't landed: the rows are still the
    // old ones, so the mark stays (review round 2).
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.reconnect_attempt = None;
            view.observe_connection(cx);
        })
    });
    view.read_with(cx, |view, _| assert!(view.agents_shown_last_known()));
    // The re-read clears the flag, and the mark with it.
    view.update(cx, |view, _| view.browser_state.agents_last_known = false);
    view.read_with(cx, |view, _| assert!(!view.agents_shown_last_known()));
    // A later pause that never reaches the words is not marked: the mark
    // was for the drop that showed them.
    view.update(cx, |view, _| view.browser_state.agents_last_known = true);
    view.read_with(cx, |view, _| assert!(!view.agents_shown_last_known()));
}

/// The re-read clears the mark even when nothing draws an agent between it
/// and the next pause (review r2): the next drop isn't marked from 0 s.
#[gpui::test]
fn the_re_read_clears_the_mark_without_a_draw(cx: &mut TestAppContext) {
    let (view, cx, at) = dropped(cx, true);
    at.set(Duration::from_secs(600));
    view.read_with(cx, |view, _| assert!(view.agents_shown_last_known()));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            // The link is back and the re-read lands, through the mailbox.
            let mut state = view.browser_state.clone();
            state.reconnect_attempt = None;
            state.agents_last_known = false;
            view.apply_browser_state(Some(state), cx);
            view.observe_connection(cx);
            // A new drop pauses the lane again; nothing has drawn since.
            view.browser_state.agents_last_known = true;
            view.browser_state.reconnect_attempt = Some(1);
            view.observe_connection(cx);
        })
    });
    at.set(Duration::from_secs(601));
    view.read_with(cx, |view, _| assert!(!view.agents_shown_last_known()));
}

/// Fresh agent state is never drawn as last known, however long the wait.
#[gpui::test]
fn current_agents_are_never_muted(cx: &mut TestAppContext) {
    let (view, cx, at) = dropped(cx, false);
    at.set(Duration::from_secs(600));
    view.read_with(cx, |view, _| assert!(!view.agents_shown_last_known()));
}

/// A last-known "needs input" mark stays loud (the attention pill, as an away
/// machine's does) and only its words say it may be old.
#[test]
fn a_last_known_needs_input_mark_is_loud_and_tagged() {
    assert_eq!(last_known_words(), "Needs input · last known");
    assert_eq!(LAST_KNOWN, "last known");
}
