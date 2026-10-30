//! Herdr's reusable native chrome, without its daemon, settings or updater.
use crate::{config::Config, fonts::StyledFont};
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
        // Opaque until the first render installs the palette; `Chrome::sync`
        // then moves it to Bezel's blurred background where the palette frosts.
        window_background_blur: bezel_theme::Theme::WINDOW_BLUR.into(),
        window_min_size: Some(size(px(640.), px(400.))),
        ..Default::default()
    }
}
#[cfg(test)]
pub(super) fn frame(body: impl IntoElement, window: &mut Window, cx: &mut App) -> AnyElement {
    super::design::prepare(&crate::config::Theme::default(), false, cx);
    themed_frame(body, window, cx, "Home")
}
/// The window: Bezel's frame around the chrome material, the title bar band
/// and `body`. The chrome is the palette's sidebar fill, which is frost over
/// the blurred desktop where the palette is translucent; terminal panes paint
/// their own opaque fill over it.
pub(super) fn themed_frame(
    body: impl IntoElement,
    window: &mut Window,
    cx: &App,
    navigation: impl IntoElement,
) -> AnyElement {
    let font = Config::default().ui;
    let bezel = bezel_theme::Theme::of(cx);
    let header = crate::titlebar::navigation_header(window, navigation.into_any_element(), cx);
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
        .bg(bezel.sidebar_bg())
        .text_color(bezel.text)
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
    bezel_ui::window::frame(content, window, cx).into_any_element()
}
#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;

/// Insets keep native material visible while every terminal cell stays opaque.
pub(super) const CONTENT_INSET: f32 = bezel_theme::Theme::CONTENT_INSET;
pub(super) fn content_panel(canvas: u32, is_home: bool) -> Stateful<Div> {
    div()
        .id("workspace-content")
        .debug_selector(|| "tmux-workspace-content".into())
        .size_full()
        .min_w_0()
        .min_h_0()
        .when(is_home, |panel| {
            panel
                .rounded(px(bezel_theme::Theme::panel_radius()))
                .p(px(CONTENT_INSET / 2.))
                .bg(rgb(canvas))
        })
        .overflow_hidden()
        .flex()
        .flex_col()
}
