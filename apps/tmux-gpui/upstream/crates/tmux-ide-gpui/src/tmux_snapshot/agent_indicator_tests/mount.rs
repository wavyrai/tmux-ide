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
/// Counts the notifications the spinner overlay receives.
pub(super) fn observe_overlay(
    view: &Entity<SnapshotView>,
    count: std::rc::Rc<std::cell::Cell<usize>>,
    cx: &mut App,
) -> Option<gpui::Subscription> {
    let overlay = view.read(cx).agent_animation.overlay()?;
    Some(cx.observe(&overlay, move |_, _| count.set(count.get() + 1)))
}
/// The frames the overlay painted since the last call, one per working row.
pub(super) fn painted(view: &SnapshotView) -> Vec<usize> {
    view.agent_animation.take_painted()
}
