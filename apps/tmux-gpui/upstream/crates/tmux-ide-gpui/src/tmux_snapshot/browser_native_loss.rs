//! What a lost terminal stream costs and asks of the catalog: queued keys are
//! dropped and reported, the frame is held read-only, and the catalog is asked
//! to re-issue this exact route (card #702).
use super::{
    Active, Command, NativeError, State, browser_native_actions, browser_native_input,
    browser_native_owner, hold::Hold,
};
use std::collections::VecDeque;

/// Queued keys are never replayed onto a new stream. Whether any were dropped.
fn drop_queued_input(pending: &mut VecDeque<Command>) -> bool {
    let before = pending.len();
    pending.retain(|command| !matches!(command, Command::Input { .. }));
    pending.len() != before
}
/// The stream under `current` failed. Keys in flight or queued die with it, so
/// the held frame says they were not sent. Returns the re-issue notice.
pub(super) fn stream_lost(
    current: &Active,
    pending: &mut VecDeque<Command>,
    hold: &mut Hold,
    state: &State,
    presence_revision: u64,
) -> Command {
    let queued = drop_queued_input(pending);
    hold.begin(state, queued || current.input.busy());
    interrupted(current, presence_revision)
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
    active.map(|a| interrupted(a, presence_revision))
}

/// The catalog matches this against its open route before it reconnects.
pub(super) fn interrupted(current: &Active, presence_revision: u64) -> Command {
    Command::NativeTerminalInterrupted {
        version: 1,
        id: current.id.clone(),
        request: current.request,
        pane: current.controller.selected().into(),
        live_session_id: current.session.clone(),
        generation: current.generation.clone(),
        presence_revision,
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
