use super::*;

fn drag(axis: Axis) -> Drag {
    let start = if axis == Axis::Cols {
        (5.5, 2.)
    } else {
        (2., 4.5)
    };
    Drag::begin(
        &state(axis),
        bounds(),
        10.,
        crate::terminal::CELL_HEIGHT,
        point_at(start.0, start.1),
    )
    .unwrap()
}

#[test]
fn provisional_panes_move_in_both_axes_without_changing_authoritative_regions() {
    for axis in [Axis::Cols, Axis::Rows] {
        let mut drag = drag(axis);
        let original = drag.regions.clone();
        assert!(preview::Preview::new(&drag).is_none());
        drag.cells += 1;
        let p = preview::Preview::new(&drag).unwrap();
        if axis == Axis::Cols {
            assert_eq!(
                (p.regions[0].width, p.regions[1].left, p.regions[1].width),
                (6, 7, 4)
            );
        } else {
            assert_eq!(
                (p.regions[0].height, p.regions[1].top, p.regions[1].height),
                (5, 6, 3)
            );
        }
        assert!(drag.regions == original);
    }
}

#[test]
fn provisional_edge_preserves_minimum_content_on_each_side() {
    for axis in [Axis::Cols, Axis::Rows] {
        let mut drag = drag(axis);
        for desired in [0, u16::MAX] {
            drag.cells = desired;
            let p = preview::Preview::new(&drag).unwrap();
            let (a, b) = (&p.regions[0], &p.regions[1]);
            if axis == Axis::Cols {
                assert!(a.width >= 2 && b.width >= 2);
                assert_eq!(a.left + a.width + 1, b.left);
                assert_eq!(b.left + b.width, 11);
            } else {
                assert!(a.height >= 3 && b.height >= 3);
                assert_eq!(a.top + a.height + 1, b.top);
                assert_eq!(b.top + b.height, 9);
            }
        }
    }
}

#[test]
fn partial_split_moves_only_its_adjacent_panes() {
    let mut drag = drag(Axis::Cols);
    drag.split.span = 4;
    drag.regions = vec![
        region("a", 0, 0, 5, 4),
        region("b", 6, 0, 5, 4),
        region("c", 0, 5, 11, 4),
    ];
    drag.cells += 2;
    let p = preview::Preview::new(&drag).unwrap();
    assert_eq!(p.regions[0].width, 7);
    assert_eq!((p.regions[1].left, p.regions[1].width), (8, 3));
    assert!(p.regions[2] == drag.regions[2]);
}

#[gpui::test]
fn released_preview_is_not_input_authority_and_expires_with_its_target(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, cx| {
        view.browser_state = state(Axis::Cols);
        view.browser_state.resize_gesture_supported = true;
        view.frame = view.browser_state.frame.clone();
        view.painted_frame = view.frame.clone();
        view.input_geometry = Some((bounds(), Bounds::default()));
        view.input_cell_width = Some(10.);
        assert!(view.begin_divider(view.test_cell_point(5.5, 2.), cx));
        view.move_divider(
            view.test_cell_point(5.5, 2.) + point(px(20.), px(0.)),
            false,
            cx,
        );
        assert_eq!(view.divider_content_preview().unwrap().regions[1].left, 8);
        let original = view.frame.clone().unwrap();
        view.move_divider(
            view.test_cell_point(5.5, 2.) + point(px(20.), px(0.)),
            true,
            cx,
        );
        assert!(view.divider.is_none());
        assert!(view.divider_content_preview().is_some());
        assert!(!view.terminal_input_ready());
        assert!(!view.historical_selection_ready());
        view.queue_input(
            crate::tmux_snapshot::keys::Input::Text("must not reach pane".into()),
            cx,
        );
        assert!(receiver.try_recv().is_err());
        assert!(view.frame.as_ref().unwrap().same(&original));
        view.browser_state.request += 1;
        assert!(view.divider_content_preview().is_none());
        view.browser_state.request -= 1;
        assert!(view.divider_content_preview().is_some());
        view.browser_state.regions[1].left += 1;
        assert!(view.divider_content_preview().is_none());
        view.browser_state.regions[1].left -= 1;
        view.browser_state.presence_revision += 1;
        assert!(view.divider_content_preview().is_none());
    });
}

#[gpui::test]
fn painter_moves_existing_pane_cells_to_the_provisional_origin(cx: &mut TestAppContext) {
    let (sender, _) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.draw(Point::default(), size(px(200.), px(300.)), |_, _| {
        canvas(
            |_, _, _| (),
            move |_, _, window, cx| {
                let mut state = state(Axis::Cols);
                let frame = Arc::make_mut(state.frame.as_mut().unwrap().legacy_mut());
                frame.cells[6].bg = 0x02_123456;
                let mut drag = drag(Axis::Cols);
                drag.cells += 2;
                let preview = preview::Preview::new(&drag).unwrap();
                let mut painter = crate::terminal_painter::TerminalPainter::default();
                painter.set_appearance(
                    14.,
                    crate::terminal::CELL_HEIGHT,
                    crate::config::Theme::default(),
                );
                preview.paint(
                    &mut painter,
                    state.frame.as_ref().unwrap().view(),
                    bounds(),
                    10.,
                    crate::terminal::CELL_HEIGHT,
                    &font("Menlo"),
                    rgb(0x888888),
                    None,
                    window,
                    cx,
                );
            },
        )
        .size_full()
    });
    let backgrounds = cx.update(|window, _| window.painted_quads());
    let moved: Vec<_> = backgrounds
        .iter()
        .filter(|q| q.background == rgb(0x123456).into())
        .collect();
    assert_eq!(moved.len(), 1);
    let expected = cx.update(|window, _| point(px(90.), px(20.)).scale(window.scale_factor()));
    assert_eq!(moved[0].bounds.origin, expected);
}

#[gpui::test]
fn preview_paint_withholds_canonical_hit_proof_until_a_real_repaint(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state = state(Axis::Cols);
        view.browser_state.resize_gesture_supported = true;
        view.frame = view.browser_state.frame.clone();
        view.painted_frame = view.frame.clone();
        view
    });
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let (_grid, width) = view.read_with(cx, |view, _| {
        (
            view.input_geometry.unwrap().0,
            view.input_cell_width.unwrap(),
        )
    });
    let start = view.read_with(cx, |v, _| v.test_cell_point(5.5, 2.));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        start + point(px(width), px(0.)),
        Some(MouseButton::Left),
        Modifiers::default(),
    );
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.update(cx, |view, _| {
        assert!(view.divider_content_preview().is_some());
        assert!(
            view.painted_frame.is_none(),
            "translated pixels cannot certify canonical hit coordinates"
        );
        assert!(view.painted_focus.is_none());
        view.divider = None;
        view.resize_gesture = Default::default();
        assert!(
            view.painted_frame.is_none(),
            "cancellation alone must not restore paint proof"
        );
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |view, _| assert!(view.painted_frame.is_some()));
}
