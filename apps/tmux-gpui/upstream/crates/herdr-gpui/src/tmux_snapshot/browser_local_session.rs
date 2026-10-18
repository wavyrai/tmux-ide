use super::{Error, HomePhase, Publication, Surface};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Capability {
    pub action: String,
}

pub(super) fn validate(p: &Publication, surface: Surface) -> Result<(), Error> {
    let Some(capability) = &p.local_session_create else {
        return Ok(());
    };
    if capability.action.len() != 36
        || uuid::Uuid::parse_str(&capability.action).is_err()
        || surface != Surface::Home
        || p.home.as_ref().is_none_or(|h| h.phase != HomePhase::Live)
        || p.local_setup.is_some()
        || p.selected_server.is_some()
        || p.snapshot.is_some()
        || p.retained_preview.is_some()
        || p.input_ready
        || p.selected_pane.is_some()
        || p.selected_session.is_some()
        || p.preferred_pane.is_some()
        || !p.sessions.is_empty()
        || !p.panes.is_empty()
        || p.history_offset != 0
        || p.copy_region.is_some()
        || !p.regions.is_empty()
        || p.resize_token.is_some()
        || p.split_layout.is_some()
        || p.split_gesture.is_some()
        || p.resize_gesture.is_some()
        || p.resize_gesture_supported
        || p.pane_actions.is_some()
    {
        return Err(Error::Invalid("Invalid local session creation authority"));
    }
    Ok(())
}
#[cfg(test)]
#[path = "browser_local_session_tests.rs"]
mod tests;
