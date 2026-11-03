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
    /// Keys typed just before the drop were not delivered and are never replayed.
    lost_input: bool,
}
/// Shown while reconnecting when keys typed just before the drop were lost.
pub(super) const LOST_INPUT: &str = "keys typed just before the drop were not sent; retype them";
#[derive(Default)]
pub(super) struct Hold {
    /// The catalog recovers a lost stream itself and ends the hold (the native
    /// catalog). The legacy pipe catalog recovers on its own terms and never
    /// ends a hold, so it gets none and keeps its pre-#702 behaviour.
    disabled: bool,
    held: Option<Held>,
    /// The last live frame the UI was shown. A catalog publication can replace the
    /// transport's state, frame included, in the same turn the stream fails.
    last: Option<Held>,
}
impl Hold {
    /// `hold_frames` is false for the legacy pipe catalog: no held frames.
    pub fn new(hold_frames: bool) -> Self {
        Self {
            disabled: !hold_frames,
            ..Self::default()
        }
    }
    /// Whether this hold keeps frames at all.
    pub fn enabled(&self) -> bool {
        !self.disabled
    }
    /// Remember what the UI is shown, when it is a live workspace frame.
    pub fn observe(&mut self, shown: &State) {
        if let Some(live) = live(shown)
            && self.last.as_ref().is_none_or(|last| {
                !same_frame(&last.presentation, shown) || last.request != shown.request
            })
        {
            self.last = Some(live);
        }
    }
    /// Keep the frame that was live when the stream dropped, or the last one shown
    /// for the same request. Nothing is kept from a preview or outside a workspace.
    /// `lost_input`: keys were in flight or queued when the stream dropped. They
    /// are dropped, never replayed, so the held status asks the user to retype.
    pub fn begin(&mut self, state: &State, lost_input: bool) {
        if self.disabled {
            return;
        }
        self.held = live(state).or_else(|| {
            self.last
                .take()
                .filter(|last| last.request == state.request)
        });
        if let Some(held) = &mut self.held {
            held.lost_input = lost_input;
        }
    }
    pub fn clear(&mut self) {
        self.held = None;
    }
    pub fn active(&self) -> bool {
        self.held.is_some()
    }
    /// Whether the held frame reports keys lost; `None` when nothing is held.
    #[cfg(test)]
    pub fn lost_input(&self) -> Option<bool> {
        self.held.as_ref().map(|held| held.lost_input)
    }
    /// What the UI sees. The held frame stands in while the same request has no
    /// live frame; navigation, a give-up, or a live frame ends the hold.
    pub fn publication(&mut self, state: &State) -> State {
        let Some(held) = &mut self.held else {
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
        result.status = if held.lost_input {
            format!("Reconnecting… attempt {attempt} — {LOST_INPUT}")
        } else {
            format!("Reconnecting… attempt {attempt}")
        };
        result
    }
}
fn same_frame(a: &State, b: &State) -> bool {
    match (&a.frame, &b.frame) {
        (Some(DisplayFrame::Native(a)), Some(DisplayFrame::Native(b))) => {
            a.rows.len() == b.rows.len()
                && a.rows.iter().zip(&b.rows).all(|(a, b)| Arc::ptr_eq(a, b))
        }
        _ => false,
    }
}
/// A read-only copy of a live workspace frame, or `None` for anything else.
fn live(state: &State) -> Option<Held> {
    let Some(DisplayFrame::Native(frame)) = &state.frame else {
        return None;
    };
    if state.retained_preview || state.surface != Surface::Workspace {
        return None;
    }
    let frame = DisplayFrame::Native(Arc::new(NativeFrame {
        rows: frame.rows.clone(),
        width: frame.width,
        height: frame.height,
        cursor: None,
    }));
    Some(Held {
        attempt: 1,
        lost_input: false,
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
    })
}

#[cfg(test)]
#[path = "browser_native_hold_tests.rs"]
mod tests;
