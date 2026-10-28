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
    themed_frame(body, window, &Theme::default(), false, "Home")
}
pub(super) fn themed_frame(
    body: impl IntoElement,
    window: &mut Window,
    theme: &Theme,
    glass: bool,
    navigation: impl IntoElement,
) -> AnyElement {
    let font = Config::default().ui;
    let header =
        crate::titlebar::navigation_header(theme, window, navigation.into_any_element(), rgba(0));
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
        .bg(chrome_fill(theme.surface, glass))
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
pub(super) fn chrome_fill(color: u32, glass: bool) -> Rgba {
    if glass {
        // Dark ink needs a stronger frost over bright desktop content.
        let alpha = if crate::contrast::luminance(color) < 0.5 {
            0xcc
        } else {
            0x18
        };
        rgba((color << 8) | alpha)
    } else {
        rgb(color)
    }
}

/// Insets keep native material visible while every terminal cell stays opaque.
pub(super) const CONTENT_INSET: f32 = 8.;
pub(super) fn content_panel(canvas: u32, is_home: bool) -> Stateful<Div> {
    div()
        .id("workspace-content")
        .debug_selector(|| "tmux-workspace-content".into())
        .size_full()
        .min_w_0()
        .min_h_0()
        .when(is_home, |panel| {
            panel
                .rounded(px(crate::config::corners::PANEL))
                .p(px(crate::config::corners::PANEL / 3.))
                .bg(rgb(canvas))
        })
        .overflow_hidden()
        .flex()
        .flex_col()
}
