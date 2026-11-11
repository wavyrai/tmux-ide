//! While Cmd (or Ctrl) is held over a link, the pointer is a hand and the
//! link's cells are underlined: exactly the cells a click opens.
use super::{Hover, Link, modifier};
use crate::tmux_snapshot::{SnapshotView, hit_regions};
use gpui::*;

impl SnapshotView {
    /// Recomputes the cue for the pointer at `position`. No cue while a
    /// button is held or without the modifier.
    pub(in crate::tmux_snapshot) fn update_link_hover(
        &mut self,
        position: Point<Pixels>,
        modifiers: Modifiers,
        pressed: bool,
        cx: &mut Context<Self>,
    ) {
        let next = (!pressed && modifier(modifiers))
            .then(|| self.terminal_link(position))
            .flatten()
            .and_then(|link| {
                Some(Hover {
                    link,
                    frame: self.frame.clone()?,
                })
            });
        let before = self.pointer.link_hover.as_ref().map(|hover| &hover.link);
        if before != next.as_ref().map(|hover| &hover.link) {
            self.pointer.link_hover = next;
            cx.notify();
        }
    }

    pub(in crate::tmux_snapshot) fn terminal_modifiers(
        &mut self,
        event: &ModifiersChangedEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.update_link_hover(window.mouse_position(), event.modifiers, false, cx);
    }

    /// The cue's link while it still describes the painted frame and the
    /// pointer, at `mouse`, is still on it (it may have left the pane).
    pub(in crate::tmux_snapshot) fn link_hover_shown(&self, mouse: Point<Pixels>) -> Option<&Link> {
        let hover = self.pointer.link_hover.as_ref()?;
        if !hit_regions::is_painted(Some(&hover.frame), self.frame.as_ref()) {
            return None;
        }
        let point = self.terminal_point(mouse)?;
        let width = self.input_cell_width?;
        let column = (f32::from(point.x) / width).floor();
        let row = (f32::from(point.y) / self.terminal_height()).floor();
        hover
            .link
            .cells
            .iter()
            .any(|(y, columns)| {
                f32::from(*y) == row
                    && column >= f32::from(columns.start)
                    && column < f32::from(columns.end)
            })
            .then_some(&hover.link)
    }

    /// One underline per painted row of the link, in window coordinates.
    pub(in crate::tmux_snapshot) fn link_underline(
        &self,
        mouse: Point<Pixels>,
    ) -> Option<AnyElement> {
        let link = self.link_hover_shown(mouse)?;
        let (bounds, _) = self.input_geometry?;
        let width = self.input_cell_width?;
        let height = self.terminal_height();
        let layout = self.card_layout(width);
        let color = link_ink(&self.theme());
        let bars = link.cells.iter().map(|(row, columns)| {
            let at = match &layout {
                Some(layout) => layout.cursor(columns.start, *row),
                None => point(
                    px(f32::from(columns.start) * width),
                    px(f32::from(*row) * height),
                ),
            };
            div()
                .absolute()
                .left(at.x)
                .top(at.y + px(height - 2.))
                .w(px(f32::from(columns.end - columns.start) * width))
                .h(px(1.))
                .bg(color)
        });
        Some(
            deferred(
                anchored()
                    .position_mode(AnchoredPositionMode::Window)
                    .position(bounds.origin)
                    .child(
                        div()
                            .debug_selector(|| "terminal-link-underline".into())
                            .relative()
                            .w(bounds.size.width)
                            .h(bounds.size.height)
                            .children(bars),
                    ),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}

/// The underline's ink: the theme's blue, moved only as far as it must be to
/// read against the terminal background at the theme's mark contrast.
pub(in crate::tmux_snapshot) fn link_ink(theme: &crate::config::Theme) -> Hsla {
    rgb(crate::contrast::ink(
        theme.palette[4],
        &[theme.background],
        theme.contrast.mark_ratio(),
    ))
    .into()
}
