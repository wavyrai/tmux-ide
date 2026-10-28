//! Bounded never-dispatched input for explicit pane selection or focus reclamation.
mod focus_reclaim;
mod history;
mod viewport;
use super::{SnapshotView, browser, keys::Input};
pub(super) use focus_reclaim::PaintedFocus;
use gpui::Context;
use serde::Deserialize;
use std::time::{Duration, Instant};

#[derive(Clone, Deserialize, PartialEq, Eq)]
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
enum Kind {
    Selection,
    Focus,
    Viewport { cols: u16, rows: u16 },
    History { offset: u32 },
}
pub(super) struct Pending {
    kind: Kind,
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
            kind: Kind::Selection,
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
            && match self.kind {
                Kind::Selection | Kind::Viewport { .. } | Kind::History { .. } => {
                    view.browser_state.presence_revision == self.presence && view.presence.ready()
                }
                Kind::Focus => {
                    view.presence.queued_active_revision() == Some(self.presence)
                        && view.browser_state.presence_revision <= self.presence
                }
            }
            && !view.input_interrupted
            && view.browser_state.surface == browser::Surface::Workspace
            && !view.browser_state.input_target_rejected
            && !view.browser_state.retained_preview
            && match self.kind {
                Kind::History { offset } => {
                    view.browser_state.history_offset == offset
                        || view.browser_state.history_offset == 0
                }
                _ => view.browser_state.history_offset == 0,
            }
            && view.picker.is_none()
            && view.pane_actions.is_none()
            && view.new_session.is_none()
            && view.selection.is_none()
            && view.divider.is_none()
            && view.browser_commands.is_some()
            && match self.kind {
                Kind::Selection => view
                    .browser_state
                    .input_targets
                    .iter()
                    .any(|t| t.id == self.id && t.token == self.token),
                // A resize temporarily removes targets while layout and rows converge.
                // Missing proof permits holding only; dispatch still requires the exact token.
                Kind::Viewport { .. } => view
                    .browser_state
                    .input_targets
                    .iter()
                    .find(|t| t.id == self.id)
                    .is_none_or(|t| t.token == self.token),
                Kind::Focus | Kind::History { .. } => view
                    .browser_state
                    .native_focus_target
                    .as_ref()
                    .is_some_and(|t| t.id == self.id && t.token == self.token),
            }
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
        if self.pending_input.is_none()
            || !self.terminal_input_ready()
            || self.browser_state.request != self.browser_request
        {
            return;
        }
        if self.pending_input.as_ref().is_some_and(|pending| {
            matches!(pending.kind, Kind::Viewport { cols, rows }
                if self.frame.as_ref().is_none_or(|f| f.view().width() != cols || f.view().height() != rows))
        }) {
            return;
        }
        let valid_frame = self
            .frame
            .as_ref()
            .zip(self.browser_state.copy_region.as_ref())
            .is_some_and(|(frame, region)| {
                region.valid_view(frame.view(), self.browser_state.selected_pane.as_deref())
            });
        if !valid_frame {
            self.cancel_pending_input(cx);
            return;
        }
        if self.pending_input.as_ref().is_some_and(|pending| {
            !self
                .browser_state
                .input_targets
                .iter()
                .any(|t| t.id == pending.id && t.token == pending.token)
        }) {
            self.cancel_pending_input(cx);
            return;
        }
        let Some(mut pending) = self.pending_input.take() else {
            return;
        };
        while !pending.inputs.is_empty() {
            let command = browser::Command::Input {
                input_target: Some(pending.token.clone()),
                request: pending.request,
                id: pending.id.clone(),
                input: pending.inputs.remove(0),
            };
            let Some(sender) = self.browser_commands.as_ref() else {
                self.interrupt_input(cx);
                return;
            };
            match sender.try_send(command) {
                Ok(()) => {}
                Err(std::sync::mpsc::TrySendError::Full(command)) => {
                    // Retain only never-dispatched input, with its original deadline.
                    let browser::Command::Input { input, .. } = command else {
                        unreachable!("only input is sent here");
                    };
                    pending.inputs.insert(0, input);
                    self.pending_input = Some(pending);
                    return;
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    self.interrupt_input(cx);
                    return;
                }
            }
        }
    }
}
#[cfg(test)]
mod tests;
