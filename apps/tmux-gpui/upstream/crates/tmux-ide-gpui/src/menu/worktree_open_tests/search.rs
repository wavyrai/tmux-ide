use super::*;

#[gpui::test]
fn open_worktree_search_filters_automatically_and_preserves_path_selection(
    cx: &mut TestAppContext,
) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = ConnectionStatus::Connected;
            view.open_workspace_menu("w3", gpui::point(px(750.), px(550.)), window, cx);
            view.open_workspace_dialog(WorkspaceAction::OpenWorktree, window, cx);
            pending(&mut view.menu, cx);
            assert!(
                view.menu
                    .worktree_open
                    .as_ref()
                    .unwrap()
                    .search
                    .read(cx)
                    .focus
                    .is_focused(window)
            );
        });
        window.draw(cx).clear(cx);
    });
    // Queries typed before the asynchronous listing arrives apply to that listing.
    cx.simulate_input("SPACES");
    cx.run_until_parked();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let mut response = listing();
            response["result"]["worktrees"][1]["label"] = json!("D\u{e9}tached");
            view.menu.apply_worktree_list_response("list", Ok(response));
            assert_eq!(view.menu.worktree_open.as_ref().unwrap().filtered, [1]);
            cx.notify();
        });
    });
    for (query, indices) in [
        ("MAIN", vec![0]),
        ("parent", vec![0]),
        ("spaces", vec![1]),
        ("D\u{c9}T", vec![1]),
        ("no such checkout", vec![]),
        ("", vec![0, 1]),
    ] {
        cx.simulate_keystrokes("cmd-a backspace");
        cx.simulate_input(query);
        cx.run_until_parked();
        cx.update(|_, cx| {
            let picker = view.read(cx).menu.worktree_open.as_ref().unwrap();
            assert_eq!(picker.filtered, indices, "{query}");
            assert_eq!(picker.selected, 0);
        });
        if indices.is_empty() {
            for _ in 0..2 {
                cx.update(|window, cx| window.draw(cx).clear(cx));
            }
            assert!(cx.debug_bounds("open-worktree-no-matches").is_some());
            cx.update(|_, cx| {
                assert!(
                    !view
                        .read(cx)
                        .menu
                        .worktree_open
                        .as_ref()
                        .unwrap()
                        .entries
                        .is_empty()
                )
            });
            cx.simulate_keystrokes("up down enter");
            cx.update(|_, cx| assert!(view.read(cx).menu.creation.is_none()));
        }
    }
    cx.simulate_keystrokes("down");
    cx.update(|_, cx| {
        assert_eq!(
            view.read(cx).menu.worktree_open.as_ref().unwrap().selected,
            1
        )
    });
    cx.simulate_input("SPACES");
    cx.run_until_parked();
    cx.simulate_keystrokes("up down");
    cx.update(|_, cx| {
        let view = view.read(cx);
        let picker = view.menu.worktree_open.as_ref().unwrap();
        assert_eq!(picker.selected, 0);
        assert_eq!(
            picker.entry(picker.selected).unwrap().path,
            "/remote/checkout with spaces "
        );
        let (_, params) = view
            .menu
            .target
            .as_ref()
            .unwrap()
            .request(
                view.live.snapshot.as_ref().unwrap(),
                WorkspaceAction::OpenWorktree,
                &picker.entry(picker.selected).unwrap().path,
            )
            .unwrap();
        assert_eq!(params["path"], "/remote/checkout with spaces ");
    });
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        assert_eq!(
            view.read(cx).menu.error.as_deref(),
            Some("Not connected to a daemon.")
        )
    });
}

#[gpui::test]
fn open_worktree_search_composition_and_reopen_are_isolated(cx: &mut TestAppContext) {
    use gpui::EntityInputHandler;
    let (view, cx) = cx.add_window_view(fixture_window);
    let search = cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = ConnectionStatus::Connected;
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::OpenWorktree, window, cx);
            pending(&mut view.menu, cx);
            view.menu
                .apply_worktree_list_response("list", Ok(listing()));
            view.menu.worktree_open.as_ref().unwrap().search.clone()
        })
    });
    cx.update(|window, cx| {
        search.update(cx, |input, cx| {
            input.replace_and_mark_text_in_range(None, "remote", Some(0..6), window, cx)
        });
        window.draw(cx).clear(cx);
    });
    // Each key starts mid-composition; the test platform simulates Enter committing it.
    for key in ["up", "down", "enter", "escape", "cmd-n", "cmd-t"] {
        cx.update(|window, cx| {
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(
                    Some(0..input.text().encode_utf16().count()),
                    "remote",
                    Some(0..6),
                    window,
                    cx,
                )
            });
        });
        cx.simulate_keystrokes(key);
        cx.update(|_, cx| {
            assert_eq!(
                view.read(cx).menu.page,
                Some(Page::Dialog(WorkspaceAction::OpenWorktree)),
                "{key}"
            )
        });
    }
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert_eq!(
                view.menu.page,
                Some(Page::Dialog(WorkspaceAction::OpenWorktree))
            );
            assert_eq!(view.menu.worktree_open.as_ref().unwrap().selected, 0);
            assert!(search.read(cx).is_composing());
            view.submit_workspace_dialog(window, cx);
            assert!(view.menu.creation.is_none() && view.menu.error.is_none());
            assert!(view.marked.is_empty());
            assert!(view.menu.input.is_none());
        });
        search.update(cx, |input, cx| {
            input.replace_text_in_range(None, "remote", window, cx)
        });
    });
    cx.simulate_keystrokes("down");
    cx.update(|_, cx| {
        assert_eq!(
            view.read(cx).menu.worktree_open.as_ref().unwrap().selected,
            1
        )
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert!(view.menu.page.is_none());
            assert!(view.focus.is_focused(window));
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::OpenWorktree, window, cx);
            pending(&mut view.menu, cx);
            view.menu
                .apply_worktree_list_response("list", Ok(listing()));
        });
        // The old input entity is alive in this test, but its subscription is not.
        search.update(cx, |input, cx| {
            input.replace_text_in_range(Some(0..6), "spaces", window, cx)
        });
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        let view = view.read(cx);
        let picker = view.menu.worktree_open.as_ref().unwrap();
        assert!(picker.search.read(cx).text().is_empty());
        assert!(picker.search.read(cx).focus.is_focused(window));
        assert_eq!(picker.filtered, [0, 1]);
    });
}
