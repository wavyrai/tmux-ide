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
    // The link is back: marks are current again whatever the flag says until
    // the re-read lands (it clears the flag, #362).
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.reconnect_attempt = None;
            view.observe_connection(cx);
        })
    });
    view.read_with(cx, |view, _| assert!(!view.agents_shown_last_known()));
}

/// Fresh agent state is never drawn as last known, however long the wait.
#[gpui::test]
fn current_agents_are_never_muted(cx: &mut TestAppContext) {
    let (view, cx, at) = dropped(cx, false);
    at.set(Duration::from_secs(600));
    view.read_with(cx, |view, _| assert!(!view.agents_shown_last_known()));
}

/// The last-known pill is the attention pill's shape in the muted ink, still
/// readable at the pill's own 4.6:1 on every plate.
#[test]
fn the_last_known_pill_is_muted_and_readable() {
    let theme = crate::config::Theme::default();
    for on in [Plate::Chrome, Plate::Sidebar, Plate::Header] {
        let (wash, ink) = last_known_pill_colors(&theme, on);
        let (attention_wash, attention) = attention_pill_colors(&theme, on);
        assert_ne!(ink, attention, "{on:?}: not the attention colour");
        assert_ne!(wash, attention_wash, "{on:?}");
        let packed = u32::from(Rgba::from(wash)) >> 8;
        assert!(crate::contrast::ratio(ink, packed) >= 4.5, "{on:?}");
    }
    assert_eq!(LAST_KNOWN, "last known");
}
