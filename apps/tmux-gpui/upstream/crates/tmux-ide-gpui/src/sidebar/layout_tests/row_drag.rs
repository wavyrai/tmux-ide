use super::*;

#[gpui::test]
fn holding_a_workspace_row_lifts_it_and_a_release_picks_the_gap(cx: &mut gpui::TestAppContext) {
    use gpui::{MouseButton, point};

    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.status = crate::state::ConnectionStatus::Connected;
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let target = |view: &Entity<HerdrWindow>, cx: &mut gpui::VisualTestContext| {
        view.read_with(cx, |view, _| {
            let drag = view.workspace_drag.as_ref()?;
            assert!(drag.lifted);
            Some(drag.target.as_ref()?.params())
        })
    };

    // A quick click stays a click.
    let first = cx.debug_bounds("row-herdr").unwrap();
    let first_column = cx.debug_bounds("column-herdr").unwrap();
    cx.simulate_mouse_down(first.center(), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(first.center(), MouseButton::Left, Modifiers::default());
    cx.executor().advance_clock(crate::reorder::LIFT_DELAY * 2);
    cx.run_until_parked();
    view.read_with(cx, |view, _| assert!(view.workspace_drag.is_none()));

    // Held in place, the row lifts without moving.
    cx.simulate_mouse_down(first.center(), MouseButton::Left, Modifiers::default());
    view.read_with(cx, |view, _| {
        assert!(!view.workspace_drag.as_ref().unwrap().lifted)
    });
    cx.executor().advance_clock(crate::reorder::LIFT_DELAY);
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    view.read_with(cx, |view, _| {
        assert!(view.workspace_drag.as_ref().unwrap().lifted)
    });
    // Over its own place it would move nothing, so nothing shifts.
    assert_eq!(target(&view, cx), None);
    let second = cx
        .debug_bounds("row-herdr-gpui-sidebar-rendering-regression-investigation")
        .unwrap();
    assert_eq!(second.top(), first.bottom());

    // Past the second row's middle, it lands before the third.
    let below = point(first.center().x, second.bottom() - px(2.));
    cx.simulate_mouse_move(below, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert_eq!(
        target(&view, cx),
        Some(serde_json::json!({"workspace_ids": ["w0"], "before_workspace_id": "w2"}))
    );
    // The lifted row follows the pointer, and the line marks the gap.
    let lifted = cx.debug_bounds("row-herdr").unwrap();
    assert_eq!(lifted.top() - first.top(), below.y - first.center().y);
    // It lifts as a smaller card, its contents where they were.
    let card = cx.debug_bounds("highlight-herdr").unwrap();
    assert_eq!(card.left() - lifted.left(), px(6.));
    assert_eq!(lifted.right() - card.right(), px(6.));
    assert_eq!(lifted.left(), first.left());
    assert_eq!(
        cx.debug_bounds("column-herdr").unwrap().left(),
        first_column.left()
    );
    // The second row closes the lifted one's place, opening the gap it
    // would land in, and the gaps are still measured where rows rest.
    let passed = "row-herdr-gpui-sidebar-rendering-regression-investigation";
    assert_eq!(cx.debug_bounds(passed).unwrap().top(), first.top());
    cx.simulate_mouse_move(below, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert_eq!(
        target(&view, cx),
        Some(serde_json::json!({"workspace_ids": ["w0"], "before_workspace_id": "w2"}))
    );
    assert_eq!(cx.debug_bounds(passed).unwrap().top(), first.top());
    // The card's bottom edge passing the second row's resting middle is
    // enough, though that row now paints higher.
    let past = point(below.x, first.center().y + second.size.height / 2. + px(2.));
    cx.simulate_mouse_move(past, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert_eq!(
        target(&view, cx),
        Some(serde_json::json!({"workspace_ids": ["w0"], "before_workspace_id": "w2"}))
    );
    cx.simulate_mouse_move(below, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));

    // The release is the drop, not a click on the row under it.
    cx.simulate_mouse_up(below, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    view.read_with(cx, |view, _| assert!(view.workspace_drag.is_none()));
    // Nothing was sent without a daemon, so every row is back in place.
    assert_eq!(cx.debug_bounds("row-herdr").unwrap(), first);
    assert_eq!(cx.debug_bounds(passed).unwrap(), second);

    // A linked worktree moves among its siblings only, and a drag lifts it
    // without waiting. The gap resolves against the lifted frame's layout.
    let child = cx.debug_bounds("row-sidebar-child").unwrap();
    cx.simulate_mouse_down(child.center(), MouseButton::Left, Modifiers::default());
    for rows in [1., 5.] {
        cx.simulate_mouse_move(
            point(child.center().x, child.bottom() + child.size.height * rows),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
    }
    assert_eq!(
        target(&view, cx),
        Some(serde_json::json!({"workspace_ids": ["w4"], "before_workspace_id": "w6"}))
    );
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    view.read_with(cx, |view, _| assert!(view.workspace_drag.is_none()));
    assert_eq!(cx.debug_bounds("row-sidebar-child").unwrap(), child);
}

/// Dragging works the same in every row layout: the carried row follows the
/// pointer, the row it passes closes its place, and a release without a
/// daemon puts every row back.
#[cfg(test)]
fn check_row_drag(style: crate::config::LayoutMode, row_gap: u16, cx: &mut gpui::TestAppContext) {
    use gpui::{MouseButton, point};

    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.config.layout.mode = style;
        view.config.sidebar_layout.spaces.row_gap = row_gap;
        view.live.status = crate::state::ConnectionStatus::Connected;
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let passed = "row-herdr-gpui-sidebar-rendering-regression-investigation";
    let first = cx.debug_bounds("row-herdr").unwrap();
    let second = cx.debug_bounds(passed).unwrap();
    cx.simulate_mouse_down(first.center(), MouseButton::Left, Modifiers::default());
    cx.executor().advance_clock(crate::reorder::LIFT_DELAY);
    cx.run_until_parked();
    let below = point(first.center().x, second.bottom() - px(2.));
    for _ in 0..2 {
        cx.simulate_mouse_move(below, MouseButton::Left, Modifiers::default());
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
    }
    view.read_with(cx, |view, _| {
        let drag = view.workspace_drag.as_ref().unwrap();
        assert!(drag.lifted, "{style:?}");
        assert_eq!(
            drag.target.as_ref().map(|target| target.params()),
            Some(serde_json::json!({"workspace_ids": ["w0"], "before_workspace_id": "w2"})),
            "{style:?}"
        );
    });
    let lifted = cx.debug_bounds("row-herdr").unwrap();
    assert_eq!(
        lifted.top() - first.top(),
        below.y - first.center().y,
        "{style:?}"
    );
    assert_eq!(
        lifted.size, first.size,
        "{style:?}: lifting resized the row"
    );
    assert_eq!(
        cx.debug_bounds(passed).unwrap().top(),
        first.top(),
        "{style:?}"
    );
    cx.simulate_mouse_up(below, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    view.read_with(cx, |view, _| assert!(view.workspace_drag.is_none()));
    assert_eq!(cx.debug_bounds("row-herdr").unwrap(), first, "{style:?}");
    assert_eq!(cx.debug_bounds(passed).unwrap(), second, "{style:?}");
}

#[gpui::test]
fn configured_row_gap_is_included_in_drag_displacement(cx: &mut gpui::TestAppContext) {
    check_row_drag(crate::config::LayoutMode::default(), 1, cx);
}

#[gpui::test]
fn superset_rows_lift_and_drop(cx: &mut gpui::TestAppContext) {
    check_row_drag(crate::config::LayoutMode::Superset, 0, cx);
}

#[gpui::test]
fn orca_rows_lift_and_drop(cx: &mut gpui::TestAppContext) {
    check_row_drag(crate::config::LayoutMode::Orca, 0, cx);
}

#[gpui::test]
fn minimal_rows_lift_and_drop(cx: &mut gpui::TestAppContext) {
    check_row_drag(crate::config::LayoutMode::Minimal, 0, cx);
}
