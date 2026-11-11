//! Retrying a lost connection now (card #702). The footer slot's "Offline
//! since…" button is the only manual retry (r1); it only asks the catalog to
//! try now, and reconnection keeps its own identity checks.
use super::{SnapshotView, browser};

impl SnapshotView {
    /// Send the retry for the request the button was drawn for, never a newer one.
    pub(super) fn retry_reconnect(&self, request: u64) -> bool {
        self.browser_state.reconnect_attempt.is_some()
            && self.browser_state.request == request
            && self.browser_commands.as_ref().is_some_and(|sender| {
                sender
                    .try_send(browser::Command::RetryReconnect { request })
                    .is_ok()
            })
    }
}

#[cfg(test)]
#[path = "reconnect_retry_tests.rs"]
mod tests;
