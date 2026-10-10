use super::*;

#[gpui::test]
fn palette_rejects_changed_endpoint_epoch_or_generation(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        fixture_window(window, cx)
    });
    for reconnect in [false, true] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.open_palette(crate::palette::Filter::All, window, cx)
            });
            full_draw(window, cx).clear(cx);
        });
        cx.simulate_input("toggle sidebar");
        cx.run_until_parked();
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        // Selection paints as a row: the fill spans the list, not the label.
        let row = cx.debug_bounds("palette-row-0").unwrap();
        let status = cx.debug_bounds("palette-status").unwrap();
        assert_eq!(row.size.width, status.size.width);
        assert_eq!(row.left(), status.left());
        view.update(cx, |view, _| {
            assert!(view.menu_target_current());
            if reconnect {
                view.endpoints[view.selected_endpoint].generation += 1;
            } else {
                view.selection_epoch += 1;
            }
            assert!(!view.menu_target_current());
        });
        cx.simulate_keystrokes("enter");
        cx.update(|_, cx| {
            assert!(view.read(cx).sidebar_visible);
            assert!(view.read(cx).menu.page == Some(crate::menu::Page::Palette));
        });
        cx.simulate_keystrokes("escape");
    }
}
