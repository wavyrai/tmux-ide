use super::*;

#[gpui::test]
fn inset_content_keeps_headers_cells_and_resize_in_one_measured_rectangle(cx: &mut TestAppContext) {
    use super::super::super::{browser, keys};
    let (sender, receiver) = std::sync::mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|_, cx| browser_fixture(cx, sender));
    receiver.try_iter().for_each(drop);
    for (width, height, hidden) in [
        (640., 400., false),
        (1000., 700., false),
        (640., 400., true),
    ] {
        cx.update(|_, cx| {
            view.update(cx, |v, _| {
                v.sidebar_hidden = hidden;
                v.last_resize = None;
            })
        });
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|w, cx| w.draw(cx).clear(cx));
        let body = cx.debug_bounds("tmux-shell-body").unwrap();
        let inset = cx.debug_bounds("tmux-workspace-inset").unwrap();
        let content = cx.debug_bounds("tmux-workspace-content").unwrap();
        let top_row = cx.debug_bounds("sidebar-top-row").unwrap();
        assert!(cx.debug_bounds("pane-header-row").is_none());
        // Beside the sidebar the cards start where it ends (#746); without
        // it they keep the window's 8 pt inset.
        let left = if hidden {
            px(super::super::CONTENT_INSET)
        } else {
            px(0.)
        };
        assert_eq!(content.left(), inset.left() + left);
        assert_eq!(content.top(), inset.top() + px(super::super::CONTENT_INSET));
        assert_eq!(
            content.right(),
            body.right() - px(super::super::CONTENT_INSET)
        );
        assert_eq!(
            content.bottom(),
            body.bottom() - px(super::super::CONTENT_INSET)
        );
        if !hidden {
            let sidebar = cx.debug_bounds("tmux-sidebar-viewport").unwrap();
            // The #746 mockup's sidebar: 252 pt.
            assert_eq!(sidebar.size.width, px(252.));
            assert_eq!(sidebar.right(), inset.left());
            // #746 v3 (card 5): no full-width strip. The top row heads the
            // sidebar's column, and the cards start 8 pt from the top.
            assert!(cx.debug_bounds("titlebar").is_none());
            assert_eq!(top_row.top(), body.top());
            assert!(top_row.right() <= inset.left());
            // A status notice floats over the list, so nothing sits between.
            assert_eq!(sidebar.top(), top_row.bottom());
            assert_eq!(inset.top(), body.top());
            // The row's band and the 8 pt over the cards move the window.
            let band = cx.debug_bounds("sidebar-titlebar").unwrap();
            assert_eq!(band.size.width, px(252.));
            assert!(band.contains(&top_row.center()));
            let grip = cx.debug_bounds("content-titlebar-grip").unwrap();
            assert_eq!(grip.top(), body.top());
            assert_eq!(grip.size.height, px(super::super::CONTENT_INSET));
            assert_eq!((grip.left(), grip.right()), (inset.left(), inset.right()));
            assert_eq!(grip.bottom(), content.top());
        } else {
            assert!(cx.debug_bounds("sidebar-titlebar").is_none());
            assert_eq!(inset.left(), body.left());
            // Hidden, the sidebar's row keeps the strip over everything,
            // compact on macOS: the lights' row, then the cards 8 pt under
            // it (owner, 11 Nov).
            let strip = cx.debug_bounds("titlebar").unwrap();
            let expected = crate::titlebar::strip_height(cfg!(target_os = "macos"), false);
            assert_eq!(strip.size.height, px(expected));
            assert_eq!(body.top(), strip.bottom());
            assert!(top_row.bottom() <= body.top());
            assert_eq!(
                content.top(),
                strip.bottom() + px(super::super::CONTENT_INSET)
            );
            // No grip here: the strip's controls hang into this gutter.
            assert!(cx.debug_bounds("content-titlebar-grip").is_none());
        }
        // The controls sit on one centre line, the traffic lights', with the
        // sidebar shown or hidden, and never reach the cards (beside the
        // sidebar they sit left of them).
        let toggle = cx.debug_bounds("sidebar-toggle").unwrap();
        assert_eq!(
            toggle.center().y,
            px(crate::titlebar::HEIGHT / 2.),
            "hidden: {hidden}"
        );
        assert!(
            toggle.bottom() <= content.top() || toggle.right() <= content.left(),
            "hidden: {hidden}"
        );
        let expected = view.read_with(cx, |v, _| {
            let canvas = v.input_geometry.unwrap().0;
            assert_eq!(canvas.left(), content.left());
            assert_eq!(canvas.right(), content.right());
            assert!(!canvas.intersects(&top_row));
            assert_eq!(canvas.top(), content.top());
            assert_eq!(canvas.bottom(), content.bottom());
            v.test_fitted_grid()
        });
        let mut last = None;
        for command in receiver.try_iter() {
            match command {
                browser::Command::Input {
                    input: keys::Input::Resize { cols, rows, .. },
                    ..
                } => last = Some((cols, rows)),
                _ => panic!("layout must not change selection or send keys"),
            }
        }
        assert_eq!(last, Some(expected));
    }
    cx.update(|w, cx| {
        view.update(cx, |v, _| v.browser_state.surface = browser::Surface::Home);
        w.draw(cx).clear(cx);
    });
    let content = cx.debug_bounds("tmux-workspace-content").unwrap();
    let home = cx.debug_bounds("tmux-home").unwrap();
    assert!(home.left() > content.left() && home.right() < content.right());
    assert!(home.top() > content.top() && home.bottom() < content.bottom());
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn window_drag_preserves_painted_grid_until_latest_viewport_settles(cx: &mut TestAppContext) {
    use super::super::super::{browser, geometry, keys};
    let (sender, receiver) = std::sync::mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|_, cx| browser_fixture(cx, sender));
    cx.simulate_resize(size(px(1000.), px(700.)));
    cx.update(|w, cx| w.draw(cx).clear(cx));
    let first = view.read_with(cx, |v, _| v.last_resize.unwrap());
    receiver.try_iter().for_each(drop);
    for width in [1010., 1030., 1060., 1100.] {
        cx.simulate_resize(size(px(width), px(700.)));
        cx.update(|w, cx| w.draw(cx).clear(cx));
        assert!(
            receiver.try_recv().is_err(),
            "live window motion must not reflow every pane"
        );
        view.read_with(cx, |v, _| assert_eq!(v.last_resize, Some(first)));
    }
    let expected = view.update(cx, |v, _| {
        let (cols, rows) = v.test_fitted_grid();
        let fit = geometry::Fit {
            request: v.browser_request,
            cols,
            rows,
            pixels: v.graphics.cell_pixels.get().unwrap(),
        };
        // Deterministically advance the quiet interval, without blocking the UI.
        v.fit_settle.clear();
        assert!(!v.fit_settle.ready(
            fit,
            v.last_resize,
            false,
            std::time::Instant::now() - std::time::Duration::from_millis(151)
        ));
        assert!(
            v.fit_settle.due(std::time::Instant::now()),
            "browser tick must wake the final paint"
        );
        (cols, rows)
    });
    cx.update(|w, cx| w.draw(cx).clear(cx));
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Input {
        input: keys::Input::Resize { cols, rows, .. }, ..
    } if (cols, rows) == expected)
    );
    assert!(receiver.try_recv().is_err());
}
