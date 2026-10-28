use super::*;

#[gpui::test]
fn sidebar_split_drag_clamps_releases_outside_and_resets(cx: &mut gpui::TestAppContext) {
    use gpui::{MouseButton, MouseDownEvent};

    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let sidebar = cx.debug_bounds("sidebar").unwrap();
    let initial_spaces = cx.debug_bounds("spaces-section").unwrap();
    let initial_agents = cx.debug_bounds("agents-section").unwrap();
    let footer = cx.debug_bounds("device-footer").unwrap();
    assert!((initial_spaces.size.height - initial_agents.size.height).abs() <= px(1.));

    for (requested, expected) in [(0.7, 0.7), (0.3, 0.3), (-0.5, 0.1), (1.5, 0.9)] {
        let divider = cx.debug_bounds("sidebar-split-resize").unwrap();
        let available = sidebar.size.height - divider.size.height - footer.size.height;
        // Move and release outside the sidebar as well as outside the divider.
        let end = point(
            sidebar.right() + px(100.),
            sidebar.top() + divider.size.height / 2. + available * requested,
        );
        cx.simulate_mouse_down(divider.center(), MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        view.read_with(cx, |view, _| {
            assert!(view.sidebar_drag.is_some());
            assert!((view.sidebar_split.unwrap() - expected).abs() < 0.0001);
            assert!(view.sidebar_split_modified);
            assert_eq!(view.sidebar_width, None);
        });
        let spaces = cx.debug_bounds("spaces-section").unwrap();
        let agents = cx.debug_bounds("agents-section").unwrap();
        let divider = cx.debug_bounds("sidebar-split-resize").unwrap();
        assert!((spaces.size.height - available * expected).abs() <= px(1.));
        assert!((agents.size.height - available * (1. - expected)).abs() <= px(1.));
        assert_eq!(spaces.bottom(), divider.top());
        assert_eq!(divider.bottom(), agents.top());
        assert_eq!(agents.bottom(), footer.top());

        cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
        let released = view.read_with(cx, |view, _| {
            assert!(view.sidebar_drag.is_none());
            view.sidebar_split
        });
        cx.simulate_mouse_move(sidebar.center(), None, Modifiers::default());
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        assert_eq!(view.read_with(cx, |view, _| view.sidebar_split), released);
        assert_eq!(cx.debug_bounds("spaces-section").unwrap(), spaces);
    }

    let position = cx.debug_bounds("sidebar-split-resize").unwrap().center();
    cx.simulate_event(MouseDownEvent {
        position,
        button: MouseButton::Left,
        click_count: 2,
        ..Default::default()
    });
    cx.simulate_mouse_move(sidebar.center(), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(sidebar.center(), MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    view.read_with(cx, |view, _| {
        assert_eq!(view.sidebar_split, None);
        assert!(view.sidebar_drag.is_none());
        assert!(view.sidebar_split_modified);
    });
    assert_eq!(cx.debug_bounds("spaces-section").unwrap(), initial_spaces);
    assert_eq!(cx.debug_bounds("agents-section").unwrap(), initial_agents);
}

#[gpui::test]
fn sidebar_split_preserves_independent_scrolling_and_agents_toggle(cx: &mut gpui::TestAppContext) {
    use gpui::{MouseButton, ScrollDelta, ScrollWheelEvent};

    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
        snapshot.agents = (0..40)
            .map(|i| {
                let mut agent = snapshot.agents[0].clone();
                agent.pane_id = format!("p{i}");
                agent
            })
            .collect();
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let divider = cx.debug_bounds("sidebar-split-resize").unwrap();
    let end = divider.center() + point(px(0.), px(-80.));
    cx.simulate_mouse_down(divider.center(), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let split = view.read_with(cx, |view, _| view.sidebar_split.unwrap());
    assert!(split < 0.5);
    let spaces = cx.debug_bounds("spaces-section").unwrap();
    let agents = cx.debug_bounds("agents-section").unwrap();

    for (index, selector) in [(0, "spaces-scroll"), (1, "agents-scroll")] {
        let before = view.read_with(cx, |view, _| {
            view.sidebar_scroll.each_ref().map(|scroll| scroll.offset())
        });
        let position = cx.debug_bounds(selector).unwrap().center();
        cx.simulate_event(ScrollWheelEvent {
            position,
            delta: ScrollDelta::Pixels(point(px(0.), px(-40.))),
            ..Default::default()
        });
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        view.read_with(cx, |view, _| {
            assert!(view.sidebar_scroll[index].offset().y < before[index].y);
            assert_eq!(view.sidebar_scroll[1 - index].offset(), before[1 - index]);
            assert_eq!(view.sidebar_split, Some(split));
        });
    }
    let offsets = view.read_with(cx, |view, _| {
        view.sidebar_scroll.each_ref().map(|scroll| scroll.offset())
    });
    for show_agents in [false, true] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.config.show_agents = show_agents;
                cx.notify();
            });
            cx.default_global::<TextProbes>().0.clear();
            window.refresh();
            full_draw(window, cx).clear(cx);
            assert_eq!(
                cx.global::<TextProbes>().0.contains_key("Claude Code"),
                show_agents
            );
        });
        view.read_with(cx, |view, _| {
            assert_eq!(view.sidebar_split, Some(split));
            assert_eq!(
                view.sidebar_scroll.each_ref().map(|scroll| scroll.offset()),
                offsets
            );
        });
        let current_spaces = cx.debug_bounds("spaces-section").unwrap();
        if show_agents {
            assert_eq!(current_spaces, spaces);
            assert_eq!(cx.debug_bounds("agents-section").unwrap(), agents);
        } else {
            assert_eq!(
                current_spaces.size.height,
                cx.debug_bounds("sidebar").unwrap().size.height
                    - cx.debug_bounds("device-footer").unwrap().size.height
            );
        }
    }
}
