//! The daemon's WebSocket heartbeat, as a client sees it. A daemon that pings
//! says so in a header of the upgrade response (HTTP 101):
//! `x-tmux-ide-heartbeat: interval-ms=10000, missed-limit=3`. Only then may
//! silence be read as a dead connection. Without the header (tmux-ide 2.9.22
//! and older) the daemon sends no pings and no deadline is safe.
use std::time::Duration;

pub const HEADER: &str = "x-tmux-ide-heartbeat";
const MIN_INTERVAL_MS: u64 = 250;
const MAX_INTERVAL_MS: u64 = 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Heartbeat {
    interval: Duration,
    missed_limit: u32,
}
impl Heartbeat {
    /// The advertised cadence, or `None` for an absent or malformed header.
    pub fn advertised<T>(response: &tungstenite::http::Response<T>) -> Option<Self> {
        Self::parse(response.headers().get(HEADER)?.to_str().ok()?)
    }
    /// Exactly what the daemon writes (contracts/websocket-heartbeat.ts);
    /// anything else is no heartbeat.
    pub fn parse(value: &str) -> Option<Self> {
        let (interval, limit) = value.split_once(", ")?;
        let interval = number(interval.strip_prefix("interval-ms=")?, 7)?;
        let limit = number(limit.strip_prefix("missed-limit=")?, 2)?;
        if !(MIN_INTERVAL_MS..=MAX_INTERVAL_MS).contains(&interval) {
            return None;
        }
        Some(Self {
            interval: Duration::from_millis(interval),
            missed_limit: u32::try_from(limit).ok()?,
        })
    }
    /// How long nothing at all may arrive before the peer counts as gone: the
    /// pings the daemon itself would give up after, plus one interval, so a
    /// ping that is only late never ends a connection.
    pub fn silence(&self) -> Duration {
        self.interval.saturating_mul(self.missed_limit + 1)
    }
}
/// A positive decimal with no leading zero and at most `digits` digits.
fn number(text: &str, digits: usize) -> Option<u64> {
    if text.is_empty()
        || text.len() > digits
        || text.starts_with('0')
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    text.parse().ok()
}
