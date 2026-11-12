//! What a lost terminal stream costs and asks of the catalog: queued keys are
//! dropped and reported, the frame is held read-only, and the catalog is asked
//! to re-issue this exact route (card #702).
use super::{
    Active, Cause, Command, NativeError, State, browser_native_actions, browser_native_input,
    browser_native_owner, diagnostics, hold::Hold,
};
use std::collections::VecDeque;

/// Re-leases for a pane split into the session from another client. The
/// stream's lease names the session's panes when it was issued, so a pane
/// added later fails the layout as `Unissued`. Re-opening the route leases the
/// current panes. At most `RELEASES` per request within `WINDOW_MS`, so an
/// inventory that still lacks the pane falls back to the reconnect backoff.
#[derive(Default)]
pub(super) struct Releases {
    request: u64,
    at: VecDeque<u64>,
    stall: Stall,
}
const RELEASES: usize = 3;
const WINDOW_MS: u64 = 10_000;
/// A stream in the active window that shows frames but was never given input
/// (seen in the soak after the daemon refused a stream as unavailable: the
/// window said "Connecting…" until refreshed). After [`STALL_MS`] it is
/// replaced like a lost stream, at most [`STALLS`] times per request: a pane
/// that can take no input (its program exited) is then left as it is.
#[derive(Default)]
struct Stall {
    request: u64,
    replaced: usize,
    /// The route that is waiting for input, and since when.
    waiting: Option<(String, u64)>,
}
const STALL_MS: u64 = 10_000;
const STALLS: usize = 2;
impl Stall {
    /// Whether the route `id` has now waited [`STALL_MS`] for input.
    fn expired(&mut self, request: u64, id: &str, waiting: bool, now: u64) -> bool {
        if self.request != request {
            *self = Self {
                request,
                ..Self::default()
            };
        }
        if !waiting || self.replaced >= STALLS {
            self.waiting = None;
            return false;
        }
        match &self.waiting {
            Some((route, since)) if route == id => {
                if now.saturating_sub(*since) < STALL_MS {
                    return false;
                }
            }
            _ => {
                self.waiting = Some((id.to_owned(), now));
                return false;
            }
        }
        self.waiting = None;
        self.replaced += 1;
        true
    }
}
impl Releases {
    /// Passes a poll result on, or fails it once `current` has waited
    /// [`STALL_MS`] for input in the active window.
    pub(super) fn stalled(
        &mut self,
        polled: Result<bool, NativeError>,
        current: &Active,
        foreground: bool,
        now: u64,
    ) -> Result<bool, NativeError> {
        let dirty = polled?;
        let waiting = foreground
            && !current.catalog_only
            && !current.stream_interrupted
            && !current.controller.input_ready()
            && !current.owner.busy();
        if (self.stall).expired(current.request, &current.id, waiting, now) {
            return Err(NativeError::Controller(
                herdr_client::tmux_controller::Error::Transport(
                    herdr_client::tmux_stream::Error::ReadyTimeout,
                ),
            ));
        }
        Ok(dirty)
    }
}
impl Releases {
    /// Whether this poll error is a pane-set change to re-lease for now.
    pub(super) fn admit(&mut self, error: &NativeError, request: u64, now: u64) -> bool {
        if !matches!(
            error,
            NativeError::Controller(herdr_client::tmux_controller::Error::Topology(
                herdr_client::tmux_topology::Error::Unissued
            ))
        ) {
            return false;
        }
        if self.request != request {
            self.request = request;
            self.at.clear();
        }
        self.at.retain(|at| now.saturating_sub(*at) < WINDOW_MS);
        if self.at.len() >= RELEASES {
            return false;
        }
        self.at.push_back(now);
        true
    }
}

/// Queued keys are never replayed onto a new stream. Whether any were dropped.
fn drop_queued_input(pending: &mut VecDeque<Command>) -> bool {
    let before = pending.len();
    pending.retain(|command| !matches!(command, Command::Input { .. }));
    pending.len() != before
}
/// The stream under `current` failed with `error`. Keys in flight or queued
/// die with it, so the held frame says they were not sent; so does a key that
/// went unanswered until the scheduler gave it up (an input error). Returns
/// the re-issue notice.
pub(super) fn stream_lost(
    current: &Active,
    pending: &mut VecDeque<Command>,
    hold: &mut Hold,
    state: &State,
    presence_revision: u64,
    error: &NativeError,
) -> Command {
    let queued = drop_queued_input(pending);
    let unanswered = matches!(error, NativeError::Input(_));
    hold.begin(state, queued || unanswered || current.input.busy());
    interrupted(current, presence_revision, diagnostics::cause(error))
}
/// A command failed in a way `fatal` says leaves the stream unusable. It is
/// recovered like a lost stream. Keys are reported lost only when the failed
/// command was input, or input was in flight or queued.
pub(super) fn command_failed(
    active: Option<&Active>,
    failed_input: bool,
    pending: &mut VecDeque<Command>,
    hold: &mut Hold,
    state: &State,
    presence_revision: u64,
) -> Option<Command> {
    let queued = drop_queued_input(pending);
    let in_flight = active.is_some_and(|a| a.input.busy());
    hold.begin(state, failed_input || queued || in_flight);
    active.map(|a| interrupted(a, presence_revision, Cause::Lost))
}

/// The catalog matches this against its open route before it reconnects.
pub(super) fn interrupted(current: &Active, presence_revision: u64, cause: Cause) -> Command {
    Command::NativeTerminalInterrupted {
        version: 1,
        id: current.id.clone(),
        request: current.request,
        pane: current.controller.selected().into(),
        live_session_id: current.session.clone(),
        generation: current.generation.clone(),
        presence_revision,
        cause,
    }
}

/// Whether a failed command leaves the stream unusable. Busy, stale or refused
/// work is not; anything else is, and is recovered like a lost stream.
pub(super) fn fatal(result: &Result<(), NativeError>, active: Option<&Active>) -> bool {
    match result {
        Ok(()) => false,
        Err(NativeError::Input(
            browser_native_input::Error::Scope
            | browser_native_input::Error::Unsupported
            | browser_native_input::Error::Scheduler(herdr_client::tmux_input::Error::Busy),
        )) => active.is_some_and(|a| a.input.retired()),
        Err(NativeError::Owner(browser_native_owner::Error::Rejected)) => false,
        Err(NativeError::Action(
            browser_native_actions::Error::Stale | browser_native_actions::Error::BrokerRequired,
        )) => false,
        Err(NativeError::Action(browser_native_actions::Error::Controller(
            herdr_client::tmux_controller::Error::Control(
                herdr_client::tmux_control::Error::Busy
                | herdr_client::tmux_control::Error::Lifetime,
            ),
        ))) => false,
        Err(_) => true,
    }
}

#[cfg(test)]
#[path = "browser_native_loss_tests.rs"]
mod tests;
