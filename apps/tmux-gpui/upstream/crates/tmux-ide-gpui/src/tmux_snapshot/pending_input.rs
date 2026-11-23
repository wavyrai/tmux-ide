//! Bounded never-dispatched input for explicit pane selection or focus reclamation.
mod focus_reclaim;
mod history;
mod reconnect;
mod reveal;
mod split;
mod viewport;
mod window_switch;
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
    Viewport {
        cols: u16,
        rows: u16,
    },
    History {
        offset: u32,
    },
    /// Typed after a split: the target is the pane the split creates, known
    /// only once the re-issued stream arrives (`split.rs`).
    Split(split::Hold),
    /// Typed while a dropped stream is put back: the target is the same pane,
    /// under the token its new stream gives it (`reconnect.rs`).
    Reconnect(reconnect::Hold),
    /// Typed after choosing a pane of another window of a session streamed by
    /// window (#806): the target is that pane, under the token its window's
    /// new stream gives it (`window_switch.rs`).
    Switch(window_switch::Hold),
    /// Typed while a window shown again waits for its fresh state: the target
    /// is the pane selected when it is up (`reveal.rs`).
    Reveal(reveal::Hold),
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
    /// A hold on history input, for tests outside this module.
    #[cfg(test)]
    pub(super) fn held_for_test(request: u64) -> Self {
        Self {
            kind: Kind::History { offset: 0 },
            request,
            id: "pane-a".into(),
            token: "token".into(),
            session: "session-a".into(),
            presence: 0,
            started: Instant::now(),
            inputs: Vec::new(),
            bytes: 0,
        }
    }
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
        if let Kind::Reconnect(hold) = &self.kind {
            return self.reconnect_compatible(hold, view);
        }
        if let Kind::Reveal(hold) = &self.kind {
            return self.reveal_compatible(hold, view);
        }
        // A split hold waits for the pane it created; one that was not
        // applied has nowhere to deliver.
        let waiting = matches!(&self.kind, Kind::Split(hold) if hold.waiting())
            || matches!(&self.kind, Kind::Switch(hold) if hold.waiting());
        !matches!(&self.kind, Kind::Split(hold) if hold.failed())
            && !matches!(&self.kind, Kind::Switch(hold) if hold.failed())
            && self.started.elapsed() < self.limit()
            && self.request == view.browser_request
            && (waiting || view.browser_state.selected_pane.as_ref() == Some(&self.id))
            && view.browser_state.selected_session.as_ref() == Some(&self.session)
            && match self.kind {
                Kind::Selection
                | Kind::Viewport { .. }
                | Kind::History { .. }
                | Kind::Split(_)
                | Kind::Switch(_)
                | Kind::Reconnect(_)
                | Kind::Reveal(_) => {
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
            && (waiting || !view.browser_state.retained_preview)
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
                Kind::Split(_) | Kind::Switch(_) if waiting => true,
                Kind::Selection
                | Kind::Split(_)
                | Kind::Switch(_)
                | Kind::Reconnect(_)
                | Kind::Reveal(_) => view
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
        let (keys, limit) = match self.kind {
            Kind::Reconnect(_) => (reconnect::MAX_KEYS, reconnect::MAX_BYTES),
            _ => (64, 65536),
        };
        if self.inputs.len() >= keys || bytes > limit.saturating_sub(self.bytes) {
            return false;
        }
        // No more than the queues behind the view take in one go.
        if matches!(self.kind, Kind::Reconnect(_))
            && reconnect::joined_len(self.inputs.iter().chain([&input])) > reconnect::MAX_INPUTS
        {
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
            pending.started = Instant::now() - Duration::from_secs(5);
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
            self.connection.keys_not_sent += pending.reconnect_keys();
            self.interrupt_input(cx);
        }
    }
    pub(super) fn expire_pending_input(&mut self, cx: &mut Context<Self>) {
        self.observe_split_hold();
        self.observe_switch_hold();
        self.observe_reconnect_hold();
        self.observe_reveal_hold();
        if self.pending_input.is_some() && !self.pending_input_ready() {
            self.cancel_pending_input(cx);
        }
        self.arm_reconnect_hold_wake(cx);
    }
    pub(super) fn hold_pending_input(&mut self, input: Input, cx: &mut Context<Self>) {
        self.expire_pending_input(cx);
        if self
            .pending_input
            .as_mut()
            .is_none_or(|pending| !pending.push(input))
        {
            // A full reconnect hold refuses this key too, and says so.
            if (self.pending_input.as_ref()).is_some_and(|p| matches!(p.kind, Kind::Reconnect(_))) {
                self.connection.keys_not_sent += 1;
            }
            self.interrupt_input(cx);
        }
    }
    pub(super) fn flush_pending_input(&mut self, cx: &mut Context<Self>) {
        self.expire_pending_input(cx);
        if self.pending_input.is_none()
            || !self.terminal_input_ready()
            || self.browser_state.request != self.browser_request
            || self.split_hold_waiting()
            || self.switch_hold_waiting()
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
        pending.join_reconnect_text();
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
                Ok(()) => pending.reconnect_delivering(),
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
