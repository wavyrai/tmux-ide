//! One short-lived, non-interactive presentation during explicit window navigation.
//! Never install historical pixels in the transport's authoritative state.
use crate::terminal_painter::NativeFrame;
use crate::tmux_snapshot::{
    browser::{State, Surface},
    display_frame::DisplayFrame,
};
use std::sync::Arc;

struct Pending {
    presentation: State,
    request: u64,
    deadline: u64,
    showing: bool,
}
#[derive(Default)]
pub(super) struct Transition(Option<Pending>);
impl Transition {
    pub fn clear(&mut self) {
        self.0 = None;
    }
    pub fn begin(&mut self, state: &State, request: u64, now: u64) {
        if state.frame.is_none() && self.0.as_ref().is_some_and(|p| p.request == request) {
            return;
        }
        self.clear();
        let Some(DisplayFrame::Native(frame)) = &state.frame else {
            return;
        };
        if state.retained_preview || state.surface != Surface::Workspace {
            return;
        }
        // Keep one coherent presentation, with no commands, tokens or capabilities.
        let retained_frame = DisplayFrame::Native(Arc::new(NativeFrame {
            rows: frame.rows.clone(),
            width: frame.width,
            height: frame.height,
            cursor: None,
        }));
        let presentation = State {
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
                .map(|(_, surfaces)| (retained_frame.clone(), surfaces.clone())),
            frame: Some(retained_frame),
            presence_revision: state.presence_revision,
            retained_preview: true,
            ..State::default()
        };
        self.0 = Some(Pending {
            presentation,
            request,
            deadline: now.saturating_add(2000),
            showing: false,
        });
    }
    pub fn expire(&mut self, now: u64) -> bool {
        if self.0.as_ref().is_some_and(|p| now >= p.deadline) {
            self.clear();
            return true;
        }
        false
    }
    pub fn publication(&mut self, state: &State, foreground: bool, now: u64) -> State {
        self.expire(now);
        let Some(pending) = &mut self.0 else {
            return state.clone();
        };
        if !foreground
            || state.presence_revision != pending.presentation.presence_revision
            || state.request > pending.request
            || state.surface != Surface::Workspace
            || state.selected_session != pending.presentation.selected_session
            || (pending.showing
                && state.frame.is_some()
                && state.input_ready
                && state.request == pending.request)
        {
            self.clear();
            return state.clone();
        }
        // Failures are displayed immediately. Only the known open/issue stages may
        // carry a historical presentation; this is not a reconnect/error fallback.
        if state.frame.is_none()
            && (state.request < pending.request
                || matches!(
                    state.status.as_str(),
                    "Opening terminal" | "Connecting terminal"
                ))
        {
            pending.showing = true;
            let mut result = pending.presentation.clone();
            result.request = pending.request;
            result.sessions = state.sessions.clone();
            result.fleet = state.fleet.clone();
            result.selected_server = state.selected_server.clone();
            result.appearance = state.appearance.clone();
            result.status = "Switching window…".into();
            return result;
        }
        state.clone()
    }
}
impl super::SnapshotView {
    pub(super) fn retain_window_transition(
        &mut self,
        request: u64,
        cx: &mut gpui::Context<Self>,
    ) -> bool {
        let mut transition = Transition::default();
        transition.begin(&self.browser_state, request, 0);
        if transition.0.is_none() {
            return false;
        }
        let mut opening = self.browser_state.clone();
        opening.frame = None;
        opening.status = "Opening terminal".into();
        let retained = transition.publication(&opening, true, 0);
        let frame = retained.frame.clone();
        self.frame = frame.clone();
        self.browser_state = retained;
        cx.spawn(async move |view, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(2))
                .await;
            let _ = view.update(cx, |view, cx| {
                if view.browser_request == request
                    && view.browser_state.retained_preview
                    && view
                        .frame
                        .as_ref()
                        .zip(frame.as_ref())
                        .is_some_and(|(a, b)| a.same(b))
                {
                    view.frame = None;
                    view.browser_state.frame = None;
                    view.browser_state.retained_preview = false;
                    cx.notify();
                }
            });
        })
        .detach();
        true
    }
}
#[cfg(test)]
#[path = "browser_native_transition_tests.rs"]
mod tests;
