use super::*;

#[gpui::test]
fn transient_status_preserves_terminal_geometry_without_resize(cx: &mut TestAppContext) {
    let (sender, receiver) = std::sync::mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|_, cx| browser_fixture(cx, sender));
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(640.), px(400.)));
    view.update(cx, |view, _| {
        view.input_interrupted = false;
        view.developer_mode.enabled = false;
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    super::super::super::fit_test_support::settle(&view, cx, &receiver);
    let canvas = view.read_with(cx, |view, _| view.input_geometry.unwrap().0);
    // The sidebar's list never moves for a notice (#359 review): it floats.
    let sidebar = cx.debug_bounds("tmux-sidebar-viewport").unwrap();
    for (ready, interrupted, status) in [
        (false, false, "Loading selection"),
        (true, true, "Keyboard ready"),
        (true, false, "Copy failed — try again"),
        (true, false, "Keyboard ready"),
        (true, false, "Connected"),
    ] {
        view.update(cx, |view, _| {
            view.browser_state.input_ready = ready;
            view.input_interrupted = interrupted;
            view.browser_state.status = status.into();
        });
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        assert_eq!(
            view.read_with(cx, |view, _| view.input_geometry.unwrap().0),
            canvas
        );
        assert!(
            receiver.try_recv().is_err(),
            "status must not enqueue any command"
        );
        let visible = !ready || interrupted || !matches!(status, "Keyboard ready" | "Connected");
        assert_eq!(cx.debug_bounds("tmux-status-viewport").is_some(), visible);
        assert_eq!(
            cx.debug_bounds("tmux-sidebar-viewport").unwrap(),
            sidebar,
            "{status}: the sidebar moved"
        );
        if visible {
            let status = cx.debug_bounds("tmux-status-viewport").unwrap();
            // Beside the sidebar it sits under the sidebar's top row (#746
            // v3, card 5); either way never over the cells.
            assert!(
                !status.intersects(&canvas),
                "status must not cover terminal cells"
            );
        }
        if ready {
            super::super::super::fit_test_support::settle(&view, cx, &receiver);
        }
    }
}
