//! Native window chrome on Bezel: the title bar band, its window controls off
//! macOS, and the window frame. The band paints nothing of its own; it sits on
//! the chrome material the window root paints.
use bezel_ui::titlebar::{self, CaptionSide};
use gpui::{prelude::*, *};

/// Native chrome the window draws above its body; popups must clear it.
pub(super) const HEIGHT: f32 = bezel_theme::Theme::TITLEBAR_HEIGHT;

/// The band, with `leading` right after the traffic lights.
pub(super) fn render(leading: Option<AnyElement>, window: &Window) -> Stateful<Div> {
    let bar = titlebar::titlebar("titlebar", cfg!(target_os = "macos"), window)
        .debug_selector(|| "titlebar".into())
        .flex_none()
        .children(leading);
    movable(bar, window)
}

/// Whether the window draws its own frame and buttons (a compositor without
/// server-side decorations).
fn client(window: &Window) -> bool {
    matches!(window.window_decorations(), Decorations::Client { .. })
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
    let client = client(window);
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
pub(crate) fn navigation_header(window: &Window, navigation: AnyElement, cx: &App) -> AnyElement {
    if cfg!(target_os = "macos") || client(window) {
        render(Some(navigation), window)
            .when(client(window), |bar| {
                bar.child(titlebar::controls(CaptionSide::Right, window, cx))
            })
            .into_any_element()
    } else {
        div()
            .flex()
            .flex_none()
            .w_full()
            .h(px(HEIGHT))
            .child(navigation)
            .into_any_element()
    }
}

/// Centres the macOS traffic lights in the band.
pub(super) fn options(title: &str) -> TitlebarOptions {
    TitlebarOptions {
        title: Some(title.to_owned().into()),
        appears_transparent: cfg!(target_os = "macos"),
        traffic_light_position: cfg!(target_os = "macos").then(|| point(px(9.), px(11.))),
    }
}
