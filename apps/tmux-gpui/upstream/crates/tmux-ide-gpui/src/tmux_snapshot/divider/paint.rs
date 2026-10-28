//! A painted native gutter follows topology, not terminal output revisions.
use super::*;
#[derive(Clone, PartialEq)]
pub(in crate::tmux_snapshot) struct Painted {
    request: u64,
    presence: u64,
    session: Option<String>,
    selected: Option<String>,
    route: Option<super::super::browser_native_preview::Route>,
    layout: canonical::Layout,
    content: Vec<hit_regions::Region>,
    width: f32,
    height: f32,
}
impl Painted {
    pub fn capture(state: &browser::State, width: f32, height: f32) -> Option<Self> {
        let layout = state.split_layout.as_ref()?;
        if state.retained_preview || !state.input_ready || splits(state).is_empty() {
            return None;
        }
        Some(Self {
            request: state.request,
            presence: state.presence_revision,
            session: state.selected_session.clone(),
            selected: state.selected_pane.clone(),
            route: state.native_frame_scope.clone(),
            layout: layout.clone(),
            content: state.native_content_regions.clone(),
            width,
            height,
        })
    }
}
