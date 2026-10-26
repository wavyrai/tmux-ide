//! Pure native window overlay. Catalog metadata remains owned by the browser.
use super::{
    Error, browser, copy, decode,
    direct_projection::{DirectProjection, PaneSurface},
    display_frame::DisplayFrame,
    hit_regions, pending_input,
};
use crate::terminal_painter::NativeFrame;
use herdr_client::{
    tmux_control::Lifetime,
    tmux_delivery::{MouseEncoding, MouseProtocol, Row},
    tmux_history::{
        AnchorAction, AnchorResult, HistoryState, Proof, Restoration, Scope, Scroll, Ticket,
        Viewport,
    },
    tmux_topology::{PresentedWindow, WindowPaint},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};
struct Target {
    token: String,
    lifetime: Lifetime,
}
struct Selection {
    key: String,
    rows: Vec<Arc<Row>>,
    token: String,
}
struct Applied {
    paint: Arc<WindowPaint>,
    coherent: bool,
    input_authority: bool,
    presence_revision: u64,
    request: u64,
    session: Option<String>,
}
pub(super) struct NativePresentation {
    scope: String,
    action_revision: u64,
    applied: Option<Applied>,
    workspace_name: String,
    viewport: Viewport,
    restoration: Restoration,
    proof: Option<Proof>,
    history_action: Option<AnchorAction>,
    pending_restore: Option<(String, u64)>,
    pending_materialized_scroll: Option<Scroll>,
    projection: DirectProjection,
    targets: BTreeMap<String, Target>,
    selected: Option<String>,
    selection: Option<Selection>,
    serial: u64,
    frame: Option<Arc<NativeFrame>>,
}
impl NativePresentation {
    pub fn new(scope_id: &str, workspace_name: &str) -> Self {
        Self {
            scope: scope_id.into(),
            action_revision: 0,
            applied: None,
            workspace_name: workspace_name.into(),
            viewport: Viewport::default(),
            restoration: Restoration::default(),
            proof: None,
            history_action: None,
            pending_restore: None,
            pending_materialized_scroll: None,
            projection: DirectProjection::default(),
            targets: BTreeMap::new(),
            selected: None,
            selection: None,
            serial: 0,
            frame: None,
        }
    }
    /// Broker state replacement invalidates the overlay even when canonical paint is unchanged.
    pub fn invalidate_overlay(&mut self) {
        self.applied = None;
        self.targets.clear();
        self.selected = None;
    }
    /// Local history navigation only. Application mouse/alternate-screen routing happens upstream.
    pub fn scroll(&mut self, command: Scroll) {
        self.applied = None;
        self.targets.clear();
        self.selected = None;
        self.viewport.scroll(command);
        self.pending_restore = None;
        self.history_action = self
            .proof
            .clone()
            .and_then(|proof| self.restoration.capture(proof, &self.viewport));
    }
    pub fn scroll_after_materialize(&mut self, command: Scroll) {
        self.pending_materialized_scroll = Some(command);
    }
    pub fn history_offset(&self) -> usize {
        self.viewport.offset()
    }
    pub fn take_history_action(&mut self) -> Option<AnchorAction> {
        self.history_action.take()
    }
    pub fn history_token(&self) -> Option<&str> {
        self.pending_restore
            .as_ref()
            .map(|(token, _)| token.as_str())
            .or_else(|| self.restoration.token())
    }
    pub fn history_pane(&self) -> Option<&str> {
        self.viewport.scope().map(|scope| scope.pane.as_str())
    }
    pub fn complete_history(
        &mut self,
        ticket: &Ticket,
        result: Option<AnchorResult>,
        now_ms: u64,
    ) -> bool {
        let changed = self
            .restoration
            .complete(ticket, result, &mut self.viewport, now_ms);
        if changed {
            self.invalidate_overlay();
        }
        changed
    }
    pub fn fail_history(&mut self, ticket: &Ticket) {
        self.restoration.failed(ticket);
        self.invalidate_overlay();
    }
    pub fn needs_materialization(&self) -> bool {
        (self.pending_restore.is_some() || self.pending_materialized_scroll.is_some())
            && self
                .viewport
                .live()
                .is_some_and(|s| !s.history.is_complete())
    }
    pub fn restore_history(&mut self, token: String, now_ms: u64) {
        self.applied = None;
        self.targets.clear();
        self.selected = None;
        self.history_action = None;
        if let Some(proof) = self.proof.clone()
            && self
                .viewport
                .live()
                .is_some_and(|s| s.history.is_complete())
        {
            self.pending_restore = None;
            self.history_action = self
                .restoration
                .restore(proof, &self.viewport, token, now_ms);
        } else {
            self.pending_restore = Some((token, now_ms));
        }
    }
    pub fn tick_history(&mut self, now_ms: u64) -> bool {
        let before = self.restoration.state();
        let expired = self
            .pending_restore
            .as_ref()
            .is_some_and(|(_, start)| now_ms.saturating_sub(*start) >= 3000);
        if expired {
            self.pending_restore = None;
            self.restoration.unavailable();
        }
        self.restoration.tick(now_ms);
        let changed = expired || before != self.restoration.state();
        if changed {
            self.invalidate_overlay();
            self.history_action = None;
        }
        changed
    }
    fn restoring(&self) -> bool {
        self.pending_restore.is_some() || self.restoration.state() == HistoryState::Restoring
    }
    /// These are routing fences, never leases. Controller must recheck selected pane and authority.
    pub fn action_revision(&self) -> u64 {
        self.action_revision
    }
    pub fn consume_action(&mut self) -> Result<(), Error> {
        self.action_revision = self
            .action_revision
            .checked_add(1)
            .ok_or(Error::Invalid("action revision exhausted"))?;
        Ok(())
    }
    pub fn resolve_action(&self, pane: &str, token: &str) -> Option<Lifetime> {
        let target = self.targets.get(pane)?;
        let revision = self.applied.as_ref()?.presence_revision;
        (token == action_token(&target.token, revision, self.action_revision))
            .then(|| target.lifetime.clone())
    }
    pub fn resolve(&self, pane: &str, token: Option<&str>) -> Option<Lifetime> {
        let target = self.targets.get(pane)?;
        if token.map_or(self.selected.as_deref() == Some(pane), |token| {
            token == target.token
        }) {
            Some(target.lifetime.clone())
        } else {
            None
        }
    }
    pub fn apply(
        &mut self,
        state: &mut browser::State,
        window: &PresentedWindow,
        input_authority: bool,
        presence_revision: u64,
        now_ms: u64,
    ) -> Result<bool, Error> {
        self.tick_history(now_ms);
        if self.applied.as_ref().is_some_and(|last| {
            Arc::ptr_eq(&last.paint, &window.paint)
                && last.coherent == window.coherent
                && last.input_authority == input_authority
                && last.presence_revision == presence_revision
                && last.request == state.request
                && last.session == state.selected_session
        }) {
            return Ok(false);
        }
        self.applied = None;
        // Invalidate routing first: a rejected update must never leave old admitted targets.
        self.targets.clear();
        self.selected = None;
        self.tick_history(now_ms);
        let paint = &window.paint;
        if self.scope.is_empty()
            || self.workspace_name.is_empty()
            || state.selected_session.is_none()
        {
            return Err(Error::Invalid("native presentation scope missing"));
        }
        let width = cell(paint.cols)?;
        let height = cell(paint.rows)?;
        let mut content = Vec::with_capacity(paint.regions.len());
        let mut regions = Vec::with_capacity(paint.regions.len());
        for region in &paint.regions {
            content.push(hit_regions::Region {
                id: region.pane.clone(),
                left: cell(region.left)?,
                top: cell(region.content_top)?,
                width: cell(region.width)?,
                height: cell(region.content_rows)?,
            });
            regions.push(hit_regions::Region {
                id: region.pane.clone(),
                left: cell(region.left)?,
                top: cell(region.top)?,
                width: cell(region.width)?,
                height: cell(region.height)?,
            });
        }
        let source = paint
            .regions
            .iter()
            .find(|r| r.pane == paint.selected_pane)
            .ok_or(Error::Invalid("native selected pane missing"))?;
        let canonical = source
            .source
            .snapshot
            .as_ref()
            .ok_or(Error::Invalid("native selected pane tombstone"))?;
        let scope = Scope {
            lifetime: 0,
            workspace_name: self.workspace_name.clone(),
            pane: paint.selected_pane.clone(),
            generation: source.source.identity.generation.clone(),
            incarnation: source.source.identity.incarnation.clone(),
        };
        if self.viewport.scope().is_some_and(|old| old != &scope) {
            self.pending_materialized_scroll = None;
            self.restoration.retire();
            self.history_action = None;
            self.pending_restore = None;
        }
        let was_historical = self.viewport.offset() > 0;
        self.viewport.update(scope, canonical.clone());
        if canonical.history.is_complete()
            && let Some(command) = self.pending_materialized_scroll.take()
        {
            self.viewport.scroll(command);
        }

        if was_historical && self.viewport.offset() == 0 {
            self.restoration.lost();
            self.history_action = None;
        }
        let identity = &source.source.identity;
        let proof = Proof {
            workspace_name: self.workspace_name.clone(),
            semantic_pane_id: paint.selected_pane.clone(),
            generation: identity.generation.clone(),
            incarnation: identity.incarnation.clone(),
            revision: identity.canonical_revision,
            state_hash: identity.canonical_state_hash.clone(),
        };
        self.proof = Some(proof.clone());
        self.restoration
            .observe(proof.clone(), &mut self.viewport, now_ms);
        if canonical.history.is_complete()
            && let Some((token, requested_at)) = self.pending_restore.take()
        {
            self.history_action =
                self.restoration
                    .restore(proof, &self.viewport, token, requested_at);
            self.tick_history(now_ms);
        }
        let selected_view = self
            .viewport
            .view()
            .ok_or(Error::Invalid("native history view missing"))?;
        let surfaces = paint
            .regions
            .iter()
            .zip(&content)
            .map(|(source, region)| {
                Ok(PaneSurface {
                    region,
                    snapshot: if source.pane == paint.selected_pane {
                        &selected_view
                    } else {
                        source
                            .source
                            .snapshot
                            .as_deref()
                            .ok_or(Error::Invalid("native pane tombstone"))?
                    },
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let projection = self
            .projection
            .project(width, height, &surfaces, &paint.selected_pane)?;
        let mut choices = state.panes.clone();
        for region in &paint.regions {
            if !choices.iter().any(|choice| choice.id == region.pane) {
                choices.push(browser::Choice {
                    id: region.pane.clone(),
                    label: region.pane.clone(),
                    pane_count: None,
                    window_id: Some(paint.window.clone()),
                    window_label: None,
                });
            }
        }
        if !hit_regions::valid_view(&regions, Some((&*projection.frame).into()), &choices) {
            return Err(Error::Invalid("native pane regions"));
        }
        let snapshot = &selected_view;
        let region = copy::Region {
            id: paint.copy_region.pane.clone(),
            left: cell(paint.copy_region.left)?,
            top: cell(paint.copy_region.top)?,
            width: cell(paint.copy_region.width)?,
            height: cell(paint.copy_region.height)?,
            wrapped: snapshot.grid.iter().map(|row| row.wrapped()).collect(),
        };
        if !region.valid_view((&*projection.frame).into(), Some(&paint.selected_pane))
            || usize::from(region.left) != source.left
            || usize::from(region.top) != source.content_top
            || usize::from(region.width) != snapshot.cols
            || usize::from(region.height) != snapshot.rows
            || paint.copy_region.wrapped.len() != canonical.grid.len()
            || !paint
                .copy_region
                .wrapped
                .iter()
                .zip(&canonical.grid)
                .all(|(wrapped, row)| *wrapped == row.wrapped())
        {
            return Err(Error::Invalid("native copy region"));
        }
        // Preserve exact painted identity on a publication that changed no visible state.
        let frame = self
            .frame
            .as_ref()
            .filter(|old| {
                old.width == width
                    && old.height == height
                    && old.cursor == projection.frame.cursor
                    && old.rows.len() == projection.frame.rows.len()
                    && old
                        .rows
                        .iter()
                        .zip(&projection.frame.rows)
                        .all(|(a, b)| Arc::ptr_eq(a, b))
            })
            .cloned()
            .unwrap_or(projection.frame);
        let coherent = window.coherent;
        let ready = coherent && input_authority && self.viewport.offset() == 0 && !self.restoring();
        let mut targets = Vec::new();
        if ready {
            for region in &paint.regions {
                let identity = &region.source.identity;
                let token = digest(&[
                    "input",
                    &self.scope,
                    &region.pane,
                    &identity.generation,
                    &identity.incarnation,
                ]);
                self.targets.insert(
                    region.pane.clone(),
                    Target {
                        token: token.clone(),
                        lifetime: Lifetime {
                            generation: identity.generation.clone(),
                            incarnation: identity.incarnation.clone(),
                        },
                    },
                );
                targets.push(pending_input::Target {
                    id: region.pane.clone(),
                    token,
                });
            }
            self.selected = Some(paint.selected_pane.clone());
        }
        let selection_identity = if coherent && canonical.history.is_complete() && !self.restoring()
        {
            let identity = &source.source.identity;
            let key = digest(&[
                "selection",
                &self.scope,
                &paint.window,
                &paint.selected_pane,
                &identity.generation,
                &identity.incarnation,
                &format!(
                    "{width}:{height}:{}:{}:{}:{}:{}",
                    region.left,
                    region.top,
                    region.width,
                    region.height,
                    snapshot.modes.alternate_screen
                ),
            ]);
            let same = self.selection.as_ref().is_some_and(|old| {
                old.key == key
                    && old.rows.len() == snapshot.grid.len()
                    && old
                        .rows
                        .iter()
                        .zip(&snapshot.grid)
                        .all(|(a, b)| Arc::ptr_eq(a, b))
            });
            if !same {
                self.serial = self
                    .serial
                    .checked_add(1)
                    .ok_or(Error::Invalid("native selection serial exhausted"))?;
                self.selection = Some(Selection {
                    token: digest(&[&key, &self.serial.to_string()]),
                    key,
                    rows: snapshot.grid.clone(),
                });
            }
            self.selection
                .as_ref()
                .map(|selection| selection.token.clone())
        } else {
            self.selection = None;
            None
        };
        state.renderer_probe_scope =
            super::renderer_probe::runtime::enabled().then(|| super::renderer_probe::Scope {
                pane: paint.selected_pane.clone(),
                generation: source.source.identity.generation.clone(),
                incarnation: source.source.identity.incarnation.clone(),
                request: state.request,
                cols: region.width,
                rows: region.height,
                viewport_offset: self.viewport.offset() as u64,
            });
        state.surface = browser::Surface::Workspace;
        state.frame = Some(DisplayFrame::Native(frame.clone()));
        self.frame = Some(frame);
        state.panes = choices;
        state.selected_pane = Some(paint.selected_pane.clone());
        state.regions = regions;
        state.copy_region = Some(region);
        state.selection_identity = selection_identity;
        state.input_ready = ready;
        state.input_targets = targets;
        state.native_focus_target =
            (coherent && !self.restoring()).then(|| pending_input::Target {
                id: paint.selected_pane.clone(),
                token: digest(&[
                    "input",
                    &self.scope,
                    &paint.selected_pane,
                    &source.source.identity.generation,
                    &source.source.identity.incarnation,
                ]),
            });
        state.input_target_rejected = false;
        state.presence_revision = presence_revision;
        state.retained_preview = false;
        state.history_offset = u32::try_from(self.viewport.offset())
            .map_err(|_| Error::Invalid("native history offset"))?;
        state.pointer_modes = if coherent && self.viewport.offset() == 0 && !self.restoring() {
            pointer_modes(&paint.modes)
        } else {
            None
        };
        state.status = if self.restoring() {
            "Restoring terminal history"
        } else if !coherent {
            "Waiting for coherent terminal geometry"
        } else if !input_authority {
            "Waiting for input authority"
        } else {
            "Connected"
        }
        .into();
        // These require separate native control/graphics publications; never retain stale Node grants.
        state.graphics.clear();
        #[cfg(target_os = "macos")]
        {
            state.native_surfaces = None;
        }
        state.pane_actions = None;
        state.resize_token = None;
        state.split_layout = None;
        state.split_gesture = None;
        state.resize_gesture = None;
        state.resize_gesture_supported = false;
        state.diagnostics = None;
        self.applied = Some(Applied {
            paint: window.paint.clone(),
            coherent: window.coherent,
            input_authority,
            presence_revision,
            request: state.request,
            session: state.selected_session.clone(),
        });
        Ok(true)
    }
}
fn cell(value: usize) -> Result<u16, Error> {
    u16::try_from(value).map_err(|_| Error::Invalid("native presentation bounds"))
}
fn digest(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize()
        .iter()
        .flat_map(|byte| {
            const HEX: &[u8; 16] = b"0123456789abcdef";
            [
                char::from(HEX[usize::from(byte >> 4)]),
                char::from(HEX[usize::from(byte & 15)]),
            ]
        })
        .collect()
}
fn pointer_modes(modes: &herdr_client::tmux_delivery::Modes) -> Option<decode::PointerModes> {
    let protocol = match modes.mouse_protocol.as_ref()? {
        MouseProtocol::None => return None,
        MouseProtocol::X10 => decode::MouseProtocol::X10,
        MouseProtocol::Vt200 => decode::MouseProtocol::Vt200,
        MouseProtocol::Drag => decode::MouseProtocol::Drag,
        MouseProtocol::Any => decode::MouseProtocol::Any,
    };
    let encoding = match modes.mouse_encoding.as_ref()? {
        MouseEncoding::SgrPixels => return None,
        MouseEncoding::Default => decode::MouseEncoding::Default,
        MouseEncoding::Utf8 => decode::MouseEncoding::Utf8,
        MouseEncoding::Sgr => decode::MouseEncoding::Sgr,
    };
    Some(decode::PointerModes {
        protocol,
        encoding,
        alternate: modes.alternate_screen,
    })
}
#[cfg(test)]
#[path = "browser_direct_tests.rs"]
mod tests;

/// Menu actions expire across focus changes; input/focus lifetime identities stay stable.
pub(super) fn action_token(
    input_token: &str,
    presence_revision: u64,
    action_revision: u64,
) -> String {
    digest(&[
        "pane-action",
        input_token,
        &presence_revision.to_string(),
        &action_revision.to_string(),
    ])
}
