#![allow(clippy::unwrap_used)]
use super::Action;
use gpui::TestAppContext;

#[gpui::test]
fn successful_signin_dismisses_only_the_signin_panel_and_restores_focus(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.github_fixture(false, window, cx);
            view.menu
                .github
                .complete_profile_fixture(Ok(crate::github::Auth::connected_fixture().profile));
            view.poll_github(window, cx);
            assert!(view.menu.github.connected());
            assert!(view.menu.page.is_none());
            assert!(view.focus.is_focused(window));

            // Reopening the account panel and renewing an active session
            // must not dismiss a panel the user deliberately opened.
            view.open_menu(window, cx);
            view.menu.page = Some(crate::menu::Page::GitHub);
            view.menu
                .github
                .complete_profile_fixture(Ok(crate::github::Auth::connected_fixture().profile));
            view.poll_github(window, cx);
            assert!(view.menu.page == Some(crate::menu::Page::GitHub));

            view.menu.github = crate::github::Auth::default();
            view.menu.page = Some(crate::menu::Page::Menu);
            view.menu
                .github
                .complete_profile_fixture(Ok(crate::github::Auth::connected_fixture().profile));
            view.poll_github(window, cx);
            assert!(view.menu.page == Some(crate::menu::Page::Menu));

            view.github_fixture(false, window, cx);
            view.menu
                .github
                .complete_profile_fixture(Err(crate::Error::GitHubAuthentication));
            view.poll_github(window, cx);
            assert!(view.menu.page == Some(crate::menu::Page::GitHub));
            assert!(!view.menu.github.connected());
        });
    });
}

const HOST: &str = "ssh:0123456789abcdef0123456789abcdef";

/// Adds a saved SSH device, selects it, and gives it its own account slot.
fn select_host(view: &mut crate::HerdrWindow, host: crate::github::Auth) {
    view.endpoints.push(crate::endpoint::Endpoint::new(
        HOST.into(),
        "Work box".into(),
        herdr_client::ConnectTarget::Ssh {
            target: "me@work".into(),
            session: "default".into(),
        },
        true,
    ));
    view.selected_endpoint = 1;
    view.menu.github_hosts.insert(HOST.into(), host);
}

fn login(profile: Option<&crate::github::Profile>) -> Option<&str> {
    profile.map(|profile| profile.login.as_str())
}

#[gpui::test]
fn a_host_uses_its_own_account_and_falls_back_to_the_main_one(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.menu.github = crate::github::Auth::connected_fixture();
            select_host(view, crate::github::Auth::default());
            // Without its own sign-in, the host reads PRs as the main account
            // while the page offers a separate one for this device.
            assert!(!view.github_auth().connected());
            assert_eq!(login(view.pr_profile()), Some("fixture-user"));
            assert_eq!(
                view.pr_origin(),
                Some(crate::pull_request::Origin::Ssh("me@work".into()))
            );
            view.open_menu(window, cx);
            view.menu.page = Some(crate::menu::Page::GitHub);
            assert!(view.github_actions().contains(&Action::Start));

            let mut work = crate::github::Auth::connected_fixture();
            work.profile.as_mut().unwrap().login = "work-user".into();
            view.menu.github_hosts.insert(HOST.into(), work);
            assert_eq!(login(view.pr_profile()), Some("work-user"));

            // Signing out on the host's page leaves the main account alone.
            view.github_action(Action::SignOut, window, cx);
            assert!(!view.menu.github_hosts[HOST].connected());
            assert!(view.menu.github.connected());
            assert_eq!(login(view.pr_profile()), Some("fixture-user"));

            // Back on Local, the page and lookups use the main account.
            view.selected_endpoint = 0;
            assert!(std::ptr::eq(view.github_auth(), &view.menu.github));
        });
    });
}

#[gpui::test]
fn host_note_names_the_account_pull_requests_use(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.github_fixture(false, window, cx);
            view.menu.github = crate::github::Auth::connected_fixture();
        });
        crate::sidebar::layout_tests::full_draw(window, cx).clear(cx);
    });
    assert!(cx.debug_bounds("github-host-note").is_none());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            select_host(view, crate::github::Auth::default());
            cx.notify();
        });
        crate::sidebar::layout_tests::full_draw(window, cx).clear(cx);
    });
    assert!(cx.debug_bounds("github-host-note").is_some());
}

#[gpui::test]
fn removed_hosts_drop_their_account_from_memory(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            select_host(view, crate::github::Auth::connected_fixture());
            view.sync_github_hosts();
            assert!(view.menu.github_hosts.contains_key(HOST));
            view.selected_endpoint = 0;
            view.endpoints.truncate(1);
            view.sync_github_hosts();
            assert!(view.menu.github_hosts.is_empty());
        });
    });
}

#[gpui::test]
fn signout_uses_the_theme_danger_color(cx: &mut TestAppContext) {
    use gpui::Styled;
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let mut button = view.github_button(Action::SignOut, "Sign out", cx);
            assert_eq!(
                button.text_style().color,
                Some(crate::menu::danger(&view.theme).into())
            );
        })
    });
}

#[gpui::test]
fn connected_panel_is_content_sized_with_only_header_close(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    for (width, height) in [(320., 400.), (640., 780.), (1200., 1000.)] {
        cx.simulate_resize(gpui::size(gpui::px(width), gpui::px(height)));
        cx.update(|window, cx| {
            cx.default_global::<crate::sidebar::layout_tests::PaintedProbes>()
                .0
                .clear();
            view.update(cx, |view, cx| {
                view.github_fixture(false, window, cx);
                view.menu.github = crate::github::Auth::connected_fixture();
            });
            window.draw(cx).clear(cx);
        });
        let panel = cx.debug_bounds("menu-panel").unwrap();
        assert!(panel.size.width <= gpui::px(400.));
        assert!(panel.size.height <= gpui::px(230.));
        assert!(cx.debug_bounds("github-status").is_none());
        assert!(cx.debug_bounds("github-close").is_none());
        assert!(cx.debug_bounds("github-header-close").is_some());
        // The mark is vector, so it is sharp at the header's own size, and
        // the avatar slot beside it stays square for a round crop.
        let mark = cx.debug_bounds("github-mark").unwrap();
        let avatar = cx.debug_bounds("github-avatar").unwrap();
        assert_eq!(mark.size, gpui::size(gpui::px(28.), gpui::px(28.)));
        assert_eq!(avatar.size, gpui::size(gpui::px(40.), gpui::px(40.)));
        cx.simulate_keystrokes("tab tab enter");
        cx.update(|window, cx| {
            assert!(view.read(cx).menu.page.is_none());
            assert!(view.read(cx).menu.github.connected());
            assert!(view.read(cx).focus.is_focused(window));
            cx.default_global::<crate::sidebar::layout_tests::PaintedProbes>()
                .check()
                .unwrap();
        });
    }
}

#[gpui::test]
fn actions_follow_state_and_focus_cannot_become_signout(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.github_fixture(false, window, cx));
    });
    cx.simulate_keystrokes("d o cmd-c");
    assert!(cx.opened_url().is_none());
    cx.update(|_, cx| {
        assert!(!view.read(cx).menu.github.busy());
        assert!(cx.read_from_clipboard().is_none());
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.github_fixture(true, window, cx));
    });
    cx.simulate_keystrokes("tab tab");
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            assert!(view.menu.github_selected == Some(Action::Open));
            view.menu.github = crate::github::Auth::connected_fixture();
            cx.notify();
        });
    });
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| assert!(view.read(cx).menu.github.connected()));
    assert!(cx.opened_url().is_none());
    cx.simulate_keystrokes("d");
    cx.update(|_, cx| {
        assert!(!view.read(cx).menu.github.connected());
        assert!(view.read(cx).menu.github.busy());
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| assert!(view.read(cx).focus.is_focused(window)));
}
