use super::*;

#[gpui::test]
fn fleet_hierarchy_keeps_long_labels_and_statuses_separate(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../evidence/home-fleet-2026-10-15/fleet.json"
            ))
            .unwrap(),
        );
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    receiver.try_iter().for_each(drop);
    for width in [1000., 640.] {
        cx.simulate_resize(size(px(width), px(1800.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        for (label, status, owner) in [
            (
                "fleet-machine-label-0",
                "fleet-machine-status-0",
                "fleet-machine-header-0",
            ),
            (
                "fleet-server-label-0-0",
                "fleet-server-status-0-0",
                "fleet-server-0-0",
            ),
            (
                "fleet-session-label-0-0",
                "fleet-session-status-0-0",
                "fleet-session-0-0",
            ),
            (
                "fleet-session-label-0-1",
                "fleet-session-status-0-1",
                "fleet-session-0-1",
            ),
        ] {
            let label = cx.debug_bounds(label).unwrap();
            let status = cx.debug_bounds(status).unwrap();
            let owner = cx.debug_bounds(owner).unwrap();
            assert!(label.size.width > px(0.), "label has no space at {width}");
            assert!(label.right() <= status.left(), "overlap at {width}");
            assert!(
                status.right() <= owner.right(),
                "status overflow at {width}"
            );
        }
        let server = cx.debug_bounds("fleet-server-0-0").unwrap();
        let machine = cx.debug_bounds("fleet-machine-header-0").unwrap();
        assert!(server.left() > machine.left());
        let retry = cx.debug_bounds("fleet-retry-1").unwrap();
        assert_eq!(retry.size.height, px(32.));
        assert!(retry.size.width < px(250.));
    }
    let retry = cx.debug_bounds("fleet-retry-1").unwrap();
    cx.simulate_click(retry.center(), Modifiers::default());
    let expected = view.read_with(cx, |v, _| {
        v.browser_state.fleet.as_ref().unwrap().groups[1]
            .retry
            .clone()
            .unwrap()
    });
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::FleetRetry { request: 7, retry } if retry == expected)
    );
    assert!(receiver.try_recv().is_err());
}
