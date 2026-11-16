//! Group H (owner, 16 Nov): images live only in the daemon, so a daemon
//! restart loses them while tmux keeps their placeholder cells, which then
//! paint blank. Image bytes never go to disk; instead the window says so,
//! until the program redraws and the image arrives again.
use std::time::{Duration, Instant};

/// True for every way the daemon loses an image while its placeholders stay:
/// a restart, the memory budget's eviction, or the program deleting it.
pub(super) const NOTICE: &str = "Some images are no longer available; redraw to see them.";

/// Placeholders of an image that is still on its way are not a notice: when a
/// pane opens, its cells can arrive a moment before its images.
pub(super) const SETTLE: Duration = Duration::from_secs(1);

#[derive(Default)]
pub(super) struct Watch {
    since: Option<Instant>,
    /// The UI task already woke once to show this notice.
    woke: bool,
}

impl Watch {
    /// `lost`: a pane on screen shows placeholders for an image the daemon
    /// does not hold. Anything else clears the notice at once.
    pub fn observe(&mut self, lost: bool, now: Instant) {
        if !lost {
            self.since = None;
            self.woke = false;
        } else if self.since.is_none() {
            self.since = Some(now);
        }
    }

    pub fn notice(&self, now: Instant) -> Option<&'static str> {
        let since = self.since?;
        (now.saturating_duration_since(since) >= SETTLE).then_some(NOTICE)
    }

    /// When the notice falls due, so an idle UI task wakes once to show it.
    pub fn due_at(&self) -> Option<Instant> {
        (!self.woke)
            .then_some(self.since)
            .flatten()
            .map(|since| since + SETTLE)
    }

    /// Whether the notice fell due by `now` and this is the wake for it.
    /// Start the notice as a frame would, for tests of the UI task.
    #[cfg(test)]
    pub fn hold_for_test(&mut self, now: Instant) {
        self.observe(true, now);
    }

    pub fn take_due(&mut self, now: Instant) -> bool {
        let due = self.due_at().is_some_and(|at| at <= now);
        self.woke |= due;
        due
    }
}

impl super::SnapshotView {
    /// Note whether the workspace on screen shows images the daemon lost.
    pub(super) fn observe_images_lost(&mut self, now: Instant) {
        let lost = self.browsing
            && self.browser_state.surface == super::browser::Surface::Workspace
            && !self.browser_state.retained_preview
            && self.browser_state.images_lost;
        self.images_lost.observe(lost, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lost_images_are_a_notice_after_a_second_until_they_arrive() {
        let start = Instant::now();
        let mut watch = Watch::default();
        watch.observe(true, start);
        assert_eq!(
            watch.notice(start + SETTLE - Duration::from_millis(1)),
            None
        );
        // Later frames that still show them keep the start time.
        watch.observe(true, start + Duration::from_millis(600));
        assert_eq!(watch.notice(start + SETTLE), Some(NOTICE));
        // The program redrew: the image is back, the notice gone at once.
        watch.observe(false, start + SETTLE * 2);
        assert_eq!(watch.notice(start + SETTLE * 9), None);
    }

    #[test]
    fn the_notice_wakes_the_ui_once() {
        let start = Instant::now();
        let mut watch = Watch::default();
        assert_eq!(watch.due_at(), None);
        watch.observe(true, start);
        assert_eq!(watch.due_at(), Some(start + SETTLE));
        assert!(!watch.take_due(start + SETTLE - Duration::from_millis(1)));
        assert!(watch.take_due(start + SETTLE));
        assert_eq!(watch.due_at(), None);
        watch.observe(true, start + SETTLE * 2);
        assert_eq!(watch.due_at(), None);
        watch.observe(false, start + SETTLE * 3);
        watch.observe(true, start + SETTLE * 4);
        assert_eq!(watch.due_at(), Some(start + SETTLE * 5));
    }

    /// The notice takes the status slot after a second, when the status has
    /// nothing else to say, and only on a workspace; it goes when the image is back.
    #[gpui::test]
    fn the_status_says_images_were_lost_until_they_arrive(cx: &mut gpui::TestAppContext) {
        let (sender, _receiver) = std::sync::mpsc::sync_channel(8);
        let (view, cx) = cx.add_window_view(|window, cx| {
            super::super::fit_test_support::fixture_view(
                window,
                cx,
                sender,
                7,
                super::super::browser::State {
                    request: 7,
                    surface: super::super::browser::Surface::Workspace,
                    input_ready: true,
                    status: "Connected".into(),
                    images_lost: true,
                    ..Default::default()
                },
            )
        });
        view.update(cx, |view, cx| {
            let now = cx.background_executor().now();
            // The fixture's own frame is not the size it fits; that notice is not
            // this test's subject.
            view.window_size = Default::default();
            view.observe_images_lost(now);
            assert_eq!(view.status_or_window_size_notice(now), "Connected");
            assert_eq!(view.status_or_window_size_notice(now + SETTLE), NOTICE);
            view.browser_state.status = "Server unreachable".into();
            assert_eq!(
                view.status_or_window_size_notice(now + SETTLE),
                "Server unreachable"
            );
            view.browser_state.status = "Connected".into();
            // The image arrived.
            view.browser_state.images_lost = false;
            view.observe_images_lost(now + SETTLE);
            assert_eq!(
                view.status_or_window_size_notice(now + SETTLE * 2),
                "Connected"
            );
            // Home shows no panes: no notice there.
            view.browser_state.images_lost = true;
            view.browser_state.surface = super::super::browser::Surface::Home;
            view.observe_images_lost(now);
            assert_eq!(
                view.status_or_window_size_notice(now + SETTLE * 2),
                "Connected"
            );
        });
    }
}
