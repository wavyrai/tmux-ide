//! The last live frame of a session whose stream dropped, shown read-only while
//! the catalog reconnects (card #702). Publication only: the transport's own
//! state never holds these pixels, and they grant no input.
use crate::terminal_painter::NativeFrame;
use crate::tmux_snapshot::{
    browser::{HomePhase, State, Surface},
    display_frame::DisplayFrame,
};
use std::sync::Arc;

struct Held {
    request: u64,
    presentation: State,
    /// Rediscovery republishes Home between tries; the count never runs backwards.
    attempt: u32,
}
#[derive(Default)]
pub(super) struct Hold(Option<Held>);
impl Hold {
    /// Keep the frame that was live when the stream dropped. Nothing is kept from
    /// a frame that was already a preview, or from outside a workspace.
    pub fn begin(&mut self, state: &State) {
        self.0 = None;
        let Some(DisplayFrame::Native(frame)) = &state.frame else {
            return;
        };
        if state.retained_preview || state.surface != Surface::Workspace {
            return;
        }
        let frame = DisplayFrame::Native(Arc::new(NativeFrame {
            rows: frame.rows.clone(),
            width: frame.width,
            height: frame.height,
            cursor: None,
        }));
        self.0 = Some(Held {
            attempt: 1,
            request: state.request,
            presentation: State {
                surface: Surface::Workspace,
                selected_session: state.selected_session.clone(),
                selected_pane: state.selected_pane.clone(),
                panes: state.panes.clone(),
                regions: state.regions.clone(),
                native_content_regions: state.native_content_regions.clone(),
                graphics: state.graphics.clone(),
                #[cfg(target_os = "macos")]
                native_surfaces: state
                    .native_surfaces
                    .as_ref()
                    .map(|(_, surfaces)| (frame.clone(), surfaces.clone())),
                frame: Some(frame),
                presence_revision: state.presence_revision,
                retained_preview: true,
                ..State::default()
            },
        });
    }
    pub fn clear(&mut self) {
        self.0 = None;
    }
    pub fn active(&self) -> bool {
        self.0.is_some()
    }
    /// What the UI sees. The held frame stands in while the same request has no
    /// live frame; navigation, a give-up, or a live frame ends the hold.
    pub fn publication(&mut self, state: &State) -> State {
        let Some(held) = &mut self.0 else {
            return state.clone();
        };
        if state.request != held.request || state.home_phase == HomePhase::Unavailable {
            self.clear();
            return state.clone();
        }
        if state.frame.is_some() && !state.retained_preview {
            if state.input_ready {
                self.clear();
            }
            return state.clone();
        }
        held.attempt = held.attempt.max(state.reconnect_attempt.unwrap_or(1));
        let attempt = held.attempt;
        let mut result = held.presentation.clone();
        result.request = state.request;
        result.sessions = state.sessions.clone();
        result.fleet = state.fleet.clone();
        result.selected_server = state.selected_server.clone();
        result.appearance = state.appearance.clone();
        result.presence_revision = state.presence_revision;
        result.reconnect_attempt = Some(attempt);
        result.status = format!("Reconnecting… attempt {attempt}");
        result
    }
}

#[cfg(test)]
#[path = "browser_native_hold_tests.rs"]
mod tests;
