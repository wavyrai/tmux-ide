//! #695: another tmux client holds this window at another size.
//!
//! Under tmux's `window-size latest` a terminal attached to the same session
//! takes the window, and output then prints at its width. The daemon wins the
//! window back when this app fits (on focus or a canvas change); this notice
//! covers the time in between, and window-size policies where it cannot.
use std::time::{Duration, Instant};

/// A mismatch shorter than this is a fit on its way to tmux, not a notice.
pub(super) const SETTLE: Duration = Duration::from_secs(1);

#[derive(Default)]
pub(super) struct Watch {
    since: Option<(Instant, (u16, u16))>,
}

impl Watch {
    /// `fitted` is the grid this window last asked tmux for, `shown` the grid
    /// tmux's frame has. Anything but a lasting difference clears the notice.
    pub fn observe(&mut self, fitted: Option<(u16, u16)>, shown: Option<(u16, u16)>, now: Instant) {
        match (fitted, shown) {
            (Some(fitted), Some(shown)) if fitted != shown => {
                if self.since.map(|(_, size)| size) != Some(shown) {
                    self.since = Some((now, shown));
                }
            }
            _ => self.since = None,
        }
    }

    /// The size another client holds the window at, notice due or not.
    #[cfg(test)]
    pub fn held(&self) -> Option<(u16, u16)> {
        self.since.map(|(_, size)| size)
    }

    pub fn notice(&self, now: Instant) -> Option<String> {
        let (since, (cols, rows)) = self.since?;
        (now.saturating_duration_since(since) >= SETTLE)
            .then(|| format!("Another tmux client is sizing this window ({cols}×{rows})"))
    }
}

impl super::SnapshotView {
    /// Compare the grid this window last fitted with the frame tmux painted.
    pub(super) fn observe_window_size(&mut self, frame: &super::DisplayFrame) {
        let fitted = (self.browsing
            && self.browser_state.surface == super::browser::Surface::Workspace
            && !self.browser_state.retained_preview)
            .then_some(self.last_resize)
            .flatten()
            .filter(|(request, _, _)| *request == self.browser_request)
            .map(|(_, cols, rows)| (cols, rows));
        let shown = (frame.view().width(), frame.view().height());
        self.window_size
            .observe(fitted, Some(shown), super::geometry::fit_now());
    }

    /// The status line, or the notice when the status has nothing to say.
    pub(super) fn status_or_window_size_notice(&self) -> String {
        let status = self.status_line();
        if super::status_presentation::visible(
            &status,
            self.developer_mode.enabled,
            self.browser_state.input_ready,
        ) {
            return status;
        }
        self.window_size
            .notice(super::geometry::fit_now())
            .unwrap_or(status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lasting_difference_is_a_notice_and_a_fit_in_flight_is_not() {
        let start = Instant::now();
        let mut watch = Watch::default();
        watch.observe(Some((97, 30)), Some((160, 40)), start);
        assert_eq!(watch.notice(start + Duration::from_millis(900)), None);
        // Still held when the next frame arrives: the start time stays.
        watch.observe(
            Some((97, 30)),
            Some((160, 40)),
            start + Duration::from_millis(500),
        );
        assert_eq!(
            watch.notice(start + SETTLE).as_deref(),
            Some("Another tmux client is sizing this window (160×40)")
        );
        // Another size starts over.
        watch.observe(Some((97, 30)), Some((120, 35)), start + SETTLE);
        assert_eq!(watch.notice(start + SETTLE), None);
        // tmux shows the fitted grid again: gone at once.
        watch.observe(Some((97, 30)), Some((97, 30)), start + SETTLE * 3);
        assert_eq!(watch.notice(start + SETTLE * 3), None);
        // No fit yet, or no frame: nothing to compare.
        watch.observe(None, Some((160, 40)), start);
        assert_eq!(watch.notice(start + SETTLE * 9), None);
        watch.observe(Some((97, 30)), None, start);
        assert_eq!(watch.notice(start + SETTLE * 9), None);
    }
    /// The notice takes the status slot only when the status has nothing to say.
    #[gpui::test]
    fn the_notice_shows_only_where_the_status_is_quiet(cx: &mut gpui::TestAppContext) {
        let (sender, _receiver) = std::sync::mpsc::sync_channel(8);
        let (view, cx) = cx.add_window_view(|window, cx| {
            super::super::fit_test_support::fixture_view(
                window,
                cx,
                sender,
                7,
                super::super::browser::State {
                    request: 7,
                    input_ready: true,
                    status: "Connected".into(),
                    ..Default::default()
                },
            )
        });
        view.update(cx, |view, _| {
            assert_eq!(view.status_or_window_size_notice(), "Connected");
            view.window_size.since = Some((super::super::geometry::fit_now() - SETTLE, (160, 40)));
            assert_eq!(
                view.status_or_window_size_notice(),
                "Another tmux client is sizing this window (160×40)"
            );
            view.browser_state.status = "Server unreachable".into();
            assert_eq!(view.status_or_window_size_notice(), "Server unreachable");
        });
    }
}
