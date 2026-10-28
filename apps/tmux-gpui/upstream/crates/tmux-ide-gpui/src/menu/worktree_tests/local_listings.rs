use super::*;

/// The daemon's worktree list, with the checkout Herdr already has open, one
/// it has not, and a detached one.
fn checkouts() -> serde_json::Value {
    serde_json::json!({"result": {"type": "worktree_list", "source": {
        "repo_key": "/fixture/agent-launcher/.git", "repo_name": "agent-launcher",
        "source_workspace_id": "w3"
    }, "worktrees": [
        {"path": "/fixture/agent-launcher", "branch": "main", "label": "agent-launcher",
         "is_bare": false, "is_prunable": false, "is_detached": false, "open_workspace_id": "w3"},
        {"path": "/worktrees/agent-launcher/fix-login", "branch": "fix/login", "label": "fix-login",
         "is_bare": false, "is_prunable": false, "is_detached": false},
        {"path": "/worktrees/agent-launcher/bisect", "label": "bisect",
         "is_bare": false, "is_prunable": false, "is_detached": true}
    ]}})
}

fn branches() -> Vec<Branch> {
    vec![
        Branch {
            name: "feature/login".into(),
        },
        Branch {
            name: "fix/crash".into(),
        },
    ]
}

fn install_local_listings(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) {
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let source = view.menu.worktree.as_mut().unwrap();
            source.install_checkouts(checkouts());
            source.install_branches(branches());
        });
    });
    draw(cx);
}

/// The existing tab offers only the checkouts no workspace has open, and a
/// picked one is opened by the daemon rather than created.
#[gpui::test]
fn existing_checkouts_not_open_in_herdr_are_offered_for_opening(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, false, Tab::New);
    install_local_listings(&view, cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select_worktree_tab(Tab::Existing, window, cx);
        });
    });
    draw(cx);
    assert_eq!(tab(&view, cx), Tab::Existing);
    assert!(cx.debug_bounds("worktree-row-1").is_some());
    assert!(cx.debug_bounds("worktree-row-2").is_none());
    cx.update(|_, cx| {
        let view = view.read(cx);
        let source = view.menu.worktree.as_ref().unwrap();
        let paths: Vec<_> = source
            .checkouts
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(
            paths,
            [
                "/worktrees/agent-launcher/fix-login",
                "/worktrees/agent-launcher/bisect"
            ]
        );
        let target = view.menu.target.as_ref().unwrap();
        let snapshot = view.live.snapshot.as_ref().unwrap();
        let (method, params) = pick_request(
            target,
            snapshot,
            &Pending::Checkout("/worktrees/agent-launcher/fix-login".into()),
        )
        .unwrap();
        assert_eq!(method, herdr_client::Method::WorktreeOpen);
        assert_eq!(params["path"], "/worktrees/agent-launcher/fix-login");
        assert_eq!(params["trust_repository"], false);
    });

    // An opened checkout answers as opened, and the dialog follows it.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.menu.worktree.as_mut().unwrap().pending = Some(Pending::Checkout(
                "/worktrees/agent-launcher/fix-login".into(),
            ));
            view.menu.creation = Some("open".into());
            view.apply_creation_response(
                Ok(serde_json::json!({"result": {"type": "worktree_opened",
                    "workspace": {"workspace_id": "w9"}}})),
                window,
                cx,
            );
            assert!(view.menu.error.is_none(), "{:?}", view.menu.error);
            assert!(view.menu.page.is_none());
        });
    });
}

/// A local branch is checked out as it is, and its row is only its name, one
/// line tall where a checkout also shows its path.
#[gpui::test]
fn local_branches_without_a_checkout_are_one_line_rows(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, false, Tab::New);
    install_local_listings(&view, cx);
    let row_height = |tab: Tab, cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| view.select_worktree_tab(tab, window, cx));
        });
        draw(cx);
        cx.debug_bounds("worktree-row-0").unwrap().size.height
    };
    let checkout = row_height(Tab::Existing, cx);
    let branch = row_height(Tab::Branches, cx);
    let line = cx.update(|_, cx| gpui::px(view.read(cx).config.ui.line_height()));
    // Layout rounds to device pixels, so allow a pixel either way.
    assert!(
        (checkout - branch - line).abs() <= gpui::px(1.),
        "{checkout:?} {branch:?} {line:?}"
    );
    assert!(cx.debug_bounds("worktree-row-1").is_some());
    cx.update(|_, cx| {
        let view = view.read(cx);
        let target = view.menu.target.as_ref().unwrap();
        let snapshot = view.live.snapshot.as_ref().unwrap();
        let (method, params) =
            pick_request(target, snapshot, &Pending::Branch(branches()[0].clone())).unwrap();
        assert_eq!(method, herdr_client::Method::WorktreeCreate);
        assert_eq!(params["branch"], "feature/login");
        assert_eq!(params["base"], "HEAD");
    });
}

/// One search field sits above the tabs and searches every listing: each tab
/// counts what it kept, typing from the branch form moves to the first tab
/// that matched, and the branch draft is never typed into.
#[gpui::test]
fn one_search_field_searches_every_tab(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, true, Tab::New);
    install_local_listings(&view, cx);
    let branch = cx.update(|_, cx| view.read(cx).menu.input.as_ref().unwrap().text.clone());
    let search = view.read_with(cx, |view, _| {
        view.menu.worktree.as_ref().unwrap().search.clone()
    });
    let tabs = cx.debug_bounds("worktree-tabs").unwrap();
    let search_bounds = cx.debug_bounds("worktree-search").unwrap();
    assert!(
        search_bounds.bottom() <= tabs.top() + gpui::px(1.),
        "{search_bounds:?} {tabs:?}"
    );
    for count in [
        "worktree-tab-count-existing",
        "worktree-tab-count-branch",
        "worktree-tab-count-PR",
        "worktree-tab-count-issues",
    ] {
        assert!(cx.debug_bounds(count).is_some(), "{count}");
    }
    assert!(cx.debug_bounds("worktree-tab-count-new").is_none());

    cx.update(|window, cx| window.focus(&search.read(cx).focus.clone(), cx));
    cx.simulate_input("login");
    draw(cx);
    // The existing tab is the first that matched, so the dialog moved there.
    assert_eq!(tab(&view, cx), Tab::Existing);
    let hits = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            let source = view.read(cx).menu.worktree.as_ref().unwrap();
            Tab::ALL.map(|tab| source.hits(tab))
        })
    };
    // "fix/login" is a checkout and "feature/login" a branch; no GitHub row says so.
    assert_eq!(hits(cx), [None, Some(1), Some(1), Some(0), Some(0)]);

    cx.simulate_keystrokes("tab");
    assert_eq!(tab(&view, cx), Tab::Branches);
    cx.update(|_, cx| {
        let source = view.read(cx).menu.worktree.as_ref().unwrap();
        assert_eq!(source.filtered.len(), 1);
        assert_eq!(search.read(cx).text(), "login");
    });

    cx.update(|_, cx| search.update(cx, |input, cx| input.clear(cx)));
    cx.simulate_input("fork");
    draw(cx);
    assert_eq!(hits(cx), [None, Some(0), Some(0), Some(1), Some(0)]);
    assert_eq!(
        cx.update(|_, cx| view.read(cx).menu.input.as_ref().unwrap().text.clone()),
        branch
    );
}

/// Moving between tabs never resizes the dialog: the branch form takes the
/// same settled size as the listings, whatever each one holds.
#[gpui::test]
fn every_tab_keeps_the_same_dialog_size(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, true, Tab::New);
    install_local_listings(&view, cx);
    let form = cx.debug_bounds("menu-panel").unwrap();
    for tab in Tab::ALL {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| view.select_worktree_tab(tab, window, cx));
        });
        draw(cx);
        assert_eq!(self::tab(&view, cx), tab);
        let panel = cx.debug_bounds("menu-panel").unwrap();
        assert_eq!(panel.size, form.size, "{tab:?}");
    }
    // The form's footer still sits at the panel's bottom edge.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select_worktree_tab(Tab::New, window, cx)
        });
    });
    draw(cx);
    let footer = cx.debug_bounds("dialog-footer").unwrap();
    assert!((form.bottom() - footer.bottom()).abs() <= gpui::px(2.));
}
