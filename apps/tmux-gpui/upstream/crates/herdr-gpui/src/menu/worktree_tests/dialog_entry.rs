use super::*;

/// The new worktree shortcut opens the same dialog as the focused workspace's
/// menu row; a linked checkout defers to its repository's main checkout, and a
/// workspace outside Git opens nothing.
#[gpui::test]
fn shortcut_opens_the_dialog_for_the_focused_repository(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    cx.update(|_, cx| crate::bind_keys(cx));
    for (focused, expected) in [("w3", Some("w3")), ("w4", Some("w3")), ("w1", Some("w1"))] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
                snapshot.focused_workspace_id = Some(focused.into());
                view.live.status = crate::state::ConnectionStatus::Connected;
                view.live.local_daemon_peer = true;
                view.menu.reset();
                view.menu.github = Default::default();
                window.focus(&view.focus, cx);
            });
        });
        draw(cx);
        cx.simulate_keystrokes("cmd-n");
        cx.update(|_, cx| {
            let menu = &view.read(cx).menu;
            assert_eq!(
                menu.page,
                expected.map(|_| Page::Dialog(WorkspaceAction::NewWorktree)),
                "{focused}"
            );
            assert_eq!(
                menu.target.as_ref().map(|target| target.id.as_str()),
                expected,
                "{focused}"
            );
            // A linked checkout still branches from where it stands.
            assert_eq!(
                menu.target.as_ref().map(|target| target.base_label()),
                expected.map(|_| if focused == "w4" {
                    "worktree/sidebar-child"
                } else {
                    "HEAD"
                }),
                "{focused}"
            );
        });
    }
    // Every refusal says why in the flash instead of doing nothing visible.
    use super::super::workspace::NewWorktreeUnavailable::*;
    type Setup = fn(&mut HerdrWindow);
    let cases: [(Setup, super::super::workspace::NewWorktreeUnavailable); 4] = [
        (
            |view| {
                let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                for workspace in &mut snapshot.workspaces {
                    if workspace.workspace_id == "w1" {
                        workspace.branch = None;
                    }
                }
            },
            NotGit,
        ),
        (
            |view| {
                let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                snapshot
                    .workspaces
                    .retain(|workspace| workspace.workspace_id != "w3");
                snapshot.focused_workspace_id = Some("w4".into());
            },
            MainCheckoutClosed,
        ),
        (
            |view| {
                let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                snapshot.focused_workspace_id = None;
            },
            NoWorkspace,
        ),
        (
            |view| view.live.status = crate::state::ConnectionStatus::Disconnected,
            Disconnected,
        ),
    ];
    for (setup, reason) in cases {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
                snapshot.focused_workspace_id = Some("w1".into());
                view.live.status = crate::state::ConnectionStatus::Connected;
                view.menu.reset();
                view.flash = None;
                setup(view);
                window.focus(&view.focus, cx);
            });
        });
        draw(cx);
        cx.simulate_keystrokes("cmd-n");
        draw(cx);
        cx.update(|_, cx| {
            let view = view.read(cx);
            assert!(view.menu.page.is_none(), "{reason:?}");
            assert_eq!(
                view.flash.as_ref().map(|(flash, _)| flash),
                Some(&crate::window::Flash::warning(reason.message()))
            );
        });
        assert!(cx.debug_bounds("flash").is_some(), "{reason:?}");
    }
}

/// A linked checkout's own menu offers a new worktree too. The dialog runs
/// through the main checkout and says which branch it starts from.
#[gpui::test]
fn linked_checkout_menu_creates_from_its_branch(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.live.local_daemon_peer = true;
            view.menu.reset();
            view.open_workspace_menu("w4", Default::default(), window, cx);
            let items = view.workspace_items();
            assert!(items.iter().any(|(_, label)| *label == "New worktree"));
            // Opening an existing checkout stays a main checkout action.
            assert!(!items.iter().any(|(_, label)| *label == "Open worktree..."));
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            let target = view.menu.target.as_ref().unwrap();
            assert_eq!(target.id, "w3");
            assert_eq!(target.base_label(), "worktree/sidebar-child");
        });
    });
    draw(cx);
    assert!(cx.debug_bounds("dialog-checkout").is_some());

    // Without its main checkout open, the row is not offered.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces.retain(|w| w.workspace_id != "w3");
            view.menu.reset();
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert!(
                !view
                    .workspace_items()
                    .iter()
                    .any(|(_, label)| *label == "New worktree")
            );
        });
    });
}
