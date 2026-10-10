use super::*;

#[gpui::test]
fn worktree_rows_wear_their_cached_pull_request(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    // Rows w3..w5 are the fixture's worktree group; w4 is a linked checkout.
    let bare = cx.debug_bounds("name-sidebar-child").unwrap();
    assert!(cx.debug_bounds("pr-sidebar-child").is_none());
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            // A standalone checkout too, to compare with a collapsible group row.
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            let solo_key = if cfg!(windows) {
                "C:/fixture/solo/.git"
            } else {
                "/fixture/solo/.git"
            };
            snapshot.workspaces[0].worktree = Some(ClientShellWorktree {
                key: solo_key.into(),
                label: "solo".into(),
                is_linked_worktree: false,
            });
            let now = std::time::Instant::now();
            for (key, branch, number, state, additions, deletions) in [
                (REPO_KEY, "worktree/sidebar-child", 7, "MERGED", 23, 342),
                (solo_key, "main", 9, "OPEN", 4, 5),
                // The group's own head, so a row carries arrow and badge both.
                (REPO_KEY, "develop", 11, "OPEN", 1, 2),
            ] {
                let mut value = crate::pull_request::fixture().unwrap();
                value.number = number;
                value.state = crate::pull_request::State::from(state.to_owned());
                value.additions = additions;
                value.deletions = deletions;
                view.menu.pr_cache.seed(
                    crate::pull_request::Input {
                        checkout: None,
                        repo_key: Some(key.into()),
                        branch: branch.into(),
                    },
                    value,
                    now,
                );
            }
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        cx.default_global::<TextProbes>().0.clear();
        window.refresh();
        full_draw(window, cx).clear(cx);
    });
    let badge = cx.debug_bounds("pr-sidebar-child").unwrap();
    let row = cx.debug_bounds("row-sidebar-child").unwrap();
    let name = cx.debug_bounds("name-sidebar-child").unwrap();
    // The badge takes its column from the label, inside the row.
    assert!(badge.right() <= row.right());
    assert!(name.right() <= badge.left());
    assert!(name.size.width < bare.size.width);
    // The tree gutter sits under the parent's label and stops at the child's
    // own dot: lines never reach the text on either side.
    let gutter = cx.debug_bounds("tree-sidebar-child").unwrap();
    let parent_column = cx.debug_bounds("column-agent-launcher").unwrap();
    let child_column = cx.debug_bounds("column-sidebar-child").unwrap();
    assert_eq!(gutter.left(), parent_column.left());
    assert!(gutter.right() <= child_column.left() - px(super::super::STATUS_WIDTH));
    // Badges hug the row's inner edge, whether or not the row can collapse and
    // whether or not an arrow is drawn in front of them.
    let solo = cx.debug_bounds("pr-herdr").unwrap();
    let head = cx.debug_bounds("pr-agent-launcher").unwrap();
    let arrow = cx.debug_bounds("collapse-3").unwrap();
    for right in [solo.right(), head.right(), badge.right()] {
        assert_eq!(right, row.right() - px(12.), "badges must be flush right");
    }
    assert!(arrow.right() <= head.left(), "{arrow:?} {head:?}");
    cx.update(|_, cx| {
        let probes = &cx.global::<TextProbes>().0;
        for text in ["#7", "+23", "-342", "#9", "+4", "-5"] {
            assert!(
                probes.contains_key(text),
                "missing {text}: {:?}",
                probes.keys()
            );
        }
    });
}

#[gpui::test]
fn worktree_rows_mark_uncommitted_work(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let clean_label = cx.debug_bounds("name-sidebar-child").unwrap();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let now = std::time::Instant::now();
            let input = |branch: &str| crate::pull_request::Input {
                checkout: None,
                repo_key: Some(REPO_KEY.into()),
                branch: branch.into(),
            };
            // A checkout with a pull request and uncommitted work, and one that
            // only has uncommitted work.
            view.menu.pr_cache.seed(
                input("worktree/sidebar-child"),
                crate::pull_request::fixture().unwrap(),
                now,
            );
            view.git
                .seed_probe(input("worktree/sidebar-child"), true, now);
            view.git.seed_probe(input("develop"), true, now);
            // Answered and clean: no mark, and no column reserved for one.
            view.git.seed_probe(
                input("worktree/sidebar-child-with-a-long-readable-branch-name"),
                false,
                now,
            );
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        window.refresh();
        full_draw(window, cx).clear(cx);
    });
    let row = cx.debug_bounds("row-sidebar-child").unwrap();
    let badge = cx.debug_bounds("pr-sidebar-child").unwrap();
    let dot = cx.debug_bounds("dirty-sidebar-child").unwrap();
    assert_eq!(dot.size.width, px(12.));
    assert_eq!(dot.size.height, px(12.));
    // The mark leads the badge column, still flush against the row's edge.
    assert!(badge.left() <= dot.left() && dot.right() <= badge.right());
    assert_eq!(badge.right(), row.right() - px(12.));
    assert!(cx.debug_bounds("name-sidebar-child").unwrap().right() <= badge.left());
    assert!(clean_label.size.width > cx.debug_bounds("name-sidebar-child").unwrap().size.width);
    // A dirty checkout without a pull request still earns the column.
    let head = cx.debug_bounds("pr-agent-launcher").unwrap();
    let head_dot = cx.debug_bounds("dirty-agent-launcher").unwrap();
    assert_eq!(
        head.right(),
        cx.debug_bounds("row-agent-launcher").unwrap().right() - px(12.)
    );
    assert!(head.left() <= head_dot.left() && head_dot.right() <= head.right());
    assert!(
        cx.debug_bounds("dirty-sidebar-child-with-a-long-readable-branch-name")
            .is_none(),
        "a clean checkout is not marked"
    );
}

#[gpui::test]
fn the_workspace_menu_folds_and_unfolds_a_worktree_group(cx: &mut gpui::TestAppContext) {
    use gpui::{Modifiers, MouseButton};
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.live.status = crate::state::ConnectionStatus::Connected;
        })
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    for (item, icon, collapsed) in [
        (
            "workspace-menu-Collapse group",
            "workspace-menu-icon-Collapse group",
            true,
        ),
        (
            "workspace-menu-Expand group",
            "workspace-menu-icon-Expand group",
            false,
        ),
    ] {
        let parent = cx.debug_bounds("row-agent-launcher").unwrap();
        cx.simulate_mouse_down(parent.center(), MouseButton::Right, Modifiers::default());
        cx.simulate_mouse_up(parent.center(), MouseButton::Right, Modifiers::default());
        cx.update(|window, cx| {
            full_draw(window, cx).clear(cx);
            assert!(view.read(cx).menu.page == Some(crate::menu::Page::Workspace));
        });
        let row = cx
            .debug_bounds(item)
            .unwrap_or_else(|| panic!("missing {item}"));
        assert!(cx.debug_bounds(icon).is_some(), "missing {icon}");
        cx.simulate_click(row.center(), Modifiers::default());
        cx.update(|window, cx| {
            cx.default_global::<TextProbes>().0.clear();
            window.refresh();
            full_draw(window, cx).clear(cx);
            let view = view.read(cx);
            // Folding is the client's own view of the list, not a daemon request.
            assert!(view.menu.page.is_none(), "{item} left the menu open");
            assert_eq!(view.collapsed_repos.contains(REPO_KEY), collapsed);
            assert_eq!(
                !cx.global::<TextProbes>().0.contains_key("sidebar-child"),
                collapsed,
                "{item} did not change the visible children"
            );
        });
    }
}
