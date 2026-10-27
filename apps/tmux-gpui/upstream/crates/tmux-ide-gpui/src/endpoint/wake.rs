//! Recovering connections after the machine sleeps. A link that died while
//! the machine slept is otherwise found only by the routine health check of a
//! quiet link, many seconds after waking.
//!
//! Sleep is told from the two clocks: the monotonic clock behind `Instant`
//! stops while macOS and Linux are suspended, and the wall clock does not. No
//! system notification is observed, which would need unsafe platform bindings.
//! A wall clock set forward looks the same, and costs only one extra ping.
//! Whether Windows' monotonic clock stops in sleep is unproven; SSH endpoints,
//! the links this matters for, are not supported there.
use crate::HerdrWindow;
use std::time::{Duration, Instant, SystemTime};

/// How far the wall clock must run ahead of the monotonic one to count as a
/// sleep. Long enough that scheduling jitter and small clock slews never do.
const SLEEP_GAP: Duration = Duration::from_secs(5);

pub(crate) struct WakeClock {
    instant: Instant,
    wall: SystemTime,
}

impl WakeClock {
    pub(crate) fn new(instant: Instant, wall: SystemTime) -> Self {
        Self { instant, wall }
    }

    /// Whether the machine slept since the last reading. A wall clock set
    /// backwards is no sleep.
    pub(crate) fn woke(&mut self, instant: Instant, wall: SystemTime) -> bool {
        let awake = instant.saturating_duration_since(self.instant);
        let passed = wall.duration_since(self.wall).unwrap_or_default();
        self.instant = instant;
        self.wall = wall;
        passed.saturating_sub(awake) >= SLEEP_GAP
    }
}

impl HerdrWindow {
    /// After a sleep, have every live connection prove itself now, and dial
    /// every dropped endpoint at once rather than at the end of its backoff:
    /// the network the user woke to may be the one it was waiting for.
    pub(crate) fn recover_after_sleep(&mut self, instant: Instant, wall: SystemTime) -> bool {
        if !self.wake.woke(instant, wall) {
            return false;
        }
        tracing::info!(category = "wake", "machine woke; checking connections");
        for endpoint in &mut self.endpoints {
            match &endpoint.connection.handle {
                Some(handle) => handle.check_liveness(),
                None => endpoint.retry_now(instant),
            }
        }
        true
    }
}

#[cfg(test)]
mod tests;
