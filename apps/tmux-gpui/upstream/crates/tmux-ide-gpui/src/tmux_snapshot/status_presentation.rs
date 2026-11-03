//! Normal mode suppresses only known routine guidance, never unknown failures.
//! Authority still comes from the bridge; presentation cannot enable input.
pub(super) fn visible(status: &str, developer_mode: bool, input_ready: bool) -> bool {
    developer_mode
        || !input_ready
        || !matches!(
            status,
            "Connected" | "Keyboard ready" | "Keyboard ready — click terminal to type"
        )
}

impl super::SnapshotView {
    /// The connection status line. A key refused while the last frame is held
    /// during a reconnect says so at once (card #702: refuse with a notice).
    pub(super) fn status_line(&self) -> String {
        let state = &self.browser_state;
        if state.retained_preview {
            if state.reconnect_attempt.is_some() && self.input_interrupted {
                format!("{INPUT_REFUSED} — {}", state.status)
            } else if state.status.starts_with("Restoring terminal…")
                || state.reconnect_attempt.is_some()
            {
                state.status.clone()
            } else {
                format!("Restoring terminal… — {}", state.status)
            }
        } else if self.selection.is_some() {
            "Selecting captured frame — Cmd-C copies; Escape or click resumes".into()
        } else if state.input_target_rejected {
            "Input interrupted — reselect pane, then retype".into()
        } else if self.input_interrupted {
            format!(
                "Input interrupted; click terminal when ready, then retype — {}",
                state.status
            )
        } else {
            state.status.clone()
        }
    }
}
/// Shown when a key is refused because the stream is being re-established.
pub(super) const INPUT_REFUSED: &str = "Input refused while reconnecting";

#[cfg(test)]
mod tests;
