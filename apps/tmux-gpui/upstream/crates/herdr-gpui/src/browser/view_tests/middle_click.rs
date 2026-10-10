use super::*;
use gpui::{Modifiers, MouseButton};

/// A middle-click closes a tab as its close button does: a page at once, a
/// Herdr tab through its confirmation.
#[gpui::test]
fn middle_click_closes_a_tab(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx);
    cx.simulate_resize(gpui::size(gpui::px(1600.), gpui::px(600.)));
    cx.update(|_, cx| {
        let scope = scope(&view.read(cx).endpoints[0]);
        Store::update(cx, |store| store.open(scope, "w0", None, None).unwrap());
        view.update(cx, |view, _| view.browser.appear = Default::default());
    });
    draw(cx);
    draw(cx);
    let pages = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            let scope = scope(&view.read(cx).endpoints[0]);
            cx.global::<Store>().in_workspace(&scope, "w0").count()
        })
    };
    let middle_click = |cx: &mut VisualTestContext, selector: &'static str| {
        let at = cx.debug_bounds(selector).unwrap().center();
        cx.simulate_mouse_down(at, MouseButton::Middle, Modifiers::default());
        cx.simulate_mouse_up(at, MouseButton::Middle, Modifiers::default());
        draw(cx);
    };

    assert_eq!(pages(cx), 1);
    middle_click(cx, "browser-tab-0");
    assert_eq!(pages(cx), 0);

    view.read_with(cx, |view, _| assert!(view.menu.close.is_none()));
    middle_click(cx, "tab-t0");
    view.read_with(cx, |view, _| {
        assert!(view.config.confirm_close_tab);
        assert!(view.menu.close.is_some());
    });
}
