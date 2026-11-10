use super::*;

#[gpui::test]
fn fleet_hierarchy_keeps_long_labels_and_statuses_separate(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
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
            // A connected machine's line says nothing more; a disconnected
            // one keeps its status (#705).
            (
                "fleet-machine-label-1",
                "fleet-machine-status-1",
                "fleet-machine-header-1",
            ),
            (
                "fleet-server-label-0-0",
                "fleet-use-server-0-0",
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
        // Servers sit in from their machine, inside the machine's one card.
        let server = cx.debug_bounds("fleet-server-label-0-0").unwrap();
        let machine = cx.debug_bounds("fleet-machine-header-0").unwrap();
        assert!(
            server.left() >= machine.left() + px(crate::tmux_snapshot::home::fleet::ROW_INDENT)
        );
        let card = cx.debug_bounds("fleet-machine-0").unwrap();
        let row = cx.debug_bounds("fleet-server-0-0").unwrap();
        assert!(row.left() >= card.left() && row.right() <= card.right());
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

/// #746 v3 (card 10): the toolbar's search is a 260 × 28 pt field, a filter
/// is a 26 pt capsule, a machine's header is 34 pt, and its actions are
/// small text, not 32 pt buttons. Retry, a recovery, stays a button.
#[gpui::test]
fn home_toolbar_filters_and_machine_headers_take_v3_sizes(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
            ))
            .unwrap(),
        );
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(1200.), px(1800.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let browse = cx.debug_bounds("home-browse").unwrap();
    assert_eq!(browse.size, size(px(260.), px(28.)));
    for key in ["home-nav-all", "home-nav-machine-0"] {
        assert_eq!(cx.debug_bounds(key).unwrap().size.height, px(26.), "{key}");
    }
    let header = cx.debug_bounds("fleet-machine-header-0").unwrap();
    assert_eq!(header.size.height, px(34.));
    let disconnect = cx.debug_bounds("fleet-disconnect-0").unwrap();
    assert!(header.contains(&disconnect.center()));
    // Small text in a 24 pt hit box, not a 32 pt button (#359 review).
    assert_eq!(disconnect.size.height, px(24.), "{disconnect:?}");
    assert_eq!(
        cx.debug_bounds("fleet-retry-1").unwrap().size.height,
        px(32.)
    );
}
