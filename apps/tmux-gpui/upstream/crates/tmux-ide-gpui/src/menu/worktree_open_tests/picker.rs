use super::*;

#[gpui::test]
fn open_worktree_picker_menu_keyboard_mouse_and_narrow_layout(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    for (width, height) in [(320., 400.), (1000., 800.)] {
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.dismiss_menu(window, cx);
                view.live.status = ConnectionStatus::Connected;
                view.open_workspace_menu("w3", Default::default(), window, cx);
            });
            window.draw(cx).clear(cx);
        });
        let row = cx.debug_bounds("workspace-menu-Open worktree...").unwrap();
        cx.simulate_click(row.center(), Modifiers::default());
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                assert_eq!(
                    view.menu.page,
                    Some(Page::Dialog(WorkspaceAction::OpenWorktree))
                );
                assert!(view.menu.input.is_none());
                pending(&mut view.menu, cx);
                view.menu
                    .apply_worktree_list_response("list", Ok(listing()));
                cx.notify();
            });
            window.draw(cx).clear(cx);
        });
        cx.simulate_keystrokes("down");
        cx.update(|_, cx| {
            assert_eq!(
                view.read(cx).menu.worktree_open.as_ref().unwrap().selected,
                1
            )
        });
        cx.simulate_keystrokes("cmd-n cmd-t");
        cx.update(|_, cx| {
            assert_eq!(
                view.read(cx).menu.page,
                Some(Page::Dialog(WorkspaceAction::OpenWorktree))
            );
            assert!(view.read(cx).menu.error.is_none());
        });
        let panel = cx.debug_bounds("menu-panel").unwrap();
        let submit = cx.debug_bounds("dialog-submit").unwrap();
        let search = cx.debug_bounds("open-worktree-search").unwrap();
        assert!((panel.center().x - px(width / 2.)).abs() <= px(1.));
        assert!((panel.center().y - px(height / 2.)).abs() <= px(1.));
        assert!(panel.contains(&search.origin) && search.right() <= panel.right());
        assert!(panel.left() >= px(0.) && panel.right() <= px(width));
        assert!(panel.bottom() <= px(height) && submit.bottom() <= panel.bottom());
        let row = cx.debug_bounds("open-worktree-row-0").unwrap();
        cx.simulate_click(row.center(), Modifiers::default());
        cx.update(|_, cx| {
            let view = view.read(cx);
            assert_eq!(view.menu.worktree_open.as_ref().unwrap().selected, 0);
            // The disconnected fixture cannot queue, and leaves a visible error.
            assert!(view.menu.error.is_some());
            assert!(view.menu.creation.is_none());
        });
        cx.simulate_keystrokes("escape");
        cx.update(|_, cx| assert!(view.read(cx).menu.page.is_none()));
    }
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // A linked checkout creates from its branch, but only the main
            // checkout opens existing ones.
            for (id, opens) in [("w3", true), ("w4", false)] {
                view.open_workspace_menu(id, Default::default(), window, cx);
                let actions = view.workspace_menu_actions();
                assert!(
                    actions.contains(&WorkspaceMenuAction::Dialog(WorkspaceAction::NewWorktree)),
                    "{id}"
                );
                assert_eq!(
                    actions.contains(&WorkspaceMenuAction::Dialog(WorkspaceAction::OpenWorktree)),
                    opens,
                    "{id}"
                );
                view.dismiss_menu(window, cx);
            }
        });
    });
}

#[gpui::test]
fn open_worktree_rows_fill_the_list_and_header_escape_dismisses(cx: &mut TestAppContext) {
    for width in [320., 1000.] {
        let (view, cx) = cx.add_window_view(fixture_window);
        cx.simulate_resize(size(px(width), px(600.)));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.live.status = ConnectionStatus::Connected;
                view.open_workspace_menu("w3", Default::default(), window, cx);
                view.open_workspace_dialog(WorkspaceAction::OpenWorktree, window, cx);
                pending(&mut view.menu, cx);
                let mut response = listing();
                response["result"]["worktrees"][0]["path"] = json!("/a");
                response["result"]["worktrees"][0]["branch"] = json!("a");
                response["result"]["worktrees"][1]["path"] =
                    json!(format!("/b/{}", "long path/".repeat(100)));
                response["result"]["worktrees"][1]["label"] = json!("long branch ".repeat(100));
                view.menu.apply_worktree_list_response("list", Ok(response));
                cx.notify();
            });
            window.draw(cx).clear(cx);
        });
        let panel = cx.debug_bounds("menu-panel").unwrap();
        let list = cx.debug_bounds("open-worktree-list").unwrap();
        let footer = cx.debug_bounds("dialog-footer").unwrap();
        // The idle picker spends all space below search on rows, not a hint block.
        assert!(cx.debug_bounds("open-worktree-status").is_none());
        assert!((list.bottom() - footer.top()).abs() <= px(1.));
        assert_eq!(
            list.size.width,
            cx.debug_bounds("open-worktree-search").unwrap().size.width
        );
        let mut status_right = None;
        for (row, status) in [
            ("open-worktree-row-0", "open-worktree-row-status-0"),
            ("open-worktree-row-1", "open-worktree-row-status-1"),
        ] {
            let row = cx.debug_bounds(row).unwrap();
            let status = cx.debug_bounds(status).unwrap();
            assert_eq!(row.left(), list.left());
            assert_eq!(row.size.width, list.size.width);
            assert_eq!(status.right(), row.right() - px(16.));
            assert!(row.contains(&status.origin) && status.bottom() <= row.bottom());
            if let Some(right) = status_right {
                assert_eq!(status.right(), right);
            }
            status_right = Some(status.right());
        }
        let header = cx.debug_bounds("dialog-header").unwrap();
        let title = cx.debug_bounds("dialog-title").unwrap();
        let escape = cx.debug_bounds("open-worktree-escape").unwrap();
        assert!(title.right() <= escape.left());
        assert_eq!(escape.right(), header.right() - px(16.));
        assert!(header.contains(&escape.origin) && escape.bottom() <= header.bottom());
        assert!(cx.debug_bounds("dialog-cancel").is_some());
        assert!(cx.debug_bounds("dialog-submit").is_some());
        // Errors and pending work still have a bounded status area above the footer.
        for waiting in [false, true] {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    view.menu.error = (!waiting).then(|| "Endpoint error. ".repeat(100));
                    view.menu.creation = waiting.then(|| "open".into());
                    cx.notify();
                });
                window.draw(cx).clear(cx);
            });
            let status = cx.debug_bounds("open-worktree-status").unwrap();
            let diagnostic = cx
                .debug_bounds(if waiting {
                    "dialog-waiting"
                } else {
                    "dialog-error"
                })
                .unwrap();
            assert!(diagnostic.top() >= status.top());
            assert!(status.size.height > px(0.) && status.bottom() <= footer.top());
            assert_eq!(cx.debug_bounds("menu-panel").unwrap(), panel);
            assert_eq!(cx.debug_bounds("dialog-footer").unwrap(), footer);
            assert_eq!(cx.debug_bounds("open-worktree-escape").unwrap(), escape);
        }
        cx.simulate_click(escape.center(), Modifiers::default());
        cx.update(|window, cx| {
            let view = view.read(cx);
            assert!(view.menu.page.is_none());
            assert!(view.menu.worktree_open.is_none() && view.menu.creation.is_none());
            assert!(view.focus.is_focused(window));
            assert!(view.pending_navigation.is_none());
        });
    }
}

#[gpui::test]
fn open_worktree_search_keeps_a_bounded_scrollable_centered_viewport(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    for (width, height) in [(320., 400.), (1000., 800.)] {
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.dismiss_menu(window, cx);
                view.live.status = ConnectionStatus::Connected;
                view.open_workspace_menu("w3", gpui::point(px(15.), px(20.)), window, cx);
                view.open_workspace_dialog(WorkspaceAction::OpenWorktree, window, cx);
                pending(&mut view.menu, cx);
                let entries: Vec<_> = (0..100)
                    .map(|index| {
                        json!({
                            "path": format!("/remote/{index}/{}", "long path ".repeat(40)),
                            "label": "long label ".repeat(40), "branch": format!("branch-{index}"),
                            "is_bare":false, "is_prunable":false, "is_detached":false
                        })
                    })
                    .collect();
                view.menu.apply_worktree_list_response(
                    "list",
                    Ok(json!({"result":{
                        "type":"worktree_list", "source":listing()["result"]["source"], "worktrees":entries
                    }})),
                );
                cx.notify();
            });
            window.draw(cx).clear(cx);
        });
        let panel = cx.debug_bounds("menu-panel").unwrap();
        let search = cx.debug_bounds("open-worktree-search").unwrap();
        let list = cx.debug_bounds("open-worktree-list").unwrap();
        let footer = cx.debug_bounds("dialog-footer").unwrap();
        assert!((panel.center().x - px(width / 2.)).abs() <= px(1.));
        assert!((panel.center().y - px(height / 2.)).abs() <= px(1.));
        // Up wraps to the final filtered entry and scrolls it into view.
        cx.simulate_keystrokes("up");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let last = cx.debug_bounds("open-worktree-row-99").unwrap();
        // Uniform-list scroll offsets round to physical pixels.
        assert!(
            last.top() >= search.bottom() - px(1.) && last.bottom() <= list.bottom() + px(1.),
            "last={last:?}, search={search:?}, list={list:?}"
        );
        assert!(last.left() >= panel.left() && last.right() <= panel.right());
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.menu.error = Some("Long endpoint error. ".repeat(100));
                cx.notify();
            });
            window.draw(cx).clear(cx);
        });
        assert_eq!(cx.debug_bounds("open-worktree-search").unwrap(), search);
        let status = cx.debug_bounds("open-worktree-status").unwrap();
        assert_eq!(cx.debug_bounds("dialog-footer").unwrap(), footer);
        let submit = cx.debug_bounds("dialog-submit").unwrap();
        assert!(status.bottom() <= submit.top() && submit.bottom() <= panel.bottom());
    }
}
