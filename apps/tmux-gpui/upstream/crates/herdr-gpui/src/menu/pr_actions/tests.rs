#![allow(clippy::unwrap_used)]
use super::super::{Page, git::Row};
use crate::{pr_actions::Action, pull_request::MergeMethod, sidebar::layout_tests::REPO_KEY};
use gpui::{Entity, TestAppContext, VisualTestContext, point, px, size};

fn input() -> crate::pull_request::Input {
    crate::pull_request::Input {
        checkout: None,
        repo_key: Some(REPO_KEY.into()),
        branch: "develop".into(),
    }
}

/// A focused checkout with an open PR in the cache, tracked for actions,
/// and no worker: nothing here reaches GitHub.
fn open(
    cx: &mut TestAppContext,
    pr: crate::pull_request::PullRequest,
) -> (Entity<crate::HerdrWindow>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.git = crate::git::Git::fixture(input(), Default::default());
            view.menu.github = crate::github::Auth::connected_fixture();
            view.menu
                .pr_cache
                .seed(input(), pr, std::time::Instant::now());
            view.pr_actions.track(
                view.git_open_pull_request()
                    .and_then(|pr| crate::pr_actions::Target::try_from(pr).ok()),
            );
            view.open_git_menu(point(px(860.), px(20.)), window, cx);
        })
    });
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
}

fn labels(view: &crate::HerdrWindow) -> Vec<String> {
    view.git_rows()
        .into_iter()
        .map(|(_, label)| label)
        .collect()
}

#[gpui::test]
fn an_open_pull_request_offers_review_comment_and_merge(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, crate::pull_request::fixture().unwrap());
    cx.update(|_, cx| {
        assert_eq!(
            labels(view.read(cx)),
            [
                "Commit...",
                "Push",
                "Open pull request #8",
                "Checks and comments",
                "Comment...",
                "Merge..."
            ]
        );
    });
    // A draft cannot be merged; a repository allowing nothing offers nothing.
    for change in [
        |pr: &mut crate::pull_request::PullRequest| pr.is_draft = true,
        |pr: &mut crate::pull_request::PullRequest| pr.merge_methods.clear(),
    ] {
        let mut pr = crate::pull_request::fixture().unwrap();
        change(&mut pr);
        cx.update(|_, cx| {
            view.update(cx, |view, _| {
                view.menu
                    .pr_cache
                    .seed(input(), pr, std::time::Instant::now());
                let labels = labels(view);
                assert!(labels.contains(&"Comment...".to_owned()));
                assert!(!labels.contains(&"Merge...".to_owned()));
            })
        });
    }
    // A PR without its node identity cannot be acted on at all.
    let mut pr = crate::pull_request::fixture().unwrap();
    pr.id.clear();
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.menu
                .pr_cache
                .seed(input(), pr, std::time::Instant::now());
            view.update_pr_actions(std::time::Instant::now());
            // Commit, push, and opening the pull request.
            assert_eq!(labels(view).len(), 3);
        })
    });
}

#[gpui::test]
fn merging_takes_a_method_and_an_explicit_confirmation(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, crate::pull_request::fixture().unwrap());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.activate_git_row(Row::Merge, window, cx);
            assert_eq!(view.menu.page, Some(Page::PrMerge));
            assert_eq!(view.menu.merge_method, Some(MergeMethod::Merge));
            assert!(
                view.pr_actions.running().is_none(),
                "opening the dialog sends nothing"
            );
        })
    });
    draw(cx);
    let confirm = cx.debug_bounds("pr-merge-confirm").unwrap();
    let rebase = cx.debug_bounds("pr-merge-method-REBASE").unwrap();
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert!(rebase.bottom() <= confirm.top());
    assert!(confirm.right() <= panel.right() && confirm.bottom() <= panel.bottom());
    cx.simulate_keystrokes("down");
    cx.update(|_, cx| {
        assert_eq!(view.read(cx).menu.merge_method, Some(MergeMethod::Squash));
    });
    cx.simulate_click(rebase.center(), Default::default());
    cx.update(|_, cx| {
        assert_eq!(view.read(cx).menu.merge_method, Some(MergeMethod::Rebase));
        assert!(view.read(cx).pr_actions.running().is_none());
    });
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(
            view.pr_actions.running(),
            Some(&Action::Merge(MergeMethod::Rebase))
        );
        assert_eq!(view.menu.page, Some(Page::Git));
    });
    draw(cx);
    assert!(cx.debug_bounds("pr-action-running").is_some());
    // Nothing else starts while the merge runs.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.activate_git_row(Row::Comment, window, cx);
            assert_eq!(view.menu.page, Some(Page::Git));
        })
    });
}

#[gpui::test]
fn a_branch_that_moved_after_the_dialog_opened_is_not_merged(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, crate::pull_request::fixture().unwrap());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.activate_git_row(Row::Merge, window, cx);
            let mut pushed = crate::pull_request::fixture().unwrap();
            pushed.head_ref_oid = "f".repeat(40);
            view.menu
                .pr_cache
                .seed(input(), pushed, std::time::Instant::now());
            view.update_pr_actions(std::time::Instant::now());
            view.submit_pr_merge(cx);
            assert!(view.pr_actions.running().is_none());
            assert_eq!(view.menu.page, Some(Page::PrMerge));
            assert_eq!(
                view.menu.error.as_deref(),
                Some(crate::Error::PrMergeChanged.to_string().as_str())
            );
        })
    });
}

#[gpui::test]
fn commenting_refuses_an_empty_body_and_queues_a_written_one(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, crate::pull_request::fixture().unwrap());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.activate_git_row(Row::Comment, window, cx);
            assert_eq!(view.menu.page, Some(Page::PrComment));
            view.submit_pr_comment(cx);
            assert_eq!(
                view.menu.error.as_deref(),
                Some(crate::Error::PrCommentBody.to_string().as_str())
            );
            assert!(view.pr_actions.running().is_none());
            if let Some(dialog) = view.menu.input.as_mut() {
                dialog.text = "Thanks, merging after CI".into();
            }
            cx.notify();
        })
    });
    draw(cx);
    let field = cx.debug_bounds("dialog-input").unwrap();
    let submit = cx.debug_bounds("pr-comment-submit").unwrap();
    assert!(field.bottom() <= submit.top());
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(
            view.pr_actions.running(),
            Some(&Action::Comment("Thanks, merging after CI".into()))
        );
        assert_eq!(view.menu.page, Some(Page::Git));
        assert!(view.menu.input.is_none());
    });
}

#[gpui::test]
fn the_review_page_lists_each_check_within_the_window(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, crate::pull_request::fixture().unwrap());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.activate_git_row(Row::Review, window, cx);
            assert_eq!(view.menu.page, Some(Page::PrReview));
            assert!(view.pr_actions.loading(), "opening it asks for comments");
        })
    });
    for (width, height) in [(900., 700.), (360., 420.)] {
        cx.simulate_resize(size(px(width), px(height)));
        draw(cx);
        let panel = cx.debug_bounds("menu-panel").unwrap();
        assert!(panel.left() >= px(0.) && panel.right() <= px(width));
        assert!(panel.bottom() <= px(height));
        assert!(cx.debug_bounds("pr-review-check").is_some());
        assert!(cx.debug_bounds("pr-review-loading").is_some());
        let back = cx.debug_bounds("pr-dialog-back").unwrap();
        assert!(back.bottom() <= panel.bottom(), "{back:?} {panel:?}");
    }
    let checks: Vec<_> = cx.update(|_, cx| {
        view.read(cx)
            .git_open_pull_request()
            .unwrap()
            .check_list()
            .map(|(name, outcome)| format!("{name} {outcome}"))
            .collect()
    });
    assert_eq!(checks, ["test passed", "ci/lint failed", "build pending"]);
}
