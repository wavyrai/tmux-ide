//! Only never-dispatched input may wait across an explicitly captured pane selection.
use super::{SnapshotView, browser, keys::Input};
use gpui::Context;
use serde::Deserialize;
use std::time::{Duration, Instant};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    pub id: String,
    pub token: String,
}
pub(super) fn validate_targets(targets: &[Target]) -> Result<(), super::Error> {
    let mut ids = std::collections::HashSet::new();
    if targets.len() > 24
        || targets.iter().any(|t| {
            t.id.is_empty()
                || t.id.len() > 512
                || t.id.chars().any(char::is_control)
                || !ids.insert(&t.id)
                || t.token.len() != 64
                || !t
                    .token
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err(super::Error::Invalid("Invalid input targets"));
    }
    Ok(())
}
pub(super) struct Pending {
    request: u64,
    id: String,
    token: String,
    session: String,
    presence: u64,
    started: Instant,
    inputs: Vec<Input>,
    bytes: usize,
}
impl Pending {
    pub(super) fn capture(view: &SnapshotView, request: u64, id: &str) -> Option<Self> {
        if !view.terminal_input_ready()
            || view.input_interrupted
            || view.selection.is_some()
            || view.divider.is_some()
            || view.browser_state.history_offset != 0
        {
            return None;
        }
        let token = view
            .browser_state
            .input_targets
            .iter()
            .find(|t| t.id == id)?
            .token
            .clone();
        Some(Self {
            request,
            id: id.into(),
            token,
            session: view.browser_state.selected_session.clone()?,
            presence: view.browser_state.presence_revision,
            started: Instant::now(),
            inputs: Vec::new(),
            bytes: 0,
        })
    }
    fn compatible(&self, view: &SnapshotView) -> bool {
        self.started.elapsed() < Duration::from_secs(1)
            && self.request == view.browser_request
            && view.browser_state.selected_pane.as_ref() == Some(&self.id)
            && view.browser_state.selected_session.as_ref() == Some(&self.session)
            && view.browser_state.presence_revision == self.presence
            && view.presence.ready()
            && !view.input_interrupted
            && view.browser_state.surface == browser::Surface::Workspace
            && !view.browser_state.input_target_rejected
            && !view.browser_state.retained_preview
            && view.browser_state.history_offset == 0
            && view.picker.is_none()
            && view.pane_actions.is_none()
            && view.new_session.is_none()
            && view.selection.is_none()
            && view.divider.is_none()
            && view.browser_commands.is_some()
            && view
                .browser_state
                .input_targets
                .iter()
                .any(|t| t.id == self.id && t.token == self.token)
    }
    fn push(&mut self, input: Input) -> bool {
        let bytes = match &input {
            Input::Text(s) | Input::Paste(s) | Input::Key(s) | Input::Bytes(s) => s.len(),
            _ => return false,
        };
        if self.inputs.len() >= 64 || bytes > 65536usize.saturating_sub(self.bytes) {
            return false;
        }
        self.bytes += bytes;
        self.inputs.push(input);
        true
    }
}
impl SnapshotView {
    #[cfg(test)]
    pub(super) fn age_pending_input(&mut self) {
        if let Some(pending) = &mut self.pending_input {
            pending.started = Instant::now() - Duration::from_secs(2);
        }
    }
    pub(super) fn pending_input_ready(&self) -> bool {
        self.pending_input
            .as_ref()
            .is_some_and(|p| p.compatible(self))
    }
    pub(super) fn cancel_pending_input(&mut self, cx: &mut Context<Self>) {
        if let Some(pending) = self.pending_input.take()
            && (!pending.inputs.is_empty() || !self.marked.is_empty())
        {
            self.interrupt_input(cx);
        }
    }
    pub(super) fn expire_pending_input(&mut self, cx: &mut Context<Self>) {
        if self.pending_input.is_some() && !self.pending_input_ready() {
            self.cancel_pending_input(cx);
        }
    }
    pub(super) fn hold_pending_input(&mut self, input: Input, cx: &mut Context<Self>) {
        self.expire_pending_input(cx);
        if self
            .pending_input
            .as_mut()
            .is_none_or(|pending| !pending.push(input))
        {
            self.interrupt_input(cx);
        }
    }
    pub(super) fn flush_pending_input(&mut self, cx: &mut Context<Self>) {
        self.expire_pending_input(cx);
        if !self.terminal_input_ready() || self.browser_state.request != self.browser_request {
            return;
        }
        let valid_frame = self
            .frame
            .as_ref()
            .zip(self.browser_state.copy_region.as_ref())
            .is_some_and(|(frame, region)| {
                region.valid(frame, self.browser_state.selected_pane.as_deref())
            });
        if !valid_frame {
            self.cancel_pending_input(cx);
            return;
        }
        let Some(pending) = self.pending_input.take() else {
            return;
        };
        for input in pending.inputs {
            let command = browser::Command::Input {
                input_target: Some(pending.token.clone()),
                request: pending.request,
                id: pending.id.clone(),
                input,
            };
            if self
                .browser_commands
                .as_ref()
                .is_none_or(|sender| sender.try_send(command).is_err())
            {
                // Earlier items may have been dispatched. Never retry any of them.
                self.interrupt_input(cx);
                break;
            }
        }
    }
}
#[cfg(test)]
mod tests;
