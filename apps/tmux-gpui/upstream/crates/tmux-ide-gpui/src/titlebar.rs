//! Native window chrome: the title bar band and its window controls.
mod decorations;

use decorations::controls;
pub(crate) use decorations::frame;

use gpui::{prelude::*, *};

/// Native chrome the window draws above its body; popups must clear it.
pub(super) const HEIGHT: f32 = 34.;

/// `leading` sits right after the traffic lights, ahead of the draggable center.
pub(super) fn render(surface: u32, leading: Option<AnyElement>, window: &Window) -> Stateful<Div> {
    let bar = div()
        .id("titlebar")
        .debug_selector(|| "titlebar".into())
        .flex()
        .flex_none()
        .w_full()
        .h(px(HEIGHT))
        .bg(rgb(surface).blend(rgba(0xffffff1a)))
        .child(
            div()
                .debug_selector(|| "titlebar-leading-space".into())
                .flex_none()
                .w(px(if window.is_fullscreen() { 0. } else { LEADING }))
                .h_full(),
        )
        .children(leading);
    movable(bar, window)
}

/// Makes `area` do a title bar's job: pressing it moves the window, and a
/// double-click acts as the platform's does. Its controls stop their own
/// presses so they never start a move.
///
/// macOS windows own titlebar dragging (`app_owns_titlebar_drag`), so AppKit
/// never moves the window from under a tab, and a client-decorated window has
/// nothing else to move it. A server-drawn frame moves the window from its own
/// title bar, so there `area` is left alone.
pub(crate) fn movable<E: InteractiveElement>(area: E, window: &Window) -> E {
    let client = decorations::client(window);
    if !cfg!(target_os = "macos") && !client {
        return area;
    }
    // The move starts on the press: pointer motion during a press is claimed
    // by window-level drag handlers (selection, splits) before it bubbles up.
    let supported = window.window_controls();
    let area = area.on_mouse_down(MouseButton::Left, move |event, window, _| {
        match event.click_count {
            2 if !client => window.titlebar_double_click(),
            2 if supported.maximize => window.zoom_window(),
            _ => window.start_window_move(),
        }
    });
    if client && supported.window_menu {
        area.on_mouse_down(MouseButton::Right, |event, window, _| {
            window.show_window_menu(event.position);
        })
    } else {
        area
    }
}

/// Application navigation shares the native drag band; server-decorated
/// platforms keep the same navigation immediately below their system frame.
pub(crate) fn navigation_header(
    theme: &crate::config::Theme,
    window: &Window,
    navigation: AnyElement,
    fill: Rgba,
) -> AnyElement {
    if cfg!(target_os = "macos") || decorations::client(window) {
        render(theme.surface, Some(navigation), window)
            .bg(fill)
            .children(controls(window, theme, |window, _| window.remove_window()))
            .into_any_element()
    } else {
        div()
            .flex()
            .flex_none()
            .w_full()
            .h(px(HEIGHT))
            .bg(fill)
            .child(navigation)
            .into_any_element()
    }
}

/// Room before the first control: macOS keeps it clear for the traffic
/// lights, which every other platform draws elsewhere or not at all.
/// Full-screen chrome omits this space because the native controls are hidden.
pub(super) const LEADING: f32 = if cfg!(target_os = "macos") { 80. } else { 8. };

pub(super) fn options(title: &str) -> TitlebarOptions {
    TitlebarOptions {
        title: Some(title.to_owned().into()),
        appears_transparent: cfg!(target_os = "macos"),
        traffic_light_position: cfg!(target_os = "macos").then(|| point(px(9.), px(9.))),
    }
}
