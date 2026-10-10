//! The line under a workspace row that shows the note the user keeps on its
//! checkout, so every reminder reads at a glance without opening a menu.

use super::{label_text, line_height};
use crate::config::{FontConfig, Theme};
use gpui::{prelude::*, *};

/// One truncated line in the note mark's hue, starting at `padding.0` and
/// ending `padding.1` before the row's edge. Clicking it is the caller's.
pub(super) fn element(
    key: &str,
    note: SharedString,
    padding: (f32, f32),
    font: &FontConfig,
    theme: &Theme,
) -> Stateful<Div> {
    let selector = format!("note-line-{key}");
    let size = (font.size * 0.85).round();
    div()
        .id(SharedString::from(selector.clone()))
        .debug_selector(move || selector)
        .h(px(line_height(font)))
        .flex_none()
        .flex()
        .items_center()
        .gap(px(4.))
        .w_full()
        .min_w_0()
        .pl(px(padding.0))
        .pr(px(padding.1))
        .text_size(px(size))
        .text_color(rgb(theme.ink(theme.palette[4])))
        .cursor_pointer()
        .child(
            svg()
                .path("icons/note.svg")
                .size(px(size))
                .flex_none()
                .text_color(rgb(theme.ink(theme.palette[4]))),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .italic()
                .child(label_text(&note)),
        )
}
