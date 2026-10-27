use super::*;

/// A browser tab is this client's own, so dropping one reorders the
/// workspace's tabs at once, without a daemon.
#[gpui::test]
fn dragging_a_browser_tab_reorders_the_workspace_s_tabs(cx: &mut gpui::TestAppContext) {
    use gpui::{Modifiers, MouseButton, point, px};

    let (view, cx) = window(cx);
    cx.simulate_resize(gpui::size(px(1600.), px(600.)));
    let ids = cx.update(|_, cx| {
        let scope = scope(&view.read(cx).endpoints[0]);
        (0..3)
            .map(|_| {
                Store::update(cx, |store| {
                    store.open(scope.clone(), "w0", None, None).unwrap()
                })
            })
            .collect::<Vec<_>>()
    });
    cx.update(|_, cx| view.update(cx, |view, _| view.browser.appear = Default::default()));
    draw(cx);
    draw(cx);
    let order = |view: &Entity<HerdrWindow>, cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            let scope = scope(&view.read(cx).endpoints[0]);
            cx.global::<Store>()
                .in_workspace(&scope, "w0")
                .map(|tab| tab.id)
                .collect::<Vec<_>>()
        })
    };
    let first = cx.debug_bounds("browser-tab-0").unwrap();
    let second = cx.debug_bounds("browser-tab-1").unwrap();
    // Browser tabs move among their own: over the Herdr tab ahead of them,
    // the first stays first.
    let herdr = cx.debug_bounds("tab-t0").unwrap();
    cx.simulate_mouse_down(first.center(), MouseButton::Left, Modifiers::default());
    for _ in 0..2 {
        cx.simulate_mouse_move(herdr.center(), MouseButton::Left, Modifiers::default());
        draw(cx);
    }
    view.read_with(cx, |view, _| {
        assert!(!view.tab_drag.as_ref().unwrap().has_target())
    });
    let over = point(second.right() - px(2.), first.center().y);
    for _ in 0..2 {
        cx.simulate_mouse_move(over, MouseButton::Left, Modifiers::default());
        draw(cx);
    }
    cx.simulate_mouse_up(over, MouseButton::Left, Modifiers::default());
    draw(cx);
    view.read_with(cx, |view, _| assert!(view.tab_drag.is_none()));
    assert_eq!(order(&view, cx), [ids[1], ids[0], ids[2]]);
    // The release was the drop, not a click showing the tab.
    view.read_with(cx, |view, _| {
        assert_ne!(
            view.group_pick(view.group_slots()[0].id),
            Some(super::super::Pick::Page(ids[0]))
        )
    });
    assert_eq!(
        cx.debug_bounds("browser-tab-1").unwrap().left(),
        first.left()
    );
}

/// Tabs a workspace already has appear at once; one that opens later grows
/// into the strip.
#[gpui::test]
fn a_tab_that_opens_grows_into_the_strip(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx);
    draw(cx);
    let tab = cx.debug_bounds("tab-t0").unwrap();
    assert!(tab.size.width >= gpui::px(crate::TAB_WIDTH));
    view.read_with(cx, |view, _| assert!(!view.tabs_growing()));
    // Held from before it starts, so no frame can outrun it: narrow and clear.
    cx.update(|_, cx| view.update(cx, |view, _| view.browser.appear.hold()));
    cx.update(|_, cx| {
        let scope = scope(&view.read(cx).endpoints[0]);
        Store::update(cx, |store| store.open(scope, "w0", None, None));
    });
    draw(cx);
    view.read_with(cx, |view, _| assert!(view.tabs_growing()));
    let growing = cx.debug_bounds("browser-tab-0").unwrap();
    assert!(
        growing.size.width < gpui::px(crate::TAB_WIDTH / 2.),
        "{growing:?}"
    );

    // Closed, it shrinks out where it stood, from its full width.
    cx.update(|_, cx| view.update(cx, |view, _| view.browser.appear = Default::default()));
    draw(cx);
    let whole = cx.debug_bounds("browser-tab-0").unwrap();
    cx.update(|_, cx| view.update(cx, |view, _| view.browser.appear.hold()));
    cx.update(|_, cx| Store::update(cx, |store| store.close(crate::browser::TabId::test(0))));
    draw(cx);
    assert!(cx.debug_bounds("browser-tab-0").is_none());
    let leaving = cx.debug_bounds("leaving-tab").unwrap();
    assert_eq!(leaving.left(), whole.left());
    // Its measured width, within a pixel or two of the tab it replaces.
    assert!(
        (leaving.size.width - whole.size.width).abs() < gpui::px(4.),
        "{leaving:?} {whole:?}"
    );
    view.read_with(cx, |view, _| assert!(view.tabs_growing()));
}
