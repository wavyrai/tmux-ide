#[path = "tmux_controller_pixels.rs"]
mod pixels;
#[path = "tmux_controller_projection.rs"]
mod projection;
pub use pixels::CellPixels;
#[path = "tmux_controller_selection.rs"]
mod selection;
pub use selection::SelectionCompletion;
// Native connection ownership: ordered controls and committed lifetimes precede UI actions.
// Call `poll` before admitting each UI command. All returned updates belong to this connection.
use crate::{
    tmux_control::{self, Authority, Input, InputCompletion, Lifetime, Policy},
    tmux_handoff::Handoff,
    tmux_native_session::{self, CommittedPane, NativeSession, PaneUpdate, Status},
    tmux_stream,
    tmux_topology::{self, Presentation, PresentedWindow, Topology},
};
use serde::Deserialize;
use serde_json::{json, value::RawValue};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native connection is retired")]
    Retired,
    #[error("native connection metadata is invalid")]
    Invalid,
    #[error("native control failed")]
    Control(#[from] tmux_control::Error),
    #[error("native session failed")]
    Session(#[from] tmux_native_session::Error),
    #[error("native session stopped")]
    Stopped(#[source] Arc<tmux_native_session::Error>),
    #[error("native topology failed")]
    Topology(#[from] tmux_topology::Error),
    #[error("native control encoding failed")]
    Json(#[from] serde_json::Error),
    #[error("native command rejected")]
    Transport(#[from] tmux_stream::Error),
}
pub struct Update {
    pub panes: BTreeMap<String, PaneUpdate>,
    pub window: Option<PresentedWindow>,
    pub inputs: Vec<InputCompletion>,
    pub controls: Vec<Box<RawValue>>,
    pub intents: Vec<tmux_control::IntentCompletion>,
    pub viewports: Vec<(u32, tmux_control::ViewportOutcome)>,
    pub geometry_timeouts: Vec<u32>,
    pub intent_timeouts: Vec<String>,
    pub presence_revision: Option<u64>,
    pub selection: Option<SelectionCompletion>,
    pub graphics: Vec<tmux_native_session::GraphicsEvent>,
    pub graphics_placements: BTreeMap<String, Arc<tmux_native_session::PaneGraphics>>,
    pub cell_pixels: bool,
    pub precise_cell_pixels: bool,
}
pub struct Controller {
    session: NativeSession,
    policy: Policy,
    topology: Topology,
    presentation: Presentation,
    cached_window: Option<PresentedWindow>,
    current: BTreeMap<String, Arc<CommittedPane>>,
    selected: String,
    pending_selection: Option<selection::PendingSelection>,
    actionable: bool,
    ready: bool,
    retired: bool,
    desired_presence: Option<(bool, u64)>,
    last_presence: Option<(bool, u64)>,
    viewport: Option<(u16, u16, String, u64)>,
    geometry_requested: bool,
    inflight_viewport: Option<(u16, u16, String)>,
    cell_pixels: Option<CellPixels>,
    sent_cell_pixels: Option<CellPixels>,
    materializing: BTreeMap<String, (String, String)>,
}
impl Controller {
    pub fn spawn(handoff: Handoff) -> Result<Self, Error> {
        let graphics = handoff.graphics;
        let binary_cells = handoff.binary_cells;
        let alternate_screen_projection = handoff.alternate_screen_projection;
        let local_images = handoff.local_images.clone();
        let (options, workspace, selected) = handoff.into_connection();
        let policy = Policy::new(
            options.descriptor.daemon_instance_id.clone(),
            workspace.clone(),
            options.host_client_id.clone(),
            options.descriptor.panes.clone(),
            options.descriptor.effective_viewer_mode == tmux_stream::ViewerMode::Interactive,
        )?;
        let topology = Topology::new(
            options.descriptor.daemon_instance_id.clone(),
            options.descriptor.panes.clone(),
        )?;
        let presentation = Presentation::new(selected.clone())?;
        Ok(Self {
            session: NativeSession::spawn_offered(
                options,
                workspace,
                graphics,
                local_images,
                binary_cells,
                alternate_screen_projection,
            )?,
            policy,
            topology,
            presentation,
            cached_window: None,
            current: BTreeMap::new(),
            selected,
            pending_selection: None,
            actionable: false,
            ready: false,
            retired: false,
            desired_presence: None,
            last_presence: None,
            viewport: None,
            geometry_requested: false,
            inflight_viewport: None,
            cell_pixels: None,
            sent_cell_pixels: None,
            materializing: BTreeMap::new(),
        })
    }
    pub fn retire(&mut self) {
        self.retired = true;
        self.actionable = false;
        self.pending_selection = None;
        self.policy.retire();
        self.topology.retire();
        self.presentation.reset();
        self.cached_window = None;
        self.current.clear();
        self.materializing.clear();
        self.viewport = None;
        self.inflight_viewport = None;
        self.cell_pixels = None;
        self.sent_cell_pixels = None;
        self.geometry_requested = false;
        self.session.cancel();
    }
    pub fn owns(&self, authority: Authority) -> bool {
        !self.retired
            && self.pending_selection.is_none()
            && self.desired_presence.is_none()
            && self.policy.owns(authority)
    }
    pub fn input_ready(&self) -> bool {
        self.actionable && self.owns(Authority::Input)
    }
    pub fn topology(&self) -> &Topology {
        &self.topology
    }
    pub fn graphics_missing(&self, digests: Vec<String>) -> Result<(), Error> {
        self.session
            .graphics_missing(digests)
            .map_err(Error::Session)
    }
    pub fn committed(&self, pane: &str) -> Option<&Arc<CommittedPane>> {
        self.current.get(pane)
    }
    /// Focus loss blocks new input immediately. Its wire release may wait for accepted input ACKs.
    pub fn presence(&mut self, active: bool, revision: u64, now: u64) -> Result<(), Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        let prior = self.desired_presence.or(self.last_presence);
        if prior.is_some_and(|(state, rev)| revision < rev || (revision == rev && state != active))
        {
            return Err(Error::Invalid);
        }
        if prior == Some((active, revision)) {
            return Ok(());
        }
        if !active {
            self.viewport = None;
            self.geometry_requested = false;
        }
        self.desired_presence = Some((active, revision));
        self.flush_presence(now)?;
        Ok(())
    }
    fn send(&mut self, command: tmux_control::Command) -> Result<(), Error> {
        let result = tmux_stream::Command::from_json(command.into_json())
            .map_err(Error::Transport)
            .and_then(|command| self.session.try_send(command).map_err(Error::Session));
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn flush_presence(&mut self, now: u64) -> Result<Option<u64>, Error> {
        let Some((active, revision)) = self.desired_presence else {
            return Ok(None);
        };
        if !self.ready {
            return Ok(None);
        }
        let input = uuid::Uuid::new_v4().to_string();
        let geometry = uuid::Uuid::new_v4().to_string();
        let commands = match self.policy.presence(active, &input, &geometry, now) {
            Ok(commands) => commands,
            Err(tmux_control::Error::Busy) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        for command in commands {
            self.send(command)?;
        }
        self.desired_presence = None;
        self.last_presence = Some((active, revision));
        Ok(Some(revision))
    }
    /// This is enqueue success only. Input completions arrive in subsequent ordered updates.
    pub fn input(
        &mut self,
        pane: &str,
        lifetime: &Lifetime,
        input: Input,
        now: u64,
    ) -> Result<u32, Error> {
        if !self.actionable || pane != self.selected || !self.owns(Authority::Input) {
            return Err(tmux_control::Error::Authority.into());
        }
        let (sequence, command) = self.policy.input_submission(pane, lifetime, input, now)?;
        self.send(command)?;
        Ok(sequence)
    }
    /// The caller owns an exclusive scheduler barrier until every paste ACK settles.
    pub fn begin_paste(
        &mut self,
        pane: &str,
        lifetime: &Lifetime,
        text: &str,
        bracketed: bool,
        now: u64,
    ) -> Result<Option<u32>, Error> {
        if !self.actionable || pane != self.selected || !self.owns(Authority::Input) {
            return Err(tmux_control::Error::Authority.into());
        }
        let (sequence, command) = self
            .policy
            .begin_paste_submission(pane, lifetime, text, bracketed, now)?;
        self.send(command)?;
        Ok(Some(sequence))
    }
    pub fn next_paste(&mut self, now: u64) -> Result<Option<u32>, Error> {
        if !self.actionable || !self.owns(Authority::Input) {
            self.policy.cancel_paste();
            return Err(tmux_control::Error::Authority.into());
        }
        let Some((sequence, command)) = self.policy.next_paste_submission(now)? else {
            return Ok(None);
        };
        self.send(command)?;
        Ok(Some(sequence))
    }
    /// Geometry is requested only for an actual viewport change, never for focus alone.
    pub fn viewport(&mut self, cols: u16, rows: u16, now: u64) -> Result<(), Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        if !(2..=4096).contains(&cols) || !(2..=4096).contains(&rows) {
            return Err(Error::Invalid);
        }
        let Some(window) = self.topology.layouts().values().find(|layout| {
            layout
                .panes
                .iter()
                .any(|pane| pane.pane.as_deref() == Some(&self.selected))
        }) else {
            return Ok(());
        };
        let Some(id) = window.semantic_window_id.clone() else {
            return Err(Error::Invalid);
        };
        if window.cols == usize::from(cols)
            && window.rows == usize::from(rows)
            && self.inflight_viewport.is_none()
        {
            self.viewport = None;
            return Ok(());
        }
        if self.inflight_viewport.as_ref() == Some(&(cols, rows, id.clone())) {
            self.viewport = None;
            return Ok(());
        }
        if self
            .viewport
            .as_ref()
            .is_some_and(|(c, r, w, _)| *c == cols && *r == rows && *w == id)
        {
            return Ok(());
        }
        self.viewport = Some((cols, rows, id, now.saturating_add(2000)));
        self.flush_viewport(now)
    }
    fn flush_viewport(&mut self, now: u64) -> Result<(), Error> {
        let Some((cols, rows, window, deadline)) = self.viewport.clone() else {
            return Ok(());
        };
        if now >= deadline {
            self.viewport = None;
            self.geometry_requested = false;
            return Ok(());
        }
        if self.pending_selection.is_some()
            || self.inflight_viewport.is_some()
            || !self.owns(Authority::Input)
            || !self.policy.barrier_ready()
        {
            return Ok(());
        }
        if !self.owns(Authority::Geometry) {
            if !self.geometry_requested {
                let id = uuid::Uuid::new_v4().to_string();
                let command = match self.policy.request_authority(Authority::Geometry, &id, now) {
                    Ok(command) => command,
                    Err(tmux_control::Error::Busy) => return Ok(()),
                    Err(error) => return Err(error.into()),
                };
                self.send(command)?;
                self.geometry_requested = true;
            }
            return Ok(());
        }
        let command = self.policy.viewport(cols, rows, Some(&window), now)?;
        self.send(command)?;
        self.viewport = None;
        self.geometry_requested = false;
        self.inflight_viewport = Some((cols, rows, window));
        Ok(())
    }
    pub fn poll(&mut self, now: u64) -> Result<Update, Error> {
        let result = self.poll_inner(now);
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn poll_inner(&mut self, now: u64) -> Result<Update, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        let updates = self.session.drain()?;
        self.flush_cell_pixels(updates.cell_pixels, updates.precise_cell_pixels)?;
        let mut presentation_changed = !updates.panes.is_empty();
        match updates.status {
            Status::Connecting => {}
            Status::Ready(ready) if !self.ready => {
                self.policy.ready_with_input_bytes(
                    ready.connection_client_id.as_deref(),
                    ready.input_lifetime == Some(true),
                    ready.input_bytes == Some(true),
                )?;
                self.ready = true;
                presentation_changed = true;
                if let Some(authority) = &ready.authority {
                    self.policy.accept_json(&serde_json::to_vec(
                        &json!({"type":"authority-snapshot","snapshot":authority}),
                    )?)?;
                }
            }
            Status::Ready(_) => {}
            Status::Failed(error) => return Err(Error::Stopped(error)),
            Status::Cancelled => return Err(Error::Retired),
        }
        let mut inputs = Vec::new();
        let mut controls = Vec::new();
        let mut intents = Vec::new();
        let mut viewports = Vec::new();
        for control in updates.controls {
            #[derive(Deserialize)]
            struct Kind<'a> {
                #[serde(rename = "type", borrow)]
                kind: &'a str,
            }
            let kind: Kind<'_> = serde_json::from_str(control.get())?;
            if matches!(
                kind.kind,
                "authority-snapshot"
                    | "authority-receipt"
                    | "input-ack"
                    | "viewport-ack"
                    | "semantic-intent-ack"
                    | "error"
            ) {
                let outcome = self.policy.accept_json(control.get().as_bytes())?;
                inputs.extend(outcome.inputs);
                intents.extend(outcome.intent);
                if outcome.viewport.is_some() {
                    self.inflight_viewport = None;
                }
                viewports.extend(outcome.viewport);
            } else if self.topology.apply_control(&control)? {
                presentation_changed = true;
            } else {
                controls.push(control);
            }
        }
        for (pane, update) in &updates.panes {
            if update
                .snapshot
                .as_ref()
                .is_none_or(|s| s.history.is_complete())
            {
                self.materializing.remove(pane);
            }

            let lifetime = update.snapshot.as_ref().map(|_| Lifetime {
                generation: update.identity.generation.clone(),
                incarnation: update.identity.incarnation.clone(),
            });
            inputs.extend(self.policy.bind_lifetime(pane, lifetime)?);
            if let Some(committed) = self.session.committed(pane)? {
                self.current.insert(pane.clone(), committed);
            }
        }
        let expired = if self.ready {
            self.policy.expire(now)?
        } else {
            Default::default()
        };
        if !expired.viewports.is_empty() {
            self.inflight_viewport = None;
        }
        inputs.extend(expired.inputs);
        let selection = self.finish_selection(&intents, &expired.intents)?;
        let presence_revision = self
            .flush_presence(now)?
            .or(self.last_presence.map(|(_, rev)| rev));
        if presentation_changed
            || selection
                .as_ref()
                .is_some_and(|selection| selection.selected)
        {
            self.cached_window = self
                .presentation
                .update(&self.topology, &self.current, true)?;
        }
        let window = self.cached_window.as_ref().map(|window| PresentedWindow {
            paint: window.paint.clone(),
            coherent: window.coherent,
        });
        self.actionable = !updates.materializing.contains(&self.selected)
            && self.pending_selection.is_none()
            && window.as_ref().is_some_and(|window| window.coherent);
        self.flush_viewport(now)?;
        Ok(Update {
            panes: updates.panes,
            window,
            inputs,
            controls,
            intents,
            viewports,
            geometry_timeouts: expired.viewports,
            intent_timeouts: expired.intents,
            presence_revision,
            selection,
            graphics: updates.graphics,
            graphics_placements: updates.graphics_placements,
            cell_pixels: updates.cell_pixels,
            precise_cell_pixels: updates.precise_cell_pixels,
        })
    }
}
#[cfg(test)]
#[path = "tmux_controller_tests.rs"]
mod tests;

#[path = "tmux_controller_actions.rs"]
mod actions;
pub use actions::{ActionCompletion, ActionOutcome, ActionState, PaneAction};

#[path = "tmux_controller_owner.rs"]
mod owner;
pub use owner::{OwnerAuthorization, OwnerCompletion, OwnerEvent, OwnerOutcome, OwnerState};

#[path = "tmux_controller_divider.rs"]
mod divider;
pub use divider::{DividerState, SplitPhase, SplitPublication, SplitRead};
