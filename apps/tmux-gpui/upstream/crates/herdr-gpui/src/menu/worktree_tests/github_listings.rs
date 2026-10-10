use super::*;

/// Neither GitHub listing exists without an account, so those tabs do not move
/// and the dialog stays the branch form it has always been.
#[gpui::test]
fn github_tabs_are_inert_until_an_account_is_connected(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, false, Tab::New);
    for selector in [
        "worktree-search",
        "worktree-tab-new",
        "worktree-tab-existing",
        "worktree-tab-branch",
        "worktree-tab-PR",
        "worktree-tab-issues",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select_worktree_tab(Tab::Items(Kind::PullRequest), window, cx);
        });
    });
    draw(cx);
    assert_eq!(tab(&view, cx), Tab::New);
    // The branch field and its checkout preview are still what the dialog
    // shows, and no listing was requested for an account that does not exist.
    assert!(cx.debug_bounds("dialog-input").is_some());
    assert!(cx.debug_bounds("dialog-checkout").is_some());
    assert!(cx.debug_bounds("worktree-row-0").is_none());
    cx.update(|_, cx| {
        let source = view.read(cx).menu.worktree.as_ref().unwrap();
        assert!(!source.lookup.loading && source.lookup.message.is_none());
    });
}

/// With an account, a GitHub tab replaces the branch form with its listing.
#[gpui::test]
fn a_connected_account_turns_the_dialog_into_a_picker(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, true, Tab::Items(Kind::Issue));
    assert_eq!(tab(&view, cx), Tab::Items(Kind::Issue));
    assert!(cx.debug_bounds("worktree-row-0").is_some());
    assert!(cx.debug_bounds("worktree-status").is_some());
    // A picked row creates its own checkout, so this tab has no branch to type
    // and no submit button; cancelling is still the way out.
    assert!(cx.debug_bounds("dialog-input").is_none());
    assert!(cx.debug_bounds("dialog-submit").is_none());
    assert!(cx.debug_bounds("dialog-cancel").is_some());
    // Rows stay inside the panel rather than growing it past the window.
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let row = cx.debug_bounds("worktree-row-0").unwrap();
    let status = cx.debug_bounds("worktree-status").unwrap();
    assert!(panel.contains(&row.origin) && row.right() <= panel.right());
    assert!(row.bottom() <= status.top());
    assert!(status.bottom() <= panel.bottom());
    assert!(panel.bottom() <= gpui::px(700.));
}

/// Each tab lists only its own kind, the search narrows it as it is typed, and
/// none of that typing reaches the branch draft behind the tab.
#[gpui::test]
fn searching_a_listing_filters_its_own_rows_only(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, true, Tab::New);
    let branch = cx.update(|_, cx| view.read(cx).menu.input.as_ref().unwrap().text.clone());

    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select_worktree_tab(Tab::Items(Kind::PullRequest), window, cx);
        });
    });
    draw(cx);
    let numbers = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            let source = view.read(cx).menu.worktree.as_ref().unwrap();
            (0..source.filtered.len())
                .filter_map(|row| source.item(row).map(|item| item.number))
                .collect::<Vec<_>>()
        })
    };
    assert_eq!(numbers(cx), vec![48, 51]);

    cx.simulate_input("fork");
    draw(cx);
    assert_eq!(numbers(cx), vec![51]);
    // Searching an author works as well as searching a title or a number.
    cx.update(|_, cx| {
        let search = view.read(cx).menu.worktree.as_ref().unwrap().search.clone();
        search.update(cx, |input, cx| input.clear(cx));
    });
    cx.simulate_input("penso");
    draw(cx);
    assert_eq!(numbers(cx), vec![48]);

    // The issue tab shares the one listing but shows only issues.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select_worktree_tab(Tab::Items(Kind::Issue), window, cx);
        });
    });
    draw(cx);
    assert_eq!(numbers(cx), vec![1255]);

    // Everything typed went to the search field, not the branch behind it.
    assert_eq!(
        cx.update(|_, cx| view.read(cx).menu.input.as_ref().unwrap().text.clone()),
        branch
    );
}

/// What a picked row asks the daemon for: a pull request checks its own head
/// branch out, an issue gets a new branch named after it, and both name the
/// checkout for what it is for.
#[gpui::test]
fn a_picked_row_names_the_branch_base_and_label_it_creates(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    open_dialog(&view, cx, true, Tab::Items(Kind::PullRequest));
    cx.update(|_, cx| {
        let view = view.read(cx);
        let target = view.menu.target.as_ref().unwrap();
        let snapshot = view.live.snapshot.as_ref().unwrap();
        let items = items();

        let (method, params) = item_request(target, snapshot, &items[0]).unwrap();
        assert_eq!(method, herdr_client::Method::WorktreeCreate);
        assert_eq!(params["branch"], "worktree/rapid-forest");
        // An existing head may live only on the remote, so the base names the
        // tracking ref rather than the source workspace's HEAD.
        assert_eq!(params["base"], "refs/remotes/origin/worktree/rapid-forest");
        assert_eq!(params["label"], "#48 Centre the worktree dialog");
        assert_eq!(params["trust_repository"], false);

        let (_, params) = item_request(target, snapshot, &items[1]).unwrap();
        assert_eq!(params["branch"], "pr/51");
        assert_eq!(params["base"], "refs/herdr/pull/51/head");
        assert_eq!(params["trust_repository"], false);

        let (_, params) = item_request(target, snapshot, &items[2]).unwrap();
        assert_eq!(params["branch"], "1255-bug-agent-end-message-is-empty");
        // An issue's branch is new, so it starts from the dialog's own base.
        assert_eq!(params["base"], "HEAD");
        assert_eq!(params["label"], "#1255 bug: agent end message is empty");
    });
}

/// Picking a row is the whole action, and it is the only one running: a fork
/// pull request holds the
/// dialog while its branch is fetched, and a refusal releases the row again.
#[gpui::test]
fn picking_a_row_creates_its_checkout(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, true, Tab::Items(Kind::PullRequest));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.create_from_repo_item(1, cx);
            assert!(view.menu.creation.is_none());

            view.create_from_repo_item(0, cx);
            let source = view.menu.worktree.as_ref().unwrap();
            // The dialog holds the row it is creating, so a second pick cannot
            // start a second checkout while the first is still running.
            assert!(source.busy());
            assert!(matches!(
                &source.pending,
                Some(Pending::Item(item)) if item.number == 51
            ));
            assert!(source.lookup.loading);
            assert!(view.menu.error.is_none());
            assert_eq!(
                view.menu.page,
                Some(Page::Dialog(WorkspaceAction::NewWorktree))
            );
        });
    });

    // A refusal releases the row so the listing can be used again.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.menu.creation = Some("create".into());
            view.apply_creation_response(
                Ok(serde_json::json!({"error":{"code":"worktree_create_failed","message":"branch already checked out"}})),
                window,
                cx,
            );
            let source = view.menu.worktree.as_ref().unwrap();
            assert!(!source.busy());
            assert_eq!(source.tab, Tab::Items(Kind::PullRequest));
            assert!(
                view.menu
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("branch already checked out")
            );
            assert_eq!(
                view.menu.page,
                Some(Page::Dialog(WorkspaceAction::NewWorktree))
            );
        });
    });
    draw(cx);
    assert!(cx.debug_bounds("dialog-error").is_some());
    assert!(cx.debug_bounds("worktree-row-0").is_some());
    assert!(cx.debug_bounds("dialog-input").is_none());
}

#[gpui::test]
fn action_errors_stay_visible_in_every_listing_tab(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(600.), gpui::px(500.)));
    open_dialog(&view, cx, true, Tab::Items(Kind::PullRequest));
    for selected in [
        Tab::Existing,
        Tab::Branches,
        Tab::Items(Kind::PullRequest),
        Tab::Items(Kind::Issue),
    ] {
        cx.update(|_, cx| {
            view.update(cx, |view, cx| {
                let source = view.menu.worktree.as_mut().unwrap();
                source.tab = selected;
                source.refresh();
                view.menu.error = Some("The checkout could not be created. ".repeat(100));
                cx.notify();
            })
        });
        draw(cx);
        assert_eq!(tab(&view, cx), selected);
        assert!(cx.debug_bounds("dialog-error").is_some());
        let status = cx.debug_bounds("worktree-status").unwrap();
        let footer = cx.debug_bounds("dialog-footer").unwrap();
        assert!(status.bottom() <= footer.top());
        assert!(cx.debug_bounds("dialog-input").is_none());
    }
}

/// Tab moves between the dialog's tabs, and the listing owns the keys that
/// drive its rows rather than leaking them to the branch form.
#[gpui::test]
fn keys_move_between_tabs_and_through_the_rows(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, true, Tab::New);
    assert_eq!(tab(&view, cx), Tab::New);
    cx.simulate_keystrokes("tab");
    assert_eq!(tab(&view, cx), Tab::Existing);
    cx.simulate_keystrokes("tab");
    assert_eq!(tab(&view, cx), Tab::Branches);
    cx.simulate_keystrokes("tab");
    assert_eq!(tab(&view, cx), Tab::Items(Kind::PullRequest));
    cx.simulate_keystrokes("tab");
    assert_eq!(tab(&view, cx), Tab::Items(Kind::Issue));
    // The strip wraps, and shift-tab walks it the other way.
    cx.simulate_keystrokes("tab");
    assert_eq!(tab(&view, cx), Tab::New);
    cx.simulate_keystrokes("shift-tab");
    assert_eq!(tab(&view, cx), Tab::Items(Kind::Issue));

    cx.simulate_keystrokes("shift-tab");
    draw(cx);
    let selected = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| view.read(cx).menu.worktree.as_ref().unwrap().selected)
    };
    assert_eq!(selected(cx), 0);
    cx.simulate_keystrokes("down");
    assert_eq!(selected(cx), 1);
    // The rows wrap, as the other pickers' do.
    cx.simulate_keystrokes("down");
    assert_eq!(selected(cx), 0);
    cx.simulate_keystrokes("up");
    assert_eq!(selected(cx), 1);

    // Escape still closes the dialog from a listing.
    cx.simulate_keystrokes("escape");
    cx.update(|_, cx| assert!(view.read(cx).menu.page.is_none()));
}
