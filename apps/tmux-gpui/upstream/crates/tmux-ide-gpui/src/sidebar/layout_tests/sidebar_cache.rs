use super::*;

#[gpui::test]
fn terminal_redraws_reuse_the_cached_sidebar(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    let renders = |cx: &mut gpui::VisualTestContext| {
        cx.update(|_, cx| view.read(cx).sidebar_view.read(cx).renders)
    };
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let first = renders(cx);
    assert!(first > 0);

    // Terminal output: the window redraws, the rows do not rebuild.
    for _ in 0..3 {
        view.update(cx, |view, cx| view.redraw_terminal(cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }
    assert_eq!(renders(cx), first);

    // Anything else notifies the window, which rebuilds the rows as before.
    view.update(cx, |view, cx| {
        view.sidebar_width = Some(200.);
        cx.notify();
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(renders(cx), first + 1);
    // Debug bounds are only recorded when painted, so read them from a full frame.
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert_eq!(renders(cx), first + 2);
    assert_eq!(
        cx.debug_bounds("sidebar").map(|b| b.size.width),
        Some(px(200.))
    );

    // A hidden sidebar is not built, even for a full frame.
    view.update(cx, |view, cx| {
        view.settings.shared = Some(
            crate::herdr_settings::Settings::parse_text(
                "[ui]\nsidebar_collapsed_mode = 'hidden'\n",
            )
            .unwrap(),
        );
        view.sidebar_visible = false;
        cx.notify();
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert_eq!(renders(cx), first + 2);
}
