//! A session the daemon holds back (#872): one of its panes failed to open
//! twice in a row, and a 2.9.28 daemon closed the stream saying so, with the
//! time until it tries again and why. The pane card says the session cannot
//! open, why, and when it is tried again, from the first such close; the
//! footer slot and the window's status say "Can't open this session" in
//! place of "Reconnecting…" and the attempt count. "Retry now" asks the
//! daemon to try at once (`retryAskedByPerson`) and reads "Trying…" until
//! the answer comes.
use super::super::{SnapshotView, browser::PaneHeld};
use std::time::{Duration, Instant};

/// The footer slot's and the window status's words while a pane is held.
pub(in crate::tmux_snapshot) const HELD: &str = "Can't open this session";
/// "Retry now" while the try it asked for runs.
pub(in crate::tmux_snapshot) const TRYING: &str = "Trying…";
/// How long "Trying…" waits for an answer before "Retry now" comes back.
const TRYING_LIMIT: Duration = Duration::from_secs(10);

/// The pane card's words for a hold, `now` by the watch's clock.
pub(in crate::tmux_snapshot) fn held_words(held: PaneHeld, now: Instant) -> String {
    let cause = if held.too_large {
        "Can't open this session: a pane's scrollback is too long to send. \
         Clear it with tmux clear-history, or wait."
    } else {
        "Can't open this session: tmux could not send a pane twice in a row."
    };
    let left = held
        .retry_in
        .saturating_sub(now.saturating_duration_since(held.since));
    // Whole seconds, rounded up: "1 s" until the moment it is due.
    let seconds = left.as_millis().div_ceil(1_000);
    if seconds == 0 {
        format!("{cause} Trying again…")
    } else {
        format!("{cause} Trying again in {seconds} s.")
    }
}

impl SnapshotView {
    /// The daemon's hold of the open session, while it reconnects.
    pub(in crate::tmux_snapshot) fn pane_held(&self) -> Option<PaneHeld> {
        self.browser_state
            .pane_held
            .filter(|_| self.browser_state.reconnect_attempt.is_some())
    }

    /// The pane card's words for a hold, by the watch's clock.
    pub(in crate::tmux_snapshot) fn held_card(&self) -> Option<String> {
        let held = self.pane_held()?;
        let (now, _) = (self.connection.clock)();
        Some(held_words(held, now))
    }

    /// A person's retry was sent and no answer has come since: no new hold,
    /// no open stream, and not longer than [`TRYING_LIMIT`].
    pub(in crate::tmux_snapshot) fn retry_trying(&self) -> bool {
        let Some(asked) = self.connection.retry_asked_at else {
            return false;
        };
        // The ask is forgotten when the wait ends (`observe_connection`).
        let (now, _) = (self.connection.clock)();
        now.saturating_duration_since(asked) < TRYING_LIMIT
            && self.pane_held().is_none_or(|held| held.since < asked)
    }

    /// "Retry now", or "Trying…" while the try it asked for runs.
    pub(in crate::tmux_snapshot) fn retry_now_label(&self) -> &'static str {
        if self.retry_trying() {
            TRYING
        } else {
            super::RETRY_NOW
        }
    }

    /// Repaints once a second while a hold's countdown shows, and when
    /// "Trying…" runs out.
    pub(in crate::tmux_snapshot) fn wake_for_held(&mut self, cx: &mut gpui::Context<Self>) {
        if self.pane_held().is_none() && self.connection.retry_asked_at.is_none() {
            self.connection._held_wake = None;
            return;
        }
        if self.connection._held_wake.is_some() {
            return;
        }
        self.connection._held_wake = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let going = this.update(cx, |view, cx| {
                    cx.notify();
                    view.pane_held().is_some() || view.retry_trying()
                });
                if !matches!(going, Ok(true)) {
                    let _ = this.update(cx, |view, _| view.connection._held_wake = None);
                    return;
                }
            }
        }));
    }
}

#[cfg(test)]
#[path = "connection_held_tests.rs"]
mod tests;
