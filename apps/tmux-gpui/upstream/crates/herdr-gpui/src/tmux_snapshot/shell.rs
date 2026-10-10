//! Herdr's reusable native chrome, without its daemon, settings or updater.
use crate::{
    config::{Config, Theme},
    fonts::StyledFont,
};
use gpui::{prelude::*, *};
pub(super) fn options() -> WindowOptions {
    WindowOptions {
        titlebar: Some(crate::titlebar::options("tmux-ide — native preview")),
        app_owns_titlebar_drag: cfg!(target_os = "macos"),
        window_min_size: Some(size(px(640.), px(400.))),
        ..Default::default()
    }
}
#[cfg(test)]
pub(super) fn frame(body: impl IntoElement, window: &mut Window) -> AnyElement {
    themed_frame(
        body,
        window,
        &Theme::default(),
        Theme::default().background,
        false,
        "Home",
    )
}
pub(super) fn themed_frame(
    body: impl IntoElement,
    window: &mut Window,
    theme: &Theme,
    canvas: u32,
    glass: bool,
    heading: impl IntoElement,
) -> AnyElement {
    let font = Config::default().ui;
    let header =
        crate::titlebar::header(theme, window, |window, _| window.remove_window()).map(|bar| {
            // Equal insets center the title on the window, not the space after
            // the traffic lights. Reserve room for either platform's controls.
            bar.relative().child(
                div()
                    .debug_selector(|| "tmux-window-heading".into())
                    .absolute()
                    .top_0()
                    .left(px(104.))
                    .right(px(104.))
                    .h_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .min_w_0()
                    .text_color(rgb(theme.foreground))
                    .child(
                        div()
                            .debug_selector(|| "tmux-window-heading-text".into())
                            .max_w_full()
                            .min_w_0()
                            .truncate()
                            .child(heading),
                    ),
            )
        });
    let content = div()
        .size_full()
        .flex()
        .flex_col()
        .overflow_hidden()
        .text_font(&font)
        .text_size(px(font.size))
        .when(!glass, |content| content.bg(rgb(canvas)))
        .text_color(rgb(theme.foreground))
        .children(header)
        .child(
            div()
                .debug_selector(|| "tmux-shell-body".into())
                .flex_1()
                .min_h_0()
                .min_w_0()
                .overflow_hidden()
                .child(body),
        );
    crate::titlebar::frame(window, theme.active, content).into_any_element()
}
#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;

// Tint only the navigation chrome; terminal surfaces retain opaque theme colors.
pub(super) fn sidebar_fill(color: u32, glass: bool) -> Rgba {
    if glass {
        rgba((color << 8) | 0x55)
    } else {
        rgb(color)
    }
}
