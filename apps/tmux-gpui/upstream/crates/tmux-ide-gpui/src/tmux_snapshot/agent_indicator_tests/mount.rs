//! How production mounts the window content, and the frame it shows.
use crate::tmux_snapshot::{SnapshotView, agent_spinner};
use gpui::{AnyView, App, Entity, Window};
pub(super) fn mount(snapshot: Entity<SnapshotView>, window: &mut Window, cx: &mut App) -> AnyView {
    agent_spinner::window_root(snapshot, window, cx).into()
}
pub(super) fn frame(view: &SnapshotView) -> usize {
    view.agent_animation.frame()
}
/// The colours the spinner overlay paints, one per reserved slot.
pub(super) fn slot_colors(view: &SnapshotView) -> Vec<gpui::Hsla> {
    view.agent_animation.colors()
}
