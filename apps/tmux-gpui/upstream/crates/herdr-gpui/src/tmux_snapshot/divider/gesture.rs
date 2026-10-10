//! Bounded latest-target transport on the existing 16ms browser tick.
use super::*;
use std::{
    sync::mpsc::TrySendError,
    time::{Duration, Instant},
};
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum Phase {
    Dragging,
    Pending,
    Settled,
    Failed,
    Cancelled,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::tmux_snapshot) struct Ack {
    pub gesture: String,
    pub id: String,
    pub axis: Axis,
    pub phase: Phase,
    pub revision: u64,
    pub token: Option<String>,
    pub cells: u16,
}
impl Ack {
    pub fn valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.gesture).is_ok()
            && !self.id.is_empty()
            && self.id.len() <= 512
            && self.revision <= 9_007_199_254_740_991
            && self.cells >= 2
            && self.cells <= if self.axis == Axis::Rows { 500 } else { 1000 }
            && self
                .token
                .as_ref()
                .is_none_or(|t| uuid::Uuid::parse_str(t).is_ok())
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum Update {
    Begin { token: String, cells: u16 },
    Move { cells: u16 },
    Release { cells: u16 },
    Cancel,
}
struct Active {
    request: u64,
    session: String,
    selected: String,
    presence_revision: u64,
    bounds: Bounds<Pixels>,
    cell_width: f32,
    gesture: String,
    id: String,
    axis: Axis,
    token: String,
    canonical: Option<canonical::Target>,
    initial: u16,
    desired: u16,
    sent: u16,
    begun: bool,
    released: bool,
    terminal_sent: bool,
    cancel: bool,
    cancel_sent: bool,
    revision: u64,
    progress: Instant,
    awaiting_ack: bool,
}
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Owner {
    active: Option<Active>,
}
impl Owner {
    pub fn busy(&self) -> bool {
        self.active.is_some()
    }
    pub(super) fn begin(&mut self, drag: &Drag) {
        let Some(gesture) = drag.gesture.clone() else {
            return;
        };
        self.active = Some(Active {
            request: drag.request,
            session: drag.session.clone(),
            selected: drag.selected.clone(),
            presence_revision: drag.presence_revision,
            bounds: drag.bounds,
            cell_width: drag.cell_width,
            gesture,
            id: drag.split.id.clone(),
            axis: drag.split.axis,
            token: drag.token.clone(),
            canonical: drag.split.canonical.clone(),
            initial: drag.split.cells,
            desired: drag.cells,
            sent: drag.split.cells,
            begun: false,
            released: false,
            terminal_sent: false,
            cancel: false,
            cancel_sent: false,
            revision: 0,
            progress: Instant::now(),
            awaiting_ack: false,
        });
    }
    pub(super) fn offer(&mut self, cells: u16, release: bool) {
        if let Some(a) = self.active.as_mut()
            && !a.cancel
            && !a.terminal_sent
        {
            if !a.awaiting_ack && a.desired == a.sent {
                a.progress = Instant::now();
            }
            a.desired = cells;
            a.released |= release;
        }
    }
    fn target_current(
        &self,
        state: &browser::State,
        bounds: Option<Bounds<Pixels>>,
        width: Option<f32>,
    ) -> bool {
        self.active.as_ref().is_none_or(|a| {
            state.request == a.request
                && state.selected_session.as_ref() == Some(&a.session)
                && state.selected_pane.as_ref() == Some(&a.selected)
                && state.presence_revision == a.presence_revision
                && bounds == Some(a.bounds)
                && width == Some(a.cell_width)
        })
    }
    pub fn observe(&mut self, state: &browser::State) {
        let Some(a) = self.active.as_mut() else {
            return;
        };
        let (phase, revision, target_valid) = if let Some(original) = a.canonical.as_ref() {
            let Some(ack) = state
                .split_gesture
                .as_ref()
                .filter(|ack| ack.gesture == a.gesture)
            else {
                return;
            };
            let valid = ack.target.as_ref().is_none_or(|target| {
                target.window == original.window
                    && state
                        .split_layout
                        .as_ref()
                        .is_some_and(|layout| layout.contains(target, a.axis))
            });
            (ack.phase, ack.revision, valid)
        } else {
            let Some(ack) = state
                .resize_gesture
                .as_ref()
                .filter(|ack| ack.gesture == a.gesture)
            else {
                return;
            };
            (
                ack.phase,
                ack.revision,
                ack.id == a.id && ack.axis == a.axis,
            )
        };
        if state.request != a.request || !target_valid || revision < a.revision {
            a.cancel = true;
            return;
        }
        if revision > a.revision {
            a.progress = Instant::now();
        }
        a.revision = revision;
        a.awaiting_ack = phase == Phase::Pending;
        if matches!(phase, Phase::Failed | Phase::Cancelled)
            || (a.terminal_sent && phase == Phase::Settled)
        {
            self.active = None;
        }
    }
    pub fn flush(
        &mut self,
        sender: &std::sync::mpsc::SyncSender<browser::Command>,
        gesture_present: bool,
        current: bool,
    ) -> bool {
        self.flush_at(sender, gesture_present, current, Instant::now())
    }
    pub(super) fn flush_at(
        &mut self,
        sender: &std::sync::mpsc::SyncSender<browser::Command>,
        gesture_present: bool,
        current: bool,
        now: Instant,
    ) -> bool {
        let Some(a) = self.active.as_mut() else {
            return false;
        };
        let waiting = !a.begun
            || a.cancel
            || a.terminal_sent
            || a.awaiting_ack
            || a.desired != a.sent
            || a.released;
        let stalled =
            waiting && now.saturating_duration_since(a.progress) > Duration::from_secs(10);
        if stalled && now.saturating_duration_since(a.progress) > Duration::from_secs(12) {
            self.active = None;
            return true;
        }
        if !current || (!gesture_present && !a.released) || stalled {
            a.cancel = true;
        }
        if a.cancel && !a.begun {
            self.active = None;
            return false;
        }
        let update = if a.cancel {
            if a.cancel_sent {
                return false;
            }
            Update::Cancel
        } else if !a.begun {
            Update::Begin {
                token: a.token.clone(),
                cells: a.initial,
            }
        } else if a.terminal_sent {
            return false;
        } else if a.released {
            Update::Release { cells: a.desired }
        } else if a.desired != a.sent {
            Update::Move { cells: a.desired }
        } else {
            return false;
        };
        let command = if let Some(target) = a.canonical.as_ref() {
            let update = match update {
                Update::Begin { .. } => canonical::Update::Begin {
                    target: target.clone(),
                    axis: a.axis,
                },
                Update::Move { cells } => canonical::Update::Move { boundary: cells },
                Update::Release { cells } => canonical::Update::Release { boundary: cells },
                Update::Cancel => canonical::Update::Cancel,
            };
            browser::Command::SplitGesture {
                request: a.request,
                gesture: a.gesture.clone(),
                update,
            }
        } else {
            browser::Command::ResizeGesture {
                request: a.request,
                gesture: a.gesture.clone(),
                id: a.id.clone(),
                axis: a.axis,
                update,
            }
        };
        match sender.try_send(command) {
            Ok(()) => {
                if a.cancel {
                    a.cancel_sent = true;
                    a.terminal_sent = true;
                    a.progress = now;
                } else if !a.begun {
                    a.begun = true;
                    a.awaiting_ack = true;
                    a.progress = now;
                } else {
                    a.sent = a.desired;
                    a.terminal_sent = a.released;
                    a.awaiting_ack = true;
                    a.progress = now;
                }
                false
            }
            Err(TrySendError::Full(_)) => false, // retain control/final target, never replay a queued command
            Err(TrySendError::Disconnected(_)) => {
                self.active = None;
                true
            }
        }
    }
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn flush_resize_gesture(&mut self, cx: &mut Context<Self>) {
        let Some(sender) = self.browser_commands.as_ref() else {
            self.resize_gesture = Default::default();
            return;
        };
        let current = self.resize_gesture.target_current(
            &self.browser_state,
            self.input_geometry.map(|g| g.0),
            self.input_cell_width,
        ) && self.presence.ready()
            && self.browser_state.surface == browser::Surface::Workspace
            && self.browser_request == self.browser_state.request
            && self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
            && self.selection.is_none();
        if self
            .resize_gesture
            .flush(sender, self.divider.is_some(), current)
        {
            self.divider = None;
            self.browser_commands = None;
            self.browser_state.input_ready = false;
            self.browser_state.status = "Pane resize connection unavailable".into();
            cx.notify();
        }
        if self.divider.as_ref().is_some_and(|d| d.gesture.is_some()) && !self.resize_gesture.busy()
        {
            self.divider = None;
            cx.notify();
        }
    }
}
