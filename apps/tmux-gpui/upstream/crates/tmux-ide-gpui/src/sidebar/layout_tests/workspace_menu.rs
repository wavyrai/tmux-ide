use super::*;

#[gpui::test]
fn workspace_right_click_survives_redraw_release_and_pointer_movement(
    cx: &mut gpui::TestAppContext,
) {
    use gpui::MouseButton;

    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = fixture_window(window, cx);
        view.live.status = crate::state::ConnectionStatus::Connected;
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    for (redraw, release) in [
        (true, MouseButton::Right),
        (false, MouseButton::Right),
        // macOS can deliver Left when Control is released before the mouse.
        (true, MouseButton::Left),
    ] {
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        let position = cx.debug_bounds("row-agent-launcher").unwrap().center();
        cx.simulate_mouse_down(position, MouseButton::Right, Modifiers::default());
        cx.update(|window, cx| {
            if redraw {
                full_draw(window, cx).clear(cx);
            }
            assert_eq!(view.read(cx).menu.page, Some(crate::menu::Page::Workspace));
        });
        // A second press before release must not dismiss the menu just opened.
        cx.simulate_mouse_down(position, MouseButton::Right, Modifiers::default());
        cx.update(|_, cx| {
            assert_eq!(view.read(cx).menu.page, Some(crate::menu::Page::Workspace));
        });
        cx.simulate_mouse_up(position, release, Modifiers::default());
        cx.simulate_mouse_move(point(px(700.), px(500.)), None, Modifiers::default());
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.update_workspace_dialog(window, cx);
                view.poll_hover_menu(std::time::Instant::now(), window, cx);
                view.poll_tab_rename(window, cx);
                view.poll_pane_rename(window, cx);
            });
            full_draw(window, cx).clear(cx);
            assert_eq!(view.read(cx).menu.page, Some(crate::menu::Page::Workspace));
            assert!(view.read(cx).menu.focus.is_focused(window));
            assert!(!view.read(cx).menu.opening_right_click);
        });
        cx.simulate_mouse_down(
            point(px(700.), px(500.)),
            MouseButton::Right,
            Modifiers::default(),
        );
        cx.update(|_, cx| assert!(view.read(cx).menu.page.is_none()));
        cx.simulate_mouse_up(
            point(px(700.), px(500.)),
            MouseButton::Right,
            Modifiers::default(),
        );
    }
}

#[gpui::test]
fn workspace_popover_header_and_right_click_retargeting(cx: &mut gpui::TestAppContext) {
    use crate::menu::{Page, workspace_tests::target_id};
    use gpui::MouseButton;

    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = fixture_window(window, cx);
        view.live.status = crate::state::ConnectionStatus::Connected;
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    for (index, (selector, id, label, branch)) in [
        ("row-agent-launcher", "w3", "agent-launcher", "develop"),
        ("row-herdr", "w0", "herdr", "main"),
        (
            "row-sidebar-child",
            "w4",
            "agent-launcher",
            "worktree/sidebar-child",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        let row = cx.debug_bounds(selector).unwrap();
        let position = point(px(200. - index as f32 * 80.), row.center().y);
        if let Some(panel) = cx.debug_bounds("menu-panel") {
            assert!(
                !panel.contains(&position),
                "{selector}: {panel:?} {position:?}"
            );
        }
        cx.simulate_mouse_down(position, MouseButton::Right, Modifiers::default());
        cx.update(|window, cx| {
            full_draw(window, cx).clear(cx);
            assert_eq!(view.read(cx).menu.page, Some(Page::Workspace));
            assert_eq!(target_id(view.read(cx)), Some(id));
            assert_eq!(
                view.read(cx).pending_navigation,
                Some(crate::NavigationTarget::Workspace(id.to_owned()))
            );
            assert!(view.read(cx).menu.focus.is_focused(window));
        });
        cx.simulate_mouse_up(position, MouseButton::Right, Modifiers::default());
        let header = cx.debug_bounds("workspace-menu-header").unwrap();
        let name = cx.debug_bounds("workspace-menu-name").unwrap();
        let detail = cx.debug_bounds("workspace-menu-branch").unwrap();
        assert!(header.bottom() <= cx.debug_bounds("workspace-menu-Rename").unwrap().top());
        cx.update(|_, cx| {
            let probes = &cx.global::<TextProbes>().0;
            assert!(name.contains(&probes[label].0.center()));
            assert!(detail.contains(&probes[branch].0.center()));
        });
    }
    // The panel itself must not retarget to the row underneath it.
    let header = cx.debug_bounds("workspace-menu-header").unwrap();
    cx.simulate_mouse_down(header.center(), MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(header.center(), MouseButton::Right, Modifiers::default());
    cx.update(|_, cx| assert_eq!(target_id(view.read(cx)), Some("w4")));
    // Left clicks still dismiss instead of navigating or reopening.
    let row = cx.debug_bounds("row-herdr").unwrap();
    cx.simulate_click(point(px(5.), row.center().y), Modifiers::default());
    cx.update(|_, cx| {
        assert!(view.read(cx).menu.page.is_none());
        assert_eq!(
            view.read(cx).pending_navigation,
            Some(crate::NavigationTarget::Workspace("w4".into()))
        );
    });
    // Long labels and branch names stay inside a narrow popup.
    cx.simulate_resize(size(px(320.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_workspace_menu("w1", point(px(20.), px(100.)), window, cx)
        });
        full_draw(window, cx).clear(cx);
    });
    let panel = cx.debug_bounds("menu-panel").unwrap();
    for selector in ["workspace-menu-name", "workspace-menu-branch"] {
        let bounds = cx.debug_bounds(selector).unwrap();
        assert!(bounds.left() >= panel.left() && bounds.right() <= panel.right());
    }
    // Once an action opens a dialog, outside right-clicks only dismiss it.
    cx.simulate_keystrokes("down enter");
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let row = cx.debug_bounds("row-herdr").unwrap();
    let position = point(px(5.), row.center().y);
    cx.simulate_mouse_down(position, MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(position, MouseButton::Right, Modifiers::default());
    cx.update(|_, cx| assert!(view.read(cx).menu.page.is_none()));
    // Non-Git workspaces have a name-only header, not an empty second line.
    cx.update(|window, cx| {
        cx.default_global::<TextProbes>().0.clear();
        view.update(cx, |view, cx| {
            Arc::make_mut(view.live.snapshot.as_mut().unwrap()).workspaces[0].branch = None;
            view.open_workspace_menu("w0", point(px(20.), px(100.)), window, cx);
        });
        window.refresh();
        full_draw(window, cx).clear(cx);
    });
    let header = cx.debug_bounds("workspace-menu-header").unwrap();
    let name = cx.debug_bounds("workspace-menu-name").unwrap();
    assert!(header.size.height < name.size.height * 2.);
    cx.update(|_, cx| {
        assert!(!cx.global::<TextProbes>().0.contains_key("main"));
        assert_eq!(target_id(view.read(cx)), Some("w0"));
    });
}

#[gpui::test]
fn the_sidebar_menu_stays_clear_of_the_window_chrome(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    let chrome = px(crate::titlebar::HEIGHT
        + crate::worktree_banner::reserved(env!("HERDR_BUILD_WORKTREE") == "1"));
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    // An anchor near the top leaves no room above it, one near the footer
    // plenty; either way the panel stays between the chrome and the bottom.
    for anchor in [chrome + px(100.), px(560.)] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.menu.anchor = point(px(120.), anchor);
                view.open_menu(window, cx);
            });
            full_draw(window, cx).clear(cx);
            assert!(view.read(cx).menu.page == Some(crate::menu::Page::Menu));
        });
        let panel = cx.debug_bounds("menu-panel").unwrap();
        // A margin from the chrome and the bottom edge, so a clamped list is
        // visibly a list that scrolls rather than one cut off by the frame.
        assert!(
            panel.top() >= chrome + px(8.),
            "anchor {anchor:?}: {panel:?}"
        );
        assert!(panel.bottom() <= px(592.), "anchor {anchor:?}: {panel:?}");
        // Whatever the room, the list keeps enough height to scroll through.
        assert!(panel.size.height >= px(60.), "anchor {anchor:?}: {panel:?}");
        cx.simulate_keystrokes("escape");
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
    }
}

/// Resting the pointer on a workspace opens the menu its right click opens,
/// once, and only after the pointer has both moved and settled. The behavior
/// is opt-in, so the test turns its feature flag on.
#[gpui::test]
fn resting_on_a_workspace_opens_its_menu_once(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = fixture_window(window, cx);
        view.live.status = crate::state::ConnectionStatus::Connected;
        view.active = true;
        view.config.features.sidebar_hover_menu = true;
        view
    });
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let row = cx.debug_bounds("row-herdr").unwrap().center();
    let settle = |view: &Entity<HerdrWindow>,
                  cx: &mut gpui::VisualTestContext,
                  elapsed: std::time::Duration| {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.poll_hover_menu(std::time::Instant::now() + elapsed, window, cx);
            });
            full_draw(window, cx).clear(cx);
        });
    };

    // Entering the row alone is not a rest: the pointer has not moved yet.
    cx.simulate_mouse_move(row, None, Modifiers::default());
    assert!(
        view.read_with(cx, |view, _| view.hover.is_some()),
        "row armed"
    );
    settle(&view, cx, super::super::HOVER_MENU_DELAY);
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));

    // Drifting inside the row restarts the dwell rather than opening early.
    cx.simulate_mouse_move(row + point(px(8.), px(0.)), None, Modifiers::default());
    settle(&view, cx, std::time::Duration::ZERO);
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
    settle(&view, cx, super::super::HOVER_MENU_DELAY / 2);
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));

    settle(&view, cx, super::super::HOVER_MENU_DELAY);
    view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(crate::menu::Page::Workspace));
        assert_eq!(crate::menu::workspace_tests::target_id(view), Some("w0"));
        // The same one-shot intent, spent: nothing is left armed behind it.
        assert!(view.hover.is_none());
    });

    // Moving inside the popup keeps it: it is the menu the pointer asked for.
    let panel = cx.debug_bounds("menu-panel").unwrap();
    cx.simulate_mouse_move(panel.center(), None, Modifiers::default());
    settle(&view, cx, super::super::HOVER_MENU_DELAY);
    view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(crate::menu::Page::Workspace));
        assert!(view.hover_menu.as_ref().is_some_and(|open| open.inside));
    });

    // Leaving it closes it, with no click anywhere.
    cx.simulate_mouse_move(
        point(panel.right() + px(40.), panel.bottom() + px(40.)),
        None,
        Modifiers::default(),
    );
    settle(&view, cx, std::time::Duration::ZERO);
    view.read_with(cx, |view, _| {
        assert!(view.menu.page.is_none());
        assert!(view.hover_menu.is_none());
    });

    // Leaving a menu for a row above it keeps that row's dwell, so the pointer
    // can walk up the list from one menu to the next without a click.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_workspace_menu("w0", point(px(20.), px(20.)), window, cx);
            view.hover_menu = Some(super::super::HoverMenu {
                position: window.mouse_position() + point(px(60.), px(60.)),
                inside: false,
            });
            view.hover_workspace("w1", true, window);
            view.poll_hover_menu(std::time::Instant::now(), window, cx);
            assert!(view.menu.page.is_none());
            assert!(view.hover.is_some(), "the next row keeps its dwell");
            assert!(view.hover_menu.is_none());
        });
        full_draw(window, cx).clear(cx);
    });

    // A menu opened any other way is not the pointer's to close.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_workspace_menu("w0", point(px(20.), px(20.)), window, cx);
        });
        full_draw(window, cx).clear(cx);
    });
    cx.simulate_mouse_move(point(px(700.), px(600.)), None, Modifiers::default());
    settle(&view, cx, super::super::HOVER_MENU_DELAY);
    view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(crate::menu::Page::Workspace));
        assert!(view.hover_menu.is_none());
    });
    cx.simulate_keystrokes("escape");

    // Dismissing must not let a still pointer reopen the menu.
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
    for _ in 0..3 {
        settle(&view, cx, super::super::HOVER_MENU_DELAY);
        assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
    }

    // Scrolling slides another row under a still pointer, so the row it entered
    // can no longer speak for what it covers. GPUI may report the newly covered
    // row as hovered, but that fresh arm still waits for the pointer to move.
    let away = point(px(700.), px(400.));
    cx.simulate_mouse_move(away, None, Modifiers::default());
    cx.simulate_mouse_move(row, None, Modifiers::default());
    cx.simulate_mouse_move(row + point(px(4.), px(4.)), None, Modifiers::default());
    let armed = view.read_with(cx, |view, _| {
        view.hover.as_ref().map(|hover| hover.workspace.clone())
    });
    assert!(armed.is_some(), "row armed");
    cx.update(|_, cx| {
        view.read(cx).sidebar_scroll[0].set_offset(point(px(0.), px(-40.)));
    });
    settle(&view, cx, super::super::HOVER_MENU_DELAY);
    view.read_with(cx, |view, _| {
        assert!(view.menu.page.is_none());
        assert!(
            view.hover
                .as_ref()
                .is_none_or(|hover| Some(&hover.workspace) != armed.as_ref() && !hover.moved)
        );
    });

    // An inactive window keeps its menus closed under the same pointer.
    cx.update(|_, cx| {
        view.update(cx, |view, _| view.active = false);
        view.read(cx).sidebar_scroll[0].set_offset(point(px(0.), px(0.)));
    });
    cx.simulate_mouse_move(away, None, Modifiers::default());
    cx.simulate_mouse_move(row, None, Modifiers::default());
    cx.simulate_mouse_move(row + point(px(0.), px(6.)), None, Modifiers::default());
    assert!(
        view.read_with(cx, |view, _| view.hover.is_some()),
        "row armed"
    );
    settle(&view, cx, super::super::HOVER_MENU_DELAY);
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
}

/// Without its feature flag, a resting pointer arms nothing and opens nothing:
/// only a right click still opens a space's menu.
#[gpui::test]
fn resting_on_a_workspace_opens_nothing_by_default(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = fixture_window(window, cx);
        view.live.status = crate::state::ConnectionStatus::Connected;
        view.active = true;
        view
    });
    assert!(!crate::config::Config::default().features.sidebar_hover_menu);
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let row = cx.debug_bounds("row-herdr").unwrap().center();

    cx.simulate_mouse_move(row, None, Modifiers::default());
    cx.simulate_mouse_move(row + point(px(6.), px(0.)), None, Modifiers::default());
    assert!(
        view.read_with(cx, |view, _| view.hover.is_none()),
        "row armed"
    );
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // A stale rest from before the flag was turned off still expires.
            view.hover_workspace("w0", true, window);
            view.poll_hover_menu(
                std::time::Instant::now() + super::super::HOVER_MENU_DELAY * 2,
                window,
                cx,
            );
            assert!(view.menu.page.is_none());
            assert!(view.hover.is_none());
            assert!(view.hover_menu.is_none());
        });
        full_draw(window, cx).clear(cx);
    });
}
