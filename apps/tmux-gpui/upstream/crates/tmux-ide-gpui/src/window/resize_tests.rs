use super::HerdrWindow;
use herdr_client::ConnectTarget;
use herdr_client::protocol::{FrameData, PaneSurfaceFrame};
use std::sync::Arc;

#[gpui::test]
fn resize_tracks_cell_metrics_and_retries_failed_options(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        HerdrWindow::new(
            ConnectTarget::Socket("/unused-resize-test.sock".into()),
            window,
            cx,
            true,
        )
    });
    view.update(cx, |view, _| {
        let client = herdr_client::connect(
            view.endpoints[view.selected_endpoint]
                .connection
                .target
                .clone(),
            view.options,
        )
        .unwrap_or_else(|error| panic!("cannot create test client: {error}"));
        client.handle.disconnect();
        view.endpoints[view.selected_endpoint].connection.handle = Some(client.handle);
        let queued = view.options;
        view.last_queued_options = Some(queued);
        view.resize();
        assert!(
            view.local_error.is_none(),
            "identical options are not resent"
        );
        let start = std::time::Instant::now();
        view.options.surface_size.cols += 1;
        view.resize_at(start);
        view.options.surface_size.cols += 1;
        view.resize_at(start + super::lifecycle::RESIZE_SETTLE);
        assert!(
            view.local_error.is_none(),
            "a size still changing is not sent"
        );
        let settled = start + super::lifecycle::RESIZE_SETTLE * 2;
        view.options.cell_width_px += 1;
        view.resize_at(settled);
        view.resize_at(settled + super::lifecycle::RESIZE_SETTLE / 2);
        assert!(
            view.local_error.is_none(),
            "the last change restarts the wait"
        );
        view.resize_at(settled + super::lifecycle::RESIZE_SETTLE);
        assert!(
            view.local_error.is_some(),
            "cell metrics alone trigger a send once settled"
        );
        assert_eq!(view.last_queued_options, Some(queued));
        view.local_error = None;
        view.resize_at(settled + super::lifecycle::RESIZE_SETTLE);
        assert!(view.local_error.is_some(), "failed options are retried");
    });
}

#[gpui::test]
fn resize_reasks_when_the_daemon_frame_is_a_different_size(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        HerdrWindow::new(
            ConnectTarget::Socket("/unused-resize-test.sock".into()),
            window,
            cx,
            true,
        )
    });
    view.update(cx, |view, _| {
        let client = herdr_client::connect(
            view.endpoints[view.selected_endpoint]
                .connection
                .target
                .clone(),
            view.options,
        )
        .unwrap_or_else(|error| panic!("cannot create test client: {error}"));
        client.handle.disconnect();
        view.endpoints[view.selected_endpoint].connection.handle = Some(client.handle);
        // The window already asked for its size, and the daemon projects a
        // frame of another size: another client resized the tab.
        let queued = view.options;
        view.last_queued_options = Some(queued);
        view.live.surface = Some(Arc::new(PaneSurfaceFrame {
            boot_id: String::new(),
            projection_revision: 0,
            surface_revision: 0,
            frame: FrameData {
                width: queued.surface_size.cols.saturating_add(1),
                height: queued.surface_size.rows,
                cells: Vec::new(),
                cursor: None,
                hyperlinks: Vec::new(),
                graphics: Vec::new(),
            },
            panes: Vec::new(),
            splits: Vec::new(),
            popup: None,
            graphics: Default::default(),
        }));
        let start = std::time::Instant::now();
        view.resize_at(start + super::lifecycle::RESIZE_SETTLE);
        assert!(
            view.local_error.is_none(),
            "a disagreeing frame still settles before a send"
        );
        view.resize_at(start + super::lifecycle::RESIZE_REASSERT);
        assert!(
            view.local_error.is_none(),
            "a frame of another size is not re-claimed before it has been answered"
        );
        view.resize_at(start + super::lifecycle::RESIZE_REASSERT + super::lifecycle::RESIZE_SETTLE);
        assert!(
            view.local_error.is_some(),
            "a frame of another size asks for the size again"
        );
    });
}
