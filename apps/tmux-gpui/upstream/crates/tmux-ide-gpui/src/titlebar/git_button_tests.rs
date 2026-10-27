#![allow(clippy::unwrap_used)]
use crate::{
    git::{Git, Status},
    menu::Page,
    pull_request::Input,
    sidebar::layout_tests::REPO_KEY,
};
use gpui::{Modifiers, MouseButton, MouseDownEvent, TestAppContext, px, size};

#[gpui::test]
fn git_button_sits_left_of_the_account_slot_and_opens_its_menu(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::titlebar::tests::header_window);
    let draw = |cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        });
    };
    cx.simulate_resize(size(px(1200.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    assert!(
        cx.debug_bounds("titlebar-git").is_none(),
        "no tracked checkout, no Git control"
    );
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.git = Git::fixture(
                Input {
                    checkout: None,
                    repo_key: Some(REPO_KEY.into()),
                    branch: "develop".into(),
                },
                Status {
                    additions: 239,
                    deletions: 250,
                    untracked: 2,
                },
            );
            cx.notify();
        })
    });
    for width in [1200., 640., 360.] {
        cx.simulate_resize(size(px(width), px(600.)));
        cx.run_until_parked();
        draw(cx);
        let button = cx.debug_bounds("titlebar-git").unwrap();
        let avatar = cx.debug_bounds("titlebar-avatar").unwrap();
        let titlebar = cx.debug_bounds("titlebar").unwrap();
        assert!(
            cx.debug_bounds("titlebar-git-slot").unwrap().left()
                >= cx.debug_bounds("toggle-sidebar").unwrap().right(),
            "width {width}"
        );
        assert!(button.right() <= avatar.left(), "width {width}");
        assert!(button.left() >= titlebar.left());
        assert!(button.top() >= titlebar.top() && button.bottom() <= titlebar.bottom());
        for part in [
            "titlebar-git-additions",
            "titlebar-git-deletions",
            "titlebar-git-dirty",
        ] {
            let bounds = cx.debug_bounds(part).unwrap();
            assert!(bounds.right() <= button.left(), "{part} at width {width}");
        }
        cx.simulate_event(MouseDownEvent {
            button: MouseButton::Left,
            position: button.center(),
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        });
        cx.update(|_, cx| assert_eq!(view.read(cx).menu.page, Some(Page::Git)));
        draw(cx);
        for row in [
            "git-menu-Commit...",
            "git-menu-Push",
            "git-menu-Create pull request",
        ] {
            assert!(cx.debug_bounds(row).is_some(), "{row} at width {width}");
        }
        assert!(cx.debug_bounds("git-menu-summary").is_some());
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.dismiss_menu(window, cx);
                cx.notify();
            })
        });
    }
}

#[gpui::test]
fn uncommitted_changes_hide_zero_counts(cx: &mut TestAppContext) {
    for (additions, deletions, untracked) in [(0, 0, 1), (12, 0, 0), (0, 3, 0), (433, 28, 1)] {
        let (view, cx) = cx.add_window_view(crate::titlebar::tests::header_window);
        cx.simulate_resize(size(px(360.), px(600.)));
        cx.update(|_, cx| {
            view.update(cx, |view, cx| {
                view.git = Git::fixture(
                    Input {
                        checkout: None,
                        repo_key: Some(REPO_KEY.into()),
                        branch: "develop".into(),
                    },
                    Status {
                        additions,
                        deletions,
                        untracked,
                    },
                );
                cx.notify();
            });
        });
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        });
        assert_eq!(
            cx.debug_bounds("titlebar-git-additions").is_some(),
            additions > 0
        );
        assert_eq!(
            cx.debug_bounds("titlebar-git-deletions").is_some(),
            deletions > 0
        );
        let dirty = cx.debug_bounds("titlebar-git-dirty").unwrap();
        assert_eq!(dirty.size, size(px(18.), px(18.)));
        let button = cx.debug_bounds("titlebar-git").unwrap();
        assert!(dirty.right() <= button.left());
        assert!(button.left() >= cx.debug_bounds("titlebar").unwrap().left());
        assert!(button.right() <= cx.debug_bounds("titlebar-avatar").unwrap().left());
    }
}

#[gpui::test]
fn a_clean_checkout_shows_no_counts(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::titlebar::tests::header_window);
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.git = Git::fixture(
                Input {
                    checkout: None,
                    repo_key: Some(REPO_KEY.into()),
                    branch: "develop".into(),
                },
                Status::default(),
            );
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    assert!(cx.debug_bounds("titlebar-git").is_some());
    assert!(cx.debug_bounds("titlebar-git-additions").is_none());
    assert!(cx.debug_bounds("titlebar-git-dirty").is_none());
    assert!(
        cx.debug_bounds("titlebar-git-pr").is_none(),
        "no cached pull request, no badge"
    );
}

#[gpui::test]
fn a_cached_pull_request_replaces_the_uncommitted_counts(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::titlebar::tests::header_window);
    let input = Input {
        checkout: None,
        repo_key: Some(REPO_KEY.into()),
        branch: "develop".into(),
    };
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.git = Git::fixture(
                input.clone(),
                Status {
                    additions: 12,
                    deletions: 3,
                    untracked: 0,
                },
            );
            view.menu.github = crate::github::Auth::connected_fixture();
            view.menu.pr_cache.seed(
                input,
                crate::pull_request::fixture().unwrap(),
                std::time::Instant::now(),
            );
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    let button = cx.debug_bounds("titlebar-git").unwrap();
    let number = cx.debug_bounds("titlebar-git-pr").unwrap();
    let churn = cx.debug_bounds("titlebar-git-pr-lines").unwrap();
    let dirty = cx.debug_bounds("titlebar-git-dirty").unwrap();
    assert_eq!(dirty.size, size(px(18.), px(18.)));
    // One set of counts only: the pull request's, then a dot for the work
    // still sitting in the checkout. Two "+N -M" pairs never sit together.
    assert!(
        cx.debug_bounds("titlebar-git-additions").is_none(),
        "uncommitted counts give way to the pull request's"
    );
    assert!(number.right() <= churn.left());
    assert!(churn.right() <= dirty.left());
    assert!(dirty.right() <= button.left());
    assert!(button.right() <= cx.debug_bounds("titlebar-avatar").unwrap().left());
    // Additions and deletions are separate spans so each keeps its own
    // color, as the sidebar badge paints them.
    let additions = cx.debug_bounds("titlebar-git-pr-additions").unwrap();
    let deletions = cx.debug_bounds("titlebar-git-pr-deletions").unwrap();
    assert!(churn.left() <= additions.left() && additions.right() <= deletions.left());
    assert!(deletions.right() <= churn.right());
    for width in [900., 360.] {
        cx.simulate_resize(size(px(width), px(600.)));
        cx.update(|window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        });
        let number = cx.debug_bounds("titlebar-git-pr").unwrap();
        let churn = cx.debug_bounds("titlebar-git-pr-lines").unwrap();
        let button = cx.debug_bounds("titlebar-git").unwrap();
        assert!(number.left() >= cx.debug_bounds("toggle-sidebar").unwrap().right());
        assert!(number.right() <= churn.left());
        assert!(churn.right() <= button.left());
        for selector in [
            "titlebar-git-pr",
            "titlebar-git-pr-additions",
            "titlebar-git-pr-deletions",
            "titlebar-git-pr-link",
        ] {
            cx.update(|_, cx| cx.open_url("https://example.com"));
            let target = cx.debug_bounds(selector).unwrap();
            cx.simulate_click(target.center(), Modifiers::default());
            assert_eq!(
                cx.opened_url(),
                Some(crate::pull_request::fixture().unwrap().url),
                "{selector} should open the PR"
            );
            cx.update(|_, cx| assert_eq!(view.read(cx).menu.page, None));
        }
        cx.simulate_click(button.center(), Modifiers::default());
        cx.update(|_, cx| assert_eq!(view.read(cx).menu.page, Some(Page::Git)));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| view.dismiss_menu(window, cx));
        });
    }
}

#[gpui::test]
fn a_clean_checkout_with_a_pull_request_shows_no_dot(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::titlebar::tests::header_window);
    let input = Input {
        checkout: None,
        repo_key: Some(REPO_KEY.into()),
        branch: "develop".into(),
    };
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.git = Git::fixture(input.clone(), Status::default());
            view.menu.github = crate::github::Auth::connected_fixture();
            view.menu.pr_cache.seed(
                input,
                crate::pull_request::fixture().unwrap(),
                std::time::Instant::now(),
            );
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    assert!(cx.debug_bounds("titlebar-git-pr-lines").is_some());
    assert!(cx.debug_bounds("titlebar-git-dirty").is_none());
}
