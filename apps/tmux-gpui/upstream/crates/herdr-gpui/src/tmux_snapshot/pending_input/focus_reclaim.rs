//! A click may capture identity while foreground authority is still in flight.
//! No input enters the transport until the normal current authority gate passes.
use super::*;
use gpui::{Bounds, Pixels, Point};

/// Focus hit proof excludes terminal contents, but includes the actual painted
/// target, lifetime token and geometry. It conveys no input authority.
#[derive(PartialEq)]
pub(in crate::tmux_snapshot) struct PaintedFocus {
    request: u64,
    session: String,
    target: Target,
    region: super::super::hit_regions::Region,
    canvas: (u16, u16),
    bounds: Bounds<Pixels>,
    cell: (f32, f32),
}

impl SnapshotView {
    fn current_focus_binding(&self) -> Option<PaintedFocus> {
        let super::super::display_frame::DisplayFrame::Native(frame) = self.frame.as_ref()? else {
            return None;
        };
        let target = self.browser_state.native_focus_target.as_ref()?;
        if self.browser_request != self.browser_state.request
            || self.browser_state.selected_pane.as_ref() != Some(&target.id)
            || self.browser_state.retained_preview
            || self.browser_state.history_offset != 0
        {
            return None;
        }
        Some(PaintedFocus {
            request: self.browser_request,
            session: self.browser_state.selected_session.clone()?,
            target: target.clone(),
            region: self
                .browser_state
                .regions
                .iter()
                .find(|r| r.id == target.id)?
                .clone(),
            canvas: (frame.width, frame.height),
            bounds: self.input_geometry?.0,
            cell: (self.input_cell_width?, self.terminal_height()),
        })
    }
    pub(in crate::tmux_snapshot) fn record_painted_focus(&mut self) {
        if !super::super::hit_regions::is_painted(self.frame.as_ref(), self.painted_frame.as_ref())
        {
            self.painted_focus = None;
        } else if !self.same_painted_focus() {
            self.painted_focus = self.current_focus_binding();
        }
    }
    fn same_painted_focus(&self) -> bool {
        let Some(painted) = self.painted_focus.as_ref() else {
            return false;
        };
        let Some(super::super::display_frame::DisplayFrame::Native(frame)) = self.frame.as_ref()
        else {
            return false;
        };
        self.browser_request == painted.request
            && self.browser_state.request == painted.request
            && self.browser_state.selected_session.as_ref() == Some(&painted.session)
            && self.browser_state.native_focus_target.as_ref() == Some(&painted.target)
            && self.browser_state.selected_pane.as_ref() == Some(&painted.target.id)
            && !self.browser_state.retained_preview
            && self.browser_state.history_offset == 0
            && self
                .browser_state
                .regions
                .iter()
                .find(|r| r.id == painted.target.id)
                == Some(&painted.region)
            && (frame.width, frame.height) == painted.canvas
            && self
                .input_geometry
                .is_some_and(|(bounds, _)| bounds == painted.bounds)
            && self.input_cell_width == Some(painted.cell.0)
            && self.terminal_height() == painted.cell.1
    }

    pub(in crate::tmux_snapshot) fn focus_click_matches_selected(
        &self,
        position: Point<Pixels>,
    ) -> bool {
        if !self.same_painted_focus()
            && !super::super::hit_regions::is_painted(
                self.frame.as_ref(),
                self.painted_frame.as_ref(),
            )
        {
            return false;
        }
        let (Some((bounds, _)), Some(width), Some(selected)) = (
            self.input_geometry,
            self.input_cell_width,
            self.browser_state.selected_pane.as_deref(),
        ) else {
            return false;
        };
        if !bounds.contains(&position) {
            return false;
        }
        let point = position - bounds.origin;
        super::super::hit_regions::hit(
            &self.browser_state.regions,
            f32::from(point.x),
            f32::from(point.y),
            width,
            self.terminal_height(),
        ) == Some(selected)
    }
    pub(in crate::tmux_snapshot) fn focus_reclaim_ready(&self) -> bool {
        self.pending_input
            .as_ref()
            .is_some_and(|p| matches!(p.kind, Kind::Focus) && p.compatible(self))
    }
    pub(in crate::tmux_snapshot) fn capture_focus_reclaim(
        &mut self,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        if self.input_interrupted
            || self.pending_input.is_some()
            || self.selection.is_some()
            || self.divider.is_some()
            || self.resize_gesture.busy()
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || self.session_tabs.pending.is_some()
            || self.browser_state.input_target_rejected
            || self.browser_state.retained_preview
            || self.browser_state.history_offset != 0
            || self.browser_state.surface != browser::Surface::Workspace
            || self.browser_state.request != self.browser_request
            || self.browser_commands.is_none()
            || !self.focus_click_matches_selected(position)
        {
            return;
        }
        let Some(presence) = self.presence.queued_active_revision() else {
            return;
        };
        let Some(target) = self.browser_state.native_focus_target.as_ref() else {
            return;
        };
        if self.browser_state.selected_pane.as_ref() != Some(&target.id) {
            return;
        }
        let Some(session) = self.browser_state.selected_session.clone() else {
            return;
        };
        let (Some((bounds, _)), Some(width)) = (self.input_geometry, self.input_cell_width) else {
            return;
        };
        if !bounds.contains(&position) {
            return;
        }
        let point = position - bounds.origin;
        if super::super::hit_regions::hit(
            &self.browser_state.regions,
            f32::from(point.x),
            f32::from(point.y),
            width,
            self.terminal_height(),
        ) != Some(target.id.as_str())
        {
            return;
        }
        self.pending_input = Some(Pending {
            kind: Kind::Focus,
            request: self.browser_request,
            id: target.id.clone(),
            token: target.token.clone(),
            session,
            presence,
            started: Instant::now(),
            inputs: Vec::new(),
            bytes: 0,
        });
        cx.notify();
    }
}
