//! Brief motion for things that come and go in the window chrome: tabs, the
//! notes panel, notes. Each is a function of when it started and the time
//! now, so a frame never depends on the one before it, and a view keeps
//! drawing frames only while something is still moving.
use std::time::{Duration, Instant};

/// How long something takes to grow in.
pub(crate) const ENTER: Duration = Duration::from_millis(180);
/// How long something takes to shrink out; leaving is a little quicker.
pub(crate) const LEAVE: Duration = Duration::from_millis(150);

/// How far a motion that began at `since` has come at `now`, eased out, or
/// `None` once it is done.
pub(crate) fn progress(since: Instant, now: Instant, length: Duration) -> Option<f32> {
    let k = now.saturating_duration_since(since).as_secs_f32() / length.as_secs_f32();
    (k < 1.).then(|| 1. - (1. - k.clamp(0., 1.)).powi(3))
}

/// Something that opens and closes, such as a panel: how much of it shows.
/// Only the notes panel uses one, and only builds that show pages have it.
#[cfg(any(target_os = "macos", windows, test))]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Toggle {
    open: bool,
    /// When it last opened or closed; `None` before either, so a panel
    /// that is open when first drawn is simply there.
    since: Option<Instant>,
}

#[cfg(any(target_os = "macos", windows, test))]
impl Toggle {
    /// Opens or closes it at `now`. The first report sets where it is
    /// without moving, as a view first drawn shows what it has.
    pub(crate) fn set(&mut self, open: bool, now: Instant, first: bool) {
        if first {
            *self = Self { open, since: None };
            return;
        }
        if open != self.open {
            // Reversing mid-way starts from where it is, not from an end.
            let shown = self.shown(now);
            let length = if open { ENTER } else { LEAVE };
            let done = if open { shown } else { 1. - shown };
            // Inverts the ease: the time at which it would have come this far.
            let back = length.mul_f32(1. - (1. - done.clamp(0., 1.)).cbrt());
            self.open = open;
            self.since = Some(now.checked_sub(back).unwrap_or(now));
        }
    }

    /// How much of it shows at `now`, from 0 closed to 1 open.
    pub(crate) fn shown(&self, now: Instant) -> f32 {
        let length = if self.open { ENTER } else { LEAVE };
        let k = self
            .since
            .and_then(|since| progress(since, now, length))
            .unwrap_or(1.);
        if self.open { k } else { 1. - k }
    }

    /// Whether it is still opening or closing.
    pub(crate) fn moving(&self, now: Instant) -> bool {
        let length = if self.open { ENTER } else { LEAVE };
        self.since
            .is_some_and(|since| progress(since, now, length).is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_eases_out_and_ends() {
        let start = Instant::now();
        assert_eq!(progress(start, start, ENTER), Some(0.));
        let half = progress(start, start + ENTER / 2, ENTER).unwrap_or_default();
        assert!(half > 0.8 && half < 1., "{half}");
        assert_eq!(progress(start, start + ENTER, ENTER), None);
        // A start still ahead reads as not begun.
        assert_eq!(progress(start + ENTER, start, ENTER), Some(0.));
    }

    #[test]
    fn a_toggle_opens_closes_and_starts_still() {
        let start = Instant::now();
        let mut panel = Toggle::default();
        panel.set(true, start, true);
        assert_eq!(panel.shown(start), 1.);
        assert!(!panel.moving(start));
        panel.set(false, start, false);
        assert_eq!(panel.shown(start), 1.);
        assert!(panel.moving(start));
        assert_eq!(panel.shown(start + LEAVE), 0.);
        assert!(!panel.moving(start + LEAVE));
        panel.set(true, start + LEAVE, false);
        assert_eq!(panel.shown(start + LEAVE), 0.);
        assert_eq!(panel.shown(start + LEAVE + ENTER), 1.);
        // Closing half-open continues from where it is.
        let mid = start + LEAVE + ENTER + ENTER;
        panel.set(false, mid, false);
        panel.set(true, mid, false);
        let shown = panel.shown(mid);
        assert!(shown > 0.9, "{shown}");
    }
}
