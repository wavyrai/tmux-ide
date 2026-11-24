//! The worker's own ping. Its answer measures the round trip, and a ping left
//! unanswered while nothing else arrives finds a dead link in [`Pinger::limit`]
//! instead of the daemon's heartbeat limit (40 s by default): a link that died
//! while the Mac slept, or behind an SSH forward on a network that went away.
//!
//! Any WebSocket peer answers a ping, so this needs nothing from the daemon. A
//! busy link is never judged dead: output that keeps arriving counts as heard,
//! even when the answer waits behind it.
use std::time::{Duration, Instant};

/// How long a ping may wait for its answer while nothing at all arrives.
pub(super) fn pong_limit() -> Duration {
    #[cfg(test)]
    if let Some(ms) = PONG_LIMIT_MS.with(std::cell::Cell::get) {
        return Duration::from_millis(ms);
    }
    Duration::from_secs(5)
}
#[cfg(test)]
thread_local! {
    /// Tests shorten the limit for streams spawned on their thread.
    pub(super) static PONG_LIMIT_MS: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}
/// A command sent after this long without hearing anything is followed by a
/// ping, so keys typed into a dead link are found [`pong_limit`] later, not at
/// the next period. A live link that echoes keys never needs one.
const QUIET: Duration = Duration::from_secs(1);

pub(super) struct Pinger {
    outstanding: Option<([u8; 8], Instant)>,
    next: Instant,
    every: Duration,
    limit: Duration,
}
impl Pinger {
    /// The first ping after one period: until then, input ACKs give the round
    /// trip estimate, or the reveal hold uses its cap.
    pub(super) fn new(every: Duration, limit: Duration) -> Self {
        Self {
            outstanding: None,
            next: Instant::now() + every,
            every,
            limit,
        }
    }
    /// Whether to ping now: none is outstanding, and the period passed, a probe
    /// asked for one, or a command just went out on a quiet link.
    pub(super) fn due(&self, now: Instant, heard: Instant, probe: bool, sent: bool) -> bool {
        self.outstanding.is_none()
            && (now >= self.next
                || probe
                || (sent && now.saturating_duration_since(heard) >= QUIET))
    }
    pub(super) fn sent(&mut self, payload: [u8; 8], now: Instant) {
        self.outstanding = Some((payload, now));
        self.next = now + self.every;
    }
    /// The answer to the outstanding ping: its round trip.
    pub(super) fn pong(&mut self, payload: &[u8]) -> Option<Duration> {
        let (_, at) = self
            .outstanding
            .filter(|(sent, _)| payload == sent.as_slice())?;
        self.outstanding = None;
        Some(at.elapsed())
    }
    /// The link is dead: the ping has waited the limit, and nothing at all
    /// arrived for as long.
    pub(super) fn dead(&self, heard: Instant, now: Instant) -> bool {
        self.outstanding.is_some_and(|(_, at)| {
            now.saturating_duration_since(at) >= self.limit
                && now.saturating_duration_since(heard) >= self.limit
        })
    }
    /// When the worker must be awake to send the next ping or judge the link.
    pub(super) fn wake_at(&self, heard: Instant) -> Instant {
        match self.outstanding {
            Some((_, at)) => at.max(heard) + self.limit,
            None => self.next,
        }
    }
}
