use super::*;

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

fn show_grid(view: &Entity<SettingsWindow>, cx: &mut VisualTestContext, width: f32) {
    cx.simulate_resize(size(px(width), px(560.)));
    view.update(cx, |view, cx| {
        view.body_scroll.set_offset(Point::default());
        cx.notify();
    });
    draw(cx);
    let body = cx.debug_bounds("settings-body").unwrap();
    let list = cx.debug_bounds("settings-theme-list").unwrap();
    view.update(cx, |view, cx| {
        view.body_scroll
            .set_offset(point(px(0.), body.top() - list.top() + px(20.)));
        view.themes
            .scroll
            .scroll_to_item_strict(0, ScrollStrategy::Top);
        cx.notify();
    });
    draw(cx);
    let list = cx.debug_bounds("settings-theme-list").unwrap();
    assert!(list.top() >= body.top() && list.bottom() <= body.bottom());
}

fn offsets(view: &Entity<SettingsWindow>, cx: &VisualTestContext) -> [Point<Pixels>; 2] {
    view.read_with(cx, |view, _| {
        [
            view.body_scroll.offset(),
            view.themes.scroll.0.borrow().base_handle.offset(),
        ]
    })
}

fn scroll(cx: &mut VisualTestContext, position: Point<Pixels>, delta: ScrollDelta) {
    cx.simulate_event(ScrollWheelEvent {
        position,
        delta,
        ..Default::default()
    });
    draw(cx);
}

#[gpui::test]
fn theme_grid_scroll_does_not_move_settings_page(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    for width in [680., 960.] {
        show_grid(&view, cx, width);
        let position = cx.debug_bounds("settings-theme-row-0").unwrap().center();
        let before = offsets(&view, cx);
        scroll(cx, position, ScrollDelta::Pixels(point(px(0.), px(-80.))));
        let after = offsets(&view, cx);
        assert_eq!(after[0], before[0], "page moved at width {width}");
        assert!(after[1].y < before[1].y, "theme grid did not scroll");
        scroll(cx, position, ScrollDelta::Lines(point(0., 2.)));
        let back = offsets(&view, cx);
        assert_eq!(back[0], before[0]);
        assert!(back[1].y > after[1].y, "theme grid did not scroll back");

        // Outside the grid, the page must still scroll normally.
        let body = cx.debug_bounds("settings-body").unwrap();
        scroll(
            cx,
            point(body.left() + px(10.), body.center().y),
            ScrollDelta::Pixels(point(px(0.), px(-40.))),
        );
        let outside = offsets(&view, cx);
        assert!(outside[0].y < back[0].y);
        assert_eq!(outside[1], back[1]);
    }
}

#[gpui::test]
fn theme_grid_edges_do_not_scroll_settings_page(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    for width in [680., 960.] {
        show_grid(&view, cx, width);
        for (at_bottom, delta) in [(false, 80.), (true, -80.)] {
            view.update(cx, |view, cx| {
                let row = if at_bottom {
                    view.themes
                        .filtered
                        .len()
                        .div_ceil(view.themes.grid.columns)
                        - 1
                } else {
                    0
                };
                view.themes
                    .scroll
                    .scroll_to_item_strict(row, ScrollStrategy::Top);
                cx.notify();
            });
            draw(cx);
            let before = offsets(&view, cx);
            let position = cx.debug_bounds("settings-theme-list").unwrap().center();
            for _ in 0..3 {
                scroll(cx, position, ScrollDelta::Pixels(point(px(0.), px(delta))));
                assert_eq!(offsets(&view, cx), before, "scroll escaped a grid edge");
            }
        }
    }
}

#[gpui::test]
fn short_and_empty_theme_grids_do_not_scroll_settings_page(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    for width in [680., 960.] {
        for empty in [false, true] {
            view.update(cx, |view, cx| {
                view.themes.names = vec!["Nord".into()];
                view.themes.herdr_enabled = false;
                view.themes.ghostty_enabled = !empty;
                view.themes.filter(None);
                cx.notify();
            });
            show_grid(&view, cx, width);
            let before = offsets(&view, cx);
            let position = cx.debug_bounds("settings-theme-list").unwrap().center();
            for delta in [-80., 80.] {
                scroll(cx, position, ScrollDelta::Pixels(point(px(0.), px(delta))));
                assert_eq!(offsets(&view, cx), before);
            }
        }
    }
}
