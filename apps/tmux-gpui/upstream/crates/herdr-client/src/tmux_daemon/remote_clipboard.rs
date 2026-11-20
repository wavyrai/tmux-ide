//! When a copy from a program in a pane may reach the pasteboard by itself.
//!
//! Owner decision (17 Nov 2026): silently only when the copy is plainly the
//! user's doing: the pane is the focused pane of the key window and the user
//! typed into that pane in the last 2 seconds. Anything else is an offer the
//! user accepts with a click. Nothing here reads the pasteboard.
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// How recent the user's input to the pane must be for a silent copy.
pub const RECENT_INPUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Write the pasteboard now and say so.
    Silent,
    /// Offer the copy on the pane; write only on the user's click.
    Ask,
}

/// What the window knows when a copy arrives.
#[derive(Clone, Copy, Debug)]
pub struct Focus<'a> {
    /// The window is the key window.
    pub window_active: bool,
    /// The pane that has the window's keyboard focus.
    pub selected_pane: Option<&'a str>,
}

/// The decision for a copy from `pane`, given when the user last sent input
/// to that same pane.
pub fn delivery(
    focus: Focus<'_>,
    pane: &str,
    last_input: Option<Instant>,
    now: Instant,
) -> Delivery {
    let focused = focus.window_active && focus.selected_pane == Some(pane);
    let recent = last_input
        .and_then(|at| now.checked_duration_since(at))
        .is_some_and(|age| age <= RECENT_INPUT);
    if focused && recent {
        Delivery::Silent
    } else {
        Delivery::Ask
    }
}

/// The last time the user sent input to each pane. Entries older than the
/// window are forgotten as new input arrives, so the map stays small.
#[derive(Default, Debug)]
pub struct InputLedger {
    last: HashMap<String, Instant>,
}

impl InputLedger {
    pub fn note(&mut self, pane: &str, at: Instant) {
        self.last.retain(|_, seen| {
            at.checked_duration_since(*seen)
                .is_none_or(|age| age <= RECENT_INPUT)
        });
        self.last.insert(pane.to_owned(), at);
    }
    pub fn last(&self, pane: &str) -> Option<Instant> {
        self.last.get(pane).copied()
    }
    #[cfg(test)]
    fn len(&self) -> usize {
        self.last.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn focus(window_active: bool, selected: Option<&str>) -> Focus<'_> {
        Focus {
            window_active,
            selected_pane: selected,
        }
    }

    #[test]
    fn silent_only_for_the_focused_pane_of_the_key_window_with_recent_input() {
        let now = Instant::now() + Duration::from_secs(60);
        let ms = |n: u64| Some(now - Duration::from_millis(n));
        // (window active, selected pane, last input to "a", expected)
        let table = [
            (true, Some("a"), ms(0), Delivery::Silent),
            (true, Some("a"), ms(500), Delivery::Silent),
            (true, Some("a"), ms(2000), Delivery::Silent),
            (true, Some("a"), ms(2001), Delivery::Ask),
            (true, Some("a"), ms(30_000), Delivery::Ask),
            (true, Some("a"), None, Delivery::Ask),
            // Another pane has focus.
            (true, Some("b"), ms(100), Delivery::Ask),
            (true, None, ms(100), Delivery::Ask),
            // The window is not the key window.
            (false, Some("a"), ms(100), Delivery::Ask),
            (false, Some("a"), None, Delivery::Ask),
            (false, Some("b"), ms(100), Delivery::Ask),
        ];
        for (active, selected, last, expected) in table {
            assert_eq!(
                delivery(focus(active, selected), "a", last, now),
                expected,
                "active={active} selected={selected:?} last={:?}",
                last.map(|at| now - at)
            );
        }
    }

    #[test]
    fn input_stamped_after_now_is_not_recent() {
        let now = Instant::now();
        let later = now + Duration::from_millis(1);
        assert_eq!(
            delivery(focus(true, Some("a")), "a", Some(later), now),
            Delivery::Ask
        );
    }

    #[test]
    fn input_to_another_pane_does_not_count() {
        let now = Instant::now() + Duration::from_secs(10);
        let mut ledger = InputLedger::default();
        ledger.note("b", now - Duration::from_millis(100));
        assert_eq!(ledger.last("a"), None);
        assert_eq!(
            delivery(focus(true, Some("a")), "a", ledger.last("a"), now),
            Delivery::Ask
        );
        ledger.note("a", now - Duration::from_millis(100));
        assert_eq!(
            delivery(focus(true, Some("a")), "a", ledger.last("a"), now),
            Delivery::Silent
        );
    }

    #[test]
    fn the_ledger_keeps_the_latest_input_and_forgets_old_panes() {
        let start = Instant::now();
        let mut ledger = InputLedger::default();
        ledger.note("a", start);
        ledger.note("b", start + Duration::from_millis(500));
        ledger.note("a", start + Duration::from_millis(1000));
        assert_eq!(ledger.last("a"), Some(start + Duration::from_millis(1000)));
        assert_eq!(ledger.len(), 2);
        // Exactly 2 s after b: b is still within the window.
        ledger.note("c", start + Duration::from_millis(2500));
        assert_eq!(ledger.len(), 3);
        ledger.note("c", start + Duration::from_millis(2501));
        assert_eq!(ledger.last("b"), None);
        assert_eq!(ledger.len(), 2);
        ledger.note("c", start + Duration::from_secs(10));
        assert_eq!(ledger.last("a"), None);
        assert_eq!(ledger.len(), 1);
    }

    #[test]
    fn an_input_stamped_earlier_never_forgets_a_later_one() {
        let start = Instant::now();
        let mut ledger = InputLedger::default();
        ledger.note("a", start + Duration::from_secs(1));
        ledger.note("b", start);
        assert_eq!(ledger.last("a"), Some(start + Duration::from_secs(1)));
        assert_eq!(ledger.last("b"), Some(start));
    }
}
