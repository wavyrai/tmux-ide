//! The section list resizes by its right edge, like every side panel.
use super::*;
use gpui::{Modifiers, MouseButton, point, px, size};

#[gpui::test]
fn the_section_list_resizes_by_its_edge(cx: &mut TestAppContext) {
    let main = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let weak = cx.update(|cx| main.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let (view, cx) = cx.add_window_view(|window, cx| {
        let view = SettingsWindow::new(weak, cx);
        window.focus(&view.focus, cx);
        view
    });
    cx.simulate_resize(size(px(1200.), px(800.)));
    let draw = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    };
    draw(cx);
    let edge = cx.debug_bounds("settings-navigation-resize").unwrap();
    assert!((edge.right() - px(184.)).abs() <= px(1.), "{edge:?}");
    let start = edge.center();
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        point(start.x + px(40.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_move(
        point(px(300.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_up(
        point(px(300.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    draw(cx);
    // The list's right edge follows the pointer.
    let width = view.read_with(cx, |view, _| view.navigation_width.width(0.));
    assert!((width - 300.).abs() <= 1., "{width}");
    let moved = cx.debug_bounds("settings-navigation-resize").unwrap();
    assert!((moved.right() - px(300.)).abs() <= px(1.), "{moved:?}");
    // Never more than its share of the window.
    cx.simulate_mouse_down(moved.center(), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        point(moved.center().x + px(40.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_move(
        point(px(1150.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_up(
        point(px(1150.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    draw(cx);
    let widest = cx.debug_bounds("settings-navigation-resize").unwrap();
    assert!(widest.right() <= px(1200. * 0.6 + 1.), "{widest:?}");
}
