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
/// replaced like a lost stream, at most [`STALLS`] times in a row: a pane
/// that can take no input (its program exited) is then left as it is. In the
/// soak the daemon granted input again 21 s after such a close, so the limit
/// covers a minute. A stream that is given input ends the row: the next
/// stall in the same window is replaced again.
#[derive(Default)]
struct Stall {
    request: u64,
    replaced: usize,
    /// The route that is waiting for input, and since when.
    waiting: Option<(String, u64)>,
}
const STALL_MS: u64 = 10_000;
const STALLS: usize = 6;
impl Stall {
    /// Whether the route `id` has now waited [`STALL_MS`] for input.
    /// `granted`: the stream takes input now.
    fn expired(&mut self, request: u64, id: &str, waiting: bool, granted: bool, now: u64) -> bool {
        if self.request != request {
            *self = Self {
                request,
                ..Self::default()
            };
        }
        if granted {
            self.replaced = 0;
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
        let granted = current.controller.input_ready();
        let waiting = foreground
            && !current.catalog_only
            && !current.stream_interrupted
            && !granted
            && !current.owner.busy();
        if (self.stall).expired(current.request, &current.id, waiting, granted, now) {
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

/// A focus change for the stream under `current`. A stream that cannot take
/// it is dead though no poll has said so yet (soak, 23 Nov 2026: another
/// client's detach, then the window left 10 ms later), or it refuses the
/// change. It is retired here either way: a window that left never keeps a
/// stream that takes input, and the poll that follows reports the stream
/// lost, so the catalog re-issues the route. It never ends the loop (#871).
pub(super) fn presence(current: &mut Active, foreground: bool, revision: u64, now: u64) {
    if current.reissue || current.stream_interrupted {
        return;
    }
    if let Err(error) = current.controller.presence(foreground, revision, now) {
        eprintln!(
            "tmux-preview: focus change not sent, stream retired: {}",
            diagnostics::detail(&error.into())
        );
        current.controller.retire();
    }
}

/// Whether `command` is a key. A key for which no stream is open is about to
/// be dropped: the UI sent it before it saw the hold. The held frame then
/// reports lost keys (`changed` is set when that is news), so the keys the UI
/// holds after it are refused instead of running without it.
pub(super) fn key(
    command: &Command,
    active: Option<&Active>,
    hold: &mut Hold,
    changed: &mut bool,
) -> bool {
    let Command::Input { request, .. } = command else {
        return false;
    };
    if active.is_none_or(|a| a.request != *request) {
        *changed |= hold.keys_lost();
    }
    true
}
/// Queued keys are never replayed onto a new stream. Whether any were dropped.
fn drop_queued_input(pending: &mut VecDeque<Command>) -> bool {
    let before = pending.len();
    pending.retain(|command| !matches!(command, Command::Input { .. }));
    pending.len() != before
}

/// What the status line says once the window is back, when keys typed just
/// before it left were not sent (#875). It stays until the next command.
pub(super) const KEYS_NOT_SENT: &str =
    "Keys typed as the window lost focus were not sent. Type them again.";
/// What the status line says once a stream that was retired and replaced
/// under the window (a re-lease, a close or split, an owner operation) is
/// back, when keys queued for it were not sent (#877).
pub(super) const KEYS_DROPPED: &str =
    "Keys typed as the terminal reconnected were not sent. Type them again.";
/// Whether `command` is typing: text, a key, bytes or a paste. A fit, a
/// pointer or a wheel step is not.
fn typed(command: &Command) -> bool {
    use crate::tmux_snapshot::keys::Input;
    matches!(
        command,
        Command::Input {
            input: Input::Text(_) | Input::Key(_) | Input::Bytes(_) | Input::Paste(_),
            ..
        }
    )
}
/// The window left. Queued input is dropped: keys are never sent once the
/// window has left, because input belongs to the window in front. So is a
/// key the input scheduler admitted but has not sent (`focus_loss` cancels
/// it next). When any of them was typing, the window says so once it is back
/// (#875: a line typed 5 ms before the window left was lost with no notice).
/// The loop keeps that in `hold` until then: the stream may be lost or
/// re-leased while the window is away. So is the rest of a paste the focus
/// loss cuts. With no stream (it was lost and the UI sent keys before it saw
/// that), the keys belong to the held stream's session (#877).
pub(super) fn blur(pending: &mut VecDeque<Command>, active: Option<&mut Active>, hold: &mut Hold) {
    let queued = pending.iter().any(typed);
    pending.retain(|command| !matches!(command, Command::Input { .. }));
    let session = match active {
        Some(current) => (queued || unsent(current)).then(|| current.session.clone()),
        None => queued.then(|| hold.session().map(str::to_owned)).flatten(),
    };
    if let Some(session) = session {
        hold.carry_keys_not_sent(&session, KEYS_NOT_SENT);
    }
}
/// Whether typing admitted to the stream is still unsent: the key the input
/// scheduler holds back, or the rest of a paste.
fn unsent(current: &mut Active) -> bool {
    current.input.waiting_keys() || current.controller.paste_unsent()
}
/// The stream is retired and replaced under the window: a close or split
/// that retired it, a re-lease, or an owner operation that retires it before
/// its receipt. Queued keys, the key held back and the rest of a paste are
/// dropped, never replayed; keys already sent count as sent. When any of the
/// dropped ones was typing, the next stream of the session says so (#877).
pub(super) fn retired(current: &mut Active, pending: &mut VecDeque<Command>, hold: &mut Hold) {
    let dropped = pending.iter().any(typed) || unsent(current);
    current.input.focus_loss();
    pending.retain(|command| !matches!(command, Command::Input { .. }));
    if dropped {
        hold.carry_keys_not_sent(&current.session, KEYS_DROPPED);
    }
}
/// Typing that reached the loop after the window left is refused there, and
/// says so as [`blur`] does.
pub(super) fn refused(command: &Command, active: Option<&Active>, hold: &mut Hold) {
    if let Some(current) = active
        && typed(command)
    {
        hold.carry_keys_not_sent(&current.session, KEYS_NOT_SENT);
    }
}

/// The stream is lost while it says that keys were not sent, perhaps before
/// anyone read it: the next stream of its session says it again. Nothing is
/// re-sent.
fn carry(current: &Active, hold: &mut Hold) {
    for notice in [KEYS_NOT_SENT, KEYS_DROPPED] {
        if current.action_status.is(notice) {
            hold.carry_keys_not_sent(&current.session, notice);
        }
    }
}
/// Polls the stream. Once the window is back and the stream takes input, it
/// takes over a "keys not sent" for its session and shows it in the same
/// publication, until the next command.
pub(super) fn poll(
    current: &mut Active,
    hold: &mut Hold,
    state: &mut State,
    foreground: bool,
    now: u64,
) -> Result<bool, NativeError> {
    let dirty = current.poll(state, foreground, now)?;
    if foreground
        && current.controller.input_ready()
        && let Some(notice) = hold.take_keys_not_sent(&current.session)
    {
        current.action_status.set(Some(notice));
        current.action_status.publish(&mut state.status);
        return Ok(true);
    }
    Ok(dirty)
}

#[cfg(test)]
#[path = "browser_native_blur_tests.rs"]
mod blur_tests;
#[cfg(test)]
#[path = "browser_native_drop_tests.rs"]
mod drop_tests;
#[cfg(test)]
#[path = "browser_native_loop_harness.rs"]
mod harness;
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
    carry(current, hold);
    hold.begin(state, queued || unanswered || current.input.busy());
    hold.held_session(&current.session);
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
    if let Some(current) = active {
        carry(current, hold);
    }
    hold.begin(state, failed_input || queued || in_flight);
    if let Some(current) = active {
        hold.held_session(&current.session);
    }
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

#[cfg(test)]
#[path = "browser_native_presence_tests.rs"]
mod presence_tests;
