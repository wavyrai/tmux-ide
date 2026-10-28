#![allow(clippy::unwrap_used)]
use super::{Page, PrState, Row, summary};
use crate::git::Status;
use crate::sidebar::layout_tests::REPO_KEY;
use gpui::{TestAppContext, VisualTestContext, point, px, size};
use std::sync::Arc;

fn status(additions: u64, deletions: u64, untracked: u64) -> Status {
    Status {
        additions,
        deletions,
        untracked,
    }
}

#[test]
fn summary_reads_as_a_sentence_before_and_after_the_first_refresh() {
    assert_eq!(summary(None), "Checking working tree...");
    assert_eq!(summary(Some(Status::default())), "No uncommitted changes");
    assert_eq!(summary(Some(status(12, 3, 0))), "+12 -3");
    assert_eq!(summary(Some(status(12, 3, 1))), "+12 -3, 1 untracked entry");
    assert_eq!(summary(Some(status(0, 0, 4))), "+0 -0, 4 untracked entries");
}

#[gpui::test]
fn only_a_local_daemon_checkout_is_tracked(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            assert!(view.git_input().is_none(), "no connection, no checkout");
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.live.local_daemon_peer = true;
            let mut snapshot = crate::sidebar::layout_tests::snapshot(6);
            snapshot.focused_workspace_id = Some("w3".into());
            view.live.snapshot = Some(Arc::new(snapshot));
            let input = view.git_input().unwrap();
            assert_eq!(input.repo_key.as_deref(), Some(REPO_KEY));
            assert_eq!(input.branch, "develop");
            assert_eq!(input.checkout, None, "the checkout is resolved by Git");
            // A workspace without worktree metadata cannot be acted on.
            if let Some(snapshot) = view.live.snapshot.as_ref().map(Arc::clone) {
                let mut snapshot = (*snapshot).clone();
                snapshot.focused_workspace_id = Some("w0".into());
                view.live.snapshot = Some(Arc::new(snapshot));
            }
            assert!(view.git_input().is_none());
            if let Some(snapshot) = view.live.snapshot.as_ref().map(Arc::clone) {
                let mut snapshot = (*snapshot).clone();
                snapshot.focused_workspace_id = Some("w3".into());
                view.live.snapshot = Some(Arc::new(snapshot));
            }
            assert!(view.git_input().is_some());
            view.live.local_daemon_peer = false;
            assert!(view.git_input().is_none(), "remote peers run no local Git");
            view.live.local_daemon_peer = true;
            view.selected_endpoint = 0;
            view.live.status = crate::state::ConnectionStatus::Disconnected;
            assert!(view.git_input().is_none());
        })
    });
}

#[gpui::test]
fn a_cached_pull_request_is_named_and_only_an_open_one_can_be_opened(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let input = crate::pull_request::Input {
        checkout: None,
        repo_key: Some(REPO_KEY.into()),
        branch: "develop".into(),
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.git = crate::git::Git::fixture(input.clone(), status(146, 42, 0));
            assert!(
                view.git_pull_request().is_none(),
                "a signed-out client shows no pull request"
            );
            view.menu.github = crate::github::Auth::connected_fixture();
            let pr = crate::pull_request::fixture().unwrap();
            view.menu
                .pr_cache
                .seed(input.clone(), pr, std::time::Instant::now());
            assert_eq!(view.git_pull_request().map(|pr| pr.number), Some(8));
            assert_eq!(
                view.git_rows().last().map(|(_, label)| label.clone()),
                Some("Open pull request #8".into())
            );
            view.open_git_menu(point(px(900.), px(20.)), window, cx);
        })
    });
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    assert!(cx.debug_bounds("git-menu-pr").is_some());
    for (width, height) in [(1200., 600.), (360., 600.), (360., 400.)] {
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        });
        let panel = cx.debug_bounds("menu-panel").unwrap();
        let chrome = crate::titlebar::HEIGHT
            + crate::worktree_banner::reserved(env!("HERDR_BUILD_WORKTREE") == "1");
        assert!(panel.top() >= px(chrome + 6.));
        assert!(panel.bottom() <= px(height - 12.));
        assert!(panel.left() >= px(12.) && panel.right() <= px(width - 12.));
        for selector in [
            "git-menu-pr-title",
            "git-menu-pr-readiness",
            "git-menu-pr-review",
            "git-menu-pr-merge",
            "git-menu-pr-checks",
        ] {
            let row = cx.debug_bounds(selector).unwrap();
            assert!(row.size.height > px(0.));
            assert!(row.left() >= panel.left() && row.right() <= panel.right());
            assert!(row.top() >= panel.top() && row.bottom() <= panel.bottom());
        }
        let title = cx.debug_bounds("git-menu-pr-title").unwrap();
        let identity = cx.debug_bounds("git-menu-pr").unwrap();
        let summary = cx.debug_bounds("git-menu-summary").unwrap();
        let action = cx.debug_bounds("git-menu-Commit...").unwrap();
        assert!(title.bottom() <= identity.top());
        assert!(identity.bottom() <= summary.top());
        assert!(summary.bottom() <= cx.debug_bounds("git-menu-pr-readiness").unwrap().top());
        let pr_counts = cx.debug_bounds("git-menu-pr-counts").unwrap();
        let additions = cx.debug_bounds("git-menu-uncommitted-additions").unwrap();
        let deletions = cx.debug_bounds("git-menu-uncommitted-deletions").unwrap();
        assert_eq!(pr_counts.right(), deletions.right());
        assert!(additions.right() < deletions.left());
        assert!(additions.top() >= summary.top() && additions.bottom() <= summary.bottom());
        assert!(summary.bottom() <= action.top());
    }
    let title = cx.debug_bounds("git-menu-pr-title").unwrap();
    cx.simulate_click(title.center(), Default::default());
    assert_eq!(
        cx.opened_url(),
        Some(crate::pull_request::fixture().unwrap().url)
    );
    cx.update(|_, cx| assert_eq!(view.read(cx).menu.page, None));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.dismiss_menu(window, cx);
            // A merged pull request still names the branch's history, but
            // the next action is creating another one.
            let mut merged = crate::pull_request::fixture().unwrap();
            merged.state = PrState::Merged;
            view.menu
                .pr_cache
                .seed(input, merged, std::time::Instant::now());
            assert_eq!(view.git_pull_request().map(|pr| pr.number), Some(8));
            assert_eq!(
                view.git_rows().last().map(|(_, label)| label.clone()),
                Some("Create pull request".into())
            );
            cx.notify();
        })
    });
}

#[gpui::test]
fn the_popup_says_when_it_is_waiting_on_github(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let input = crate::pull_request::Input {
        checkout: None,
        repo_key: Some(REPO_KEY.into()),
        branch: "develop".into(),
    };
    let draw = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        })
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.git = crate::git::Git::fixture(input.clone(), status(0, 0, 0));
            view.menu.github = crate::github::Auth::connected_fixture();
            view.menu.pr_cache.scope(
                (0, 1, "boot".into()),
                Arc::new("fixture".into()),
                crate::pull_request::Origin::Local,
            );
            view.menu
                .pr_cache
                .refresh(input.clone(), std::time::Instant::now());
            view.open_git_menu(point(px(900.), px(20.)), window, cx);
        })
    });
    draw(cx);
    let loading = cx.debug_bounds("git-menu-pr-loading").unwrap();
    assert!(loading.bottom() <= cx.debug_bounds("git-menu-summary").unwrap().top());
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            // The lookup finished: nothing queued, the answer cached.
            view.menu.pr_cache.retain(|_| false);
            let pr = crate::pull_request::fixture().unwrap();
            view.menu
                .pr_cache
                .seed(input, pr, std::time::Instant::now());
            cx.notify();
        })
    });
    draw(cx);
    assert!(cx.debug_bounds("git-menu-pr-loading").is_none());
    assert!(cx.debug_bounds("git-menu-pr").is_some());
}

#[gpui::test]
fn the_commit_dialog_ends_in_a_button_row(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.git = crate::git::Git::fixture(
                crate::pull_request::Input {
                    checkout: None,
                    repo_key: Some(REPO_KEY.into()),
                    branch: "develop".into(),
                },
                status(12, 3, 1),
            );
            view.open_git_menu(point(px(860.), px(20.)), window, cx);
            view.activate_git_row(Row::Commit, window, cx);
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    let cancel = cx.debug_bounds("git-commit-cancel").unwrap();
    let commit = cx.debug_bounds("git-commit-submit").unwrap();
    let field = cx.debug_bounds("dialog-input").unwrap();
    // The workspace dialogs' chrome: what will be staged, then the message
    // field, then the actions.
    let staged = cx.debug_bounds("git-commit-summary").unwrap();
    assert!(staged.bottom() <= field.top());
    // Two real buttons, not bare text: padded boxes on one row, the
    // default action last, under the message field.
    assert_eq!(cancel.size.height, commit.size.height);
    assert!(cancel.size.height >= px(24.));
    assert!(cancel.size.width >= px(50.) && commit.size.width >= px(50.));
    assert_eq!(cancel.top(), commit.top());
    assert!(cancel.right() <= commit.left());
    assert!(field.bottom() <= cancel.top());
}

#[gpui::test]
fn the_menu_commits_through_a_dialog_and_refuses_an_empty_message(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let input = crate::pull_request::Input {
        checkout: None,
        repo_key: Some(REPO_KEY.into()),
        branch: "develop".into(),
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.git = crate::git::Git::fixture(input.clone(), status(12, 3, 1));
            view.open_git_menu(point(px(900.), px(20.)), window, cx);
            assert_eq!(view.menu.page, Some(Page::Git));
            let rows: Vec<_> = view
                .git_rows()
                .into_iter()
                .map(|(_, label)| label)
                .collect();
            assert_eq!(rows, ["Commit...", "Push", "Create pull request"]);
            view.activate_git_row(Row::Commit, window, cx);
            assert_eq!(view.menu.page, Some(Page::GitCommit));
            assert!(view.menu.input.is_some(), "the dialog opens with a field");
            view.submit_git_commit(cx);
            assert_eq!(
                view.menu.error.as_deref(),
                Some(crate::Error::GitCommitMessage.to_string().as_str())
            );
            assert_eq!(
                view.menu.page,
                Some(Page::GitCommit),
                "the dialog stays open"
            );
            assert!(view.git.running().is_none());
            if let Some(dialog) = view.menu.input.as_mut() {
                dialog.text = "fix: keep the popup open".into();
            }
            view.submit_git_commit(cx);
            assert_eq!(view.menu.error, None);
            assert_eq!(view.menu.page, Some(Page::Git));
            assert!(matches!(
                view.git.running(),
                Some(crate::git::Action::Commit(message)) if message == "fix: keep the popup open"
            ));
            // A second action cannot start while the first is running.
            view.activate_git_row(Row::Push, window, cx);
            assert!(matches!(
                view.git.running(),
                Some(crate::git::Action::Commit(_))
            ));
            view.dismiss_menu(window, cx);
            assert_eq!(view.menu.page, None);
            assert!(
                view.git.running().is_some(),
                "dismissing the popup does not cancel queued work"
            );
        })
    });
}
