//! Keyboard hints share the existing Bezel component and native chrome palette.
use gpui::{prelude::*, *};

pub(super) const ZOOM: &str = "⌘⇧↵";
pub(super) const FOCUS: [(&str, &str); 4] = [
    ("Focus pane left", "⌘⌥←"),
    ("Focus pane right", "⌘⌥→"),
    ("Focus pane above", "⌘⌥↑"),
    ("Focus pane below", "⌘⌥↓"),
];
pub(super) fn badge(theme: &bezel_theme::Theme, label: impl Into<SharedString>) -> Div {
    bezel_ui::popover::kbd_hint(theme, label)
        .border_1()
        .border_color(theme.border)
        .text_color(theme.text_muted)
        .min_h(px(20.))
        .flex_shrink_0()
}
