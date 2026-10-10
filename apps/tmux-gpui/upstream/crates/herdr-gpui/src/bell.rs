//! The window's reaction to terminal bells. Herdr forwards a pane's BEL to its
//! foreground client and leaves the reaction to it, as an outer terminal's own
//! bell settings would; `[bell]` is that setting here.

use crate::config::BellConfig;
use std::time::{Duration, Instant};

/// A burst of bells rings once: a bell inside this interval of the last one
/// that rang is dropped, not deferred, so a program spamming BEL cannot keep
/// the Dock bouncing or queue up alert sounds.
pub(crate) const MIN_INTERVAL: Duration = Duration::from_millis(500);

/// What one ring does, already filtered by the setting and window focus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Ring {
    pub(crate) attention: bool,
    pub(crate) sound: bool,
}

#[derive(Default)]
pub(crate) struct Bell {
    pending: bool,
    last: Option<Instant>,
}

impl Bell {
    /// Records bells drained from the selected connection.
    pub(crate) fn queue(&mut self, count: u16) {
        self.pending |= count > 0;
    }

    /// Takes the queued bell. Attention is only asked for while the window
    /// is inactive; a ring that would do nothing does not start the interval.
    pub(crate) fn take(&mut self, config: BellConfig, active: bool, now: Instant) -> Option<Ring> {
        if !std::mem::take(&mut self.pending) {
            return None;
        }
        if self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) < MIN_INTERVAL)
        {
            return None;
        }
        let ring = Ring {
            attention: config.attention && !active,
            sound: config.sound,
        };
        if !ring.attention && !ring.sound {
            return None;
        }
        self.last = Some(now);
        Some(ring)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOTH: BellConfig = BellConfig {
        attention: true,
        sound: true,
    };

    #[test]
    fn nothing_queued_never_rings() {
        let mut bell = Bell::default();
        bell.queue(0);
        assert_eq!(bell.take(BOTH, false, Instant::now()), None);
    }

    #[test]
    fn attention_is_only_requested_while_the_window_is_inactive() {
        let now = Instant::now();
        let mut bell = Bell::default();
        bell.queue(1);
        assert_eq!(
            bell.take(BOTH, false, now),
            Some(Ring {
                attention: true,
                sound: true
            })
        );
        let mut bell = Bell::default();
        bell.queue(1);
        assert_eq!(
            bell.take(BOTH, true, now),
            Some(Ring {
                attention: false,
                sound: true
            })
        );
    }

    #[test]
    fn disabled_settings_ring_nothing_and_do_not_start_the_interval() {
        let now = Instant::now();
        let mut bell = Bell::default();
        let off = BellConfig {
            attention: false,
            sound: false,
        };
        bell.queue(3);
        assert_eq!(bell.take(off, false, now), None);
        // Attention alone does nothing while the window is focused.
        bell.queue(1);
        assert_eq!(bell.take(BellConfig::default(), true, now), None);
        bell.queue(1);
        assert!(bell.take(BellConfig::default(), false, now).is_some());
    }

    #[test]
    fn a_burst_rings_once_per_interval_and_is_dropped_not_deferred() {
        let start = Instant::now();
        let mut bell = Bell::default();
        bell.queue(u16::MAX);
        assert!(bell.take(BOTH, false, start).is_some());
        bell.queue(1);
        assert_eq!(bell.take(BOTH, false, start + MIN_INTERVAL / 2), None);
        // The dropped bell does not ring later on its own.
        assert_eq!(bell.take(BOTH, false, start + MIN_INTERVAL), None);
        bell.queue(1);
        assert!(bell.take(BOTH, false, start + MIN_INTERVAL).is_some());
    }
}
