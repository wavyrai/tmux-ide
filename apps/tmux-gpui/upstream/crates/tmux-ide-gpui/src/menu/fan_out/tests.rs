use super::super::WorkspaceMenuAction;
use super::*;

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod spread;

fn offered(view: &HerdrWindow) -> Option<&'static str> {
    view.workspace_items()
        .into_iter()
        .find(|(action, _)| *action == WorkspaceMenuAction::FanOut)
        .map(|(_, label)| label)
}

#[gpui::test]
fn offered_for_git_workspaces_on_scriptable_hosts(cx: &mut gpui::TestAppContext) {
    let expected =
        cfg!(any(target_os = "linux", target_os = "macos")).then_some("Fan out prompt...");
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
            snapshot.workspaces[0].branch = None;
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert_eq!(offered(view), None, "a custom socket cannot be scripted");
            view.dismiss_menu(window, cx);
            view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
            // A main checkout, and a linked one through its main checkout.
            for workspace in ["w3", "w4"] {
                view.open_workspace_menu(workspace, Default::default(), window, cx);
                assert_eq!(offered(view), expected, "{workspace}");
                view.dismiss_menu(window, cx);
            }
            // A workspace outside Git has nothing to branch.
            view.open_workspace_menu("w0", Default::default(), window, cx);
            assert_eq!(offered(view), None);
            view.dismiss_menu(window, cx);
        })
    });
}

#[gpui::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn composing_picks_agents_and_closing_forgets_it(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
            view.open_workspace_menu("w4", Default::default(), window, cx);
            view.activate_workspace_menu(WorkspaceMenuAction::FanOut, window, cx);
            assert_eq!(view.menu.page, Some(Page::FanOut));
            assert!(view.menu.input.is_some(), "the prompt takes the keyboard");
            let fan_out = view.fan_out.as_mut().unwrap();
            assert_eq!(
                fan_out.base_for_test(),
                "refs/heads/worktree/sidebar-child",
                "a linked checkout's lanes start from its branch, as a full ref"
            );
            // The host lookup is replaced, so nothing depends on this machine.
            fan_out.agents_for_test(vec![
                crate::teleport::AgentKind::Claude,
                crate::teleport::AgentKind::Codex,
            ]);
        })
    });
    cx.run_until_parked();
    let more = cx.debug_bounds("fan-out-more-1").unwrap();
    cx.simulate_click(more.center(), gpui::Modifiers::none());
    cx.simulate_click(more.center(), gpui::Modifiers::none());
    cx.run_until_parked();
    assert!(cx.debug_bounds("fan-out-count-1").is_some());
    assert!(cx.debug_bounds("fan-out-count-0").is_none());
    let less = cx.debug_bounds("fan-out-less-1").unwrap();
    cx.simulate_click(less.center(), gpui::Modifiers::none());
    cx.update(|_, cx| {
        assert_eq!(view.read(cx).fan_out.as_ref().unwrap().picked_for_test(), 1);
    });
    // Enter without a prompt starts nothing.
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        assert!(view.read(cx).fan_out.as_ref().unwrap().composing());
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.poll_fan_out(window, cx));
        assert!(
            view.read(cx).fan_out.is_none(),
            "an unlaunched fan-out is forgotten"
        );
        assert_eq!(view.read(cx).menu.page, None);
    });
}
