//! Herdr's reusable native chrome, without its daemon, settings or updater.
use crate::{
    config::{Config, Theme},
    fonts::StyledFont,
};
use gpui::{prelude::*, *};
pub(super) fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(
        "ctrl-cmd-f",
        crate::RunCommand {
            command: crate::controls::Command::ToggleFullScreen,
        },
        None,
    )]);
}
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
    navigation: impl IntoElement,
) -> AnyElement {
    let font = Config::default().ui;
    let header = crate::titlebar::navigation_header(theme, window, navigation.into_any_element());
    let content = div()
        .on_action(|action: &crate::RunCommand, window, cx| {
            if action.command == crate::controls::Command::ToggleFullScreen {
                crate::window::run_window_command(action.command, window, cx);
            } else {
                cx.propagate();
            }
        })
        .size_full()
        .flex()
        .flex_col()
        .overflow_hidden()
        .text_font(&font)
        .text_size(px(font.size))
        .when(!glass, |content| content.bg(rgb(canvas)))
        .text_color(rgb(theme.foreground))
        .child(header)
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
