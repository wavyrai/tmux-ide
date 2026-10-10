use super::*;

/// The row menu follows the pointer, but the dialog it opens is a modal: it
/// centres over the window like the Herdr TUI's, whatever corner the menu was
/// opened from.
#[gpui::test]
fn workspace_dialogs_centre_on_the_window_rather_than_the_pointer(cx: &mut gpui::TestAppContext) {
    use gpui::{point, px};
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(px(800.), px(600.)));
    let centre = point(px(400.), px(300.));
    for anchor in [point(px(120.), px(140.)), point(px(700.), px(520.))] {
        for action in [
            WorkspaceAction::NewWorktree,
            WorkspaceAction::DeleteWorktree,
        ] {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                    snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
                    view.live.status = crate::state::ConnectionStatus::Connected;
                    view.menu.reset();
                    let id = if action == WorkspaceAction::NewWorktree {
                        "w3"
                    } else {
                        "w4"
                    };
                    view.open_workspace_menu(id, anchor, window, cx);
                });
                window.draw(cx).clear(cx);
            });
            // The menu itself still opens where the pointer asked for it.
            let menu = cx.debug_bounds("menu-panel").unwrap();
            assert!(
                (menu.center() - centre).x.abs() > px(40.)
                    || (menu.center() - centre).y.abs() > px(40.),
                "{anchor:?}: {menu:?}"
            );
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    view.open_workspace_dialog(action, window, cx)
                });
                window.draw(cx).clear(cx);
            });
            let panel = cx.debug_bounds("menu-panel").unwrap();
            let offset = panel.center() - centre;
            assert!(
                offset.x.abs() <= px(1.) && offset.y.abs() <= px(1.),
                "{anchor:?} {action:?}: {panel:?}"
            );
            // The new worktree tabs keep a listing's width on every tab.
            let widest = if action == WorkspaceAction::NewWorktree {
                px(560.)
            } else {
                px(480.)
            };
            assert!(panel.size.width <= widest && panel.size.width >= px(400.));
        }
    }
}

/// The dialog chrome matches the other modals: sections stacked in reading
/// order inside the panel, and a right-aligned Cancel/submit row.
#[gpui::test]
fn workspace_dialog_sections_and_buttons_stay_inside_the_panel(cx: &mut gpui::TestAppContext) {
    use gpui::px;
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    for (width, height) in [(640., 400.), (1200., 780.)] {
        cx.simulate_resize(gpui::size(px(width), px(height)));
        for action in [
            WorkspaceAction::NewWorktree,
            WorkspaceAction::DeleteWorktree,
        ] {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                    snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
                    snapshot.worktree_directory = "/endpoint/.herdr/worktrees".into();
                    view.live.status = crate::state::ConnectionStatus::Connected;
                    view.menu.reset();
                    let id = if action == WorkspaceAction::NewWorktree {
                        "w3"
                    } else {
                        "w4"
                    };
                    view.open_workspace_menu(id, Default::default(), window, cx);
                    view.open_workspace_dialog(action, window, cx);
                    if action == WorkspaceAction::DeleteWorktree {
                        // Ready to confirm: the daemon has named the
                        // checkout and nothing is in flight.
                        view.menu.deletion = Some(Deletion {
                            path: Some("/endpoint/.herdr/worktrees/agent-launcher/child".into()),
                            archive: ArchiveCheck::Read(None),
                            ..Deletion::new(None, true)
                        });
                    } else {
                        // The creation waits on the daemon here, so its
                        // waiting note belongs to this frame too.
                        view.menu.creation = Some("create".into());
                    }
                    view.menu.error = Some("fixture error".into());
                });
                window.draw(cx).clear(cx);
            });
            let panel = cx.debug_bounds("menu-panel").unwrap();
            let cancel = cx.debug_bounds("dialog-cancel").unwrap();
            let submit = cx.debug_bounds("dialog-submit").unwrap();
            let error = cx.debug_bounds("dialog-error").unwrap();
            // Only a creation waits on the daemon: a removal is queued and
            // its dialog closes rather than reporting progress.
            let waiting = (action == WorkspaceAction::NewWorktree)
                .then(|| cx.debug_bounds("dialog-waiting").unwrap());
            // Creation drafts a branch and previews its checkout; deletion
            // confirms the one the daemon named, with nothing to type.
            let (field, subject) = if action == WorkspaceAction::NewWorktree {
                (
                    cx.debug_bounds("dialog-input").unwrap(),
                    cx.debug_bounds("dialog-checkout").unwrap(),
                )
            } else {
                // Deletion is confirmed by its button, with nothing to type.
                assert!(cx.update(|_, cx| view.read(cx).menu.input.is_none()));
                let path = cx.debug_bounds("dialog-path").unwrap();
                (path, path)
            };
            // The name comes first, on the same edge as the branch it names.
            let name = (action == WorkspaceAction::NewWorktree)
                .then(|| cx.debug_bounds("worktree-name").unwrap());
            if let Some(name) = name {
                assert!(name.bottom() <= field.top());
                assert_eq!(name.left(), field.left());
                assert_eq!(name.right(), field.right());
            }
            let parts: Vec<_> = [field, subject, cancel, submit, error]
                .into_iter()
                .chain(waiting)
                .chain(name)
                .collect();
            for part in &parts {
                assert!(
                    part.left() >= panel.left() && part.right() <= panel.right(),
                    "{action:?} at {width}: {part:?} escapes {panel:?}"
                );
                assert!(part.right() <= px(width));
                // A roomy window must not make any dialog scroll to its buttons.
                if height > 400. {
                    assert!(
                        part.top() >= panel.top() && part.bottom() <= panel.bottom(),
                        "{action:?} at {height}: {part:?} needs scrolling in {panel:?}"
                    );
                    assert!(part.bottom() <= px(height));
                }
            }
            // One gutter on both sides, and a trailing button row.
            assert_eq!(
                subject.left() - panel.left(),
                panel.right() - subject.right()
            );
            assert_eq!(field.right(), subject.right());
            assert!(cancel.right() <= submit.left());
            assert!(submit.right() < panel.right());
            assert!(error.bottom() <= cancel.top());
            // The checkout follows the branch it is derived from, and the
            // daemon's answer follows whichever one the dialog is about.
            assert!(field.bottom() <= subject.top() || field == subject);
            assert!(subject.bottom() <= error.top());
        }
    }
}
