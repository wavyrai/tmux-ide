use super::*;

/// Lanes spread over a second host, and one lane is brought back here.
#[gpui::test]
fn lanes_spread_over_hosts_and_one_can_be_moved(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
            let mut remote = crate::endpoint::Endpoint::new(
                "ssh:box".into(),
                "Box".into(),
                herdr_client::ConnectTarget::Ssh {
                    target: "nobody@box.invalid".into(),
                    session: "default".into(),
                },
                true,
            );
            remote.live = view.live.clone();
            view.endpoints.push(remote);
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.activate_workspace_menu(WorkspaceMenuAction::FanOut, window, cx);
            let fan_out = view.fan_out.as_mut().unwrap();
            fan_out.agents_for_test(vec![crate::teleport::AgentKind::Claude]);
            view.poll_dispatch(window, cx);
        })
    });
    cx.run_until_parked();
    let more = cx.debug_bounds("fan-out-more-0").unwrap();
    cx.simulate_click(more.center(), gpui::Modifiers::none());
    cx.simulate_click(more.center(), gpui::Modifiers::none());
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("fan-out-lane-host-0").is_none(),
        "lanes stay here until spread"
    );
    let spread = cx.debug_bounds("fan-out-spread").unwrap();
    cx.simulate_click(spread.center(), gpui::Modifiers::none());
    cx.run_until_parked();
    let lane = cx.debug_bounds("fan-out-lane-host-1").unwrap();
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert!(panel.contains(&lane.origin));
    let before = cx.update(|_, cx| {
        view.read(cx)
            .fan_out
            .as_ref()
            .unwrap()
            .lane_hosts_for_test()
    });
    assert_eq!(before.len(), 2);
    // Unsampled, the hosts tie but for staying put: this one takes the
    // first lane, and Box the second once a lane has cost this one a core.
    assert_eq!(before, ["local", "ssh:box"]);
    let chip = cx.debug_bounds("dispatch-lane-1").unwrap();
    cx.simulate_click(chip.center(), gpui::Modifiers::none());
    cx.run_until_parked();
    let row = cx.debug_bounds("dispatch-row-local").unwrap();
    cx.simulate_click(row.center(), gpui::Modifiers::none());
    cx.run_until_parked();
    cx.update(|_, cx| {
        assert_eq!(
            view.read(cx)
                .fan_out
                .as_ref()
                .unwrap()
                .lane_hosts_for_test(),
            ["local", "local"]
        );
    });
    assert!(
        cx.debug_bounds("dispatch-list").is_none(),
        "choosing closes the list"
    );
}
