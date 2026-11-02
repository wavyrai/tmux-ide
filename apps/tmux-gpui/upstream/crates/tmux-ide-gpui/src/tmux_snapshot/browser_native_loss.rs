//! What a lost terminal stream asks of the catalog: re-issue this exact route.
use super::{
    Active, Command, NativeError, browser_native_actions, browser_native_input,
    browser_native_owner,
};

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
