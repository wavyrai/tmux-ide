use crate::{
    notifications::{Notice, tests::notification},
    sidebar::layout_tests::fixture_window,
};
use gpui::{TestAppContext, px, size};
use std::time::Instant;

#[gpui::test]
fn targeted_previews_use_only_current_snapshot_ids(cx: &mut TestAppContext) {
    use herdr_client::protocol::{ClientShellSnapshot, SemanticNotificationKind};
    let (view, cx) = cx.add_window_view(fixture_window);
    let snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap();
    view.update(cx, |view, cx| {
        view.endpoints[0].live.snapshot = Some(std::sync::Arc::new(snapshot.clone()));
        view.config.notifications.delay_seconds = 3600;
        for kind in [
            SemanticNotificationKind::NeedsAttention,
            SemanticNotificationKind::Finished,
            SemanticNotificationKind::Custom,
        ] {
            view.show_toast_preview(kind, cx);
            let notice = &view.endpoints[0].toasts.entries.back().unwrap().1;
            if kind == SemanticNotificationKind::Custom {
                assert!(notice.target(&snapshot).is_none());
            } else {
                assert_eq!(
                    notice.target(&snapshot),
                    Some(crate::navigation::NavigationTarget::Pane("w1:p1"))
                );
            }
        }
    });
}

#[gpui::test]
fn toast_preview_actions_use_normal_state_without_a_connection(cx: &mut TestAppContext) {
    use crate::actions::ShowToastPreview;
    use herdr_client::protocol::{SemanticNotificationKind, ToastHerdrPosition};

    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(1000.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            window.focus(&view.focus, cx);
            view.endpoints.push(crate::endpoint::Endpoint::new(
                "preview".into(),
                "Preview host".into(),
                herdr_client::ConnectTarget::Socket("/unused-toast-preview.sock".into()),
                false,
            ));
            view.selected_endpoint = 1;
        });
        window.draw(cx).clear(cx);
    });
    let snapshot = view.read_with(cx, |view, _| view.live.snapshot.clone());
    let updater = view.read_with(cx, |view, _| view.updater.state().clone());
    for (index, kind) in [
        SemanticNotificationKind::NeedsAttention,
        SemanticNotificationKind::Finished,
        SemanticNotificationKind::UpdateInstalled,
        SemanticNotificationKind::Custom,
    ]
    .into_iter()
    .enumerate()
    {
        cx.update(|window, cx| {
            window.dispatch_action(Box::new(ShowToastPreview { kind }), cx);
        });
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            let view = view.read(cx);
            let endpoint = &view.endpoints[1];
            let (_, notice) = endpoint.toasts.entries.back().unwrap();
            assert_eq!(notice.kind, kind);
            assert!(!notice.title.is_empty());
            assert!(notice.body.as_ref().unwrap().starts_with("QA preview"));
            assert_eq!(notice.position, ToastHerdrPosition::BottomRight);
            assert_eq!(endpoint.toasts.entries.len(), 1);
            assert!(endpoint.connection.handle.is_none());
            assert!(view.endpoints[0].toasts.entries.is_empty());
            assert_eq!(view.selected_endpoint, 1);
            assert_eq!(view.live.snapshot, snapshot);
            assert_eq!(view.updater.state(), &updater);
            assert!(view.focus.is_focused(window));
        });
        assert!(
            cx.debug_bounds(
                [
                    "toast-preview-0",
                    "toast-preview-1",
                    "toast-preview-2",
                    "toast-preview-3",
                ][index]
            )
            .is_some()
        );
    }
    let dismiss = cx.debug_bounds("toast-dismiss-preview-3").unwrap();
    cx.simulate_click(dismiss.center(), Default::default());
    view.update(cx, |view, _| {
        assert!(view.endpoints[1].toasts.entries.is_empty());
    });
}

#[gpui::test]
fn notifications_layout_dismissal_and_focus_are_nonmodal(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            window.focus(&view.focus, cx);
            view.marked = "composition".into();
            view.endpoints[0].toasts.receive((0..3).map(|_| {
                let mut wire = notification(&"long title ".repeat(100));
                wire.body = Some("body ".repeat(200));
                Notice::new(wire, Instant::now()).preview()
            }));
            let mut remote = crate::endpoint::Endpoint::new(
                "remote".into(),
                "Remote".into(),
                herdr_client::ConnectTarget::Socket("/unused-toast-test.sock".into()),
                true,
            );
            remote
                .toasts
                .receive([Notice::new(notification("Remote"), Instant::now()).preview()]);
            view.endpoints.push(remote);
        });
    });
    for (width, height) in [(1000., 600.), (360., 240.)] {
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            assert!(view.read(cx).focus.is_focused(window));
            assert_eq!(view.read(cx).marked, "composition");
            assert_eq!(view.read(cx).selected_endpoint, 0);
        });
        let mut bottom = px(0.);
        for selector in ["toast-local-0", "toast-local-1", "toast-local-2"]
            .into_iter()
            .take(1)
        {
            let bounds = cx.debug_bounds(selector).unwrap();
            assert!(bounds.left() >= px(0.) && bounds.right() <= px(width));
            assert!(bounds.top() >= bottom && bounds.bottom() <= px(height));
            bottom = bounds.bottom();
            if width == 1000. {
                assert_eq!(bounds.left(), px(12.));
            } else {
                assert_eq!(bounds.right(), px(width - 12.));
            }
        }
    }
    // Use a full-height card for the dismissal hit target.
    cx.simulate_resize(size(px(1000.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let dismiss = cx.debug_bounds("toast-dismiss-local-0").unwrap();
    cx.simulate_click(dismiss.center(), Default::default());
    cx.update(|window, cx| {
        assert!(view.read(cx).focus.is_focused(window));
        assert_eq!(view.read(cx).endpoints[0].toasts.entries.len(), 2);
        assert_eq!(view.read(cx).endpoints[1].toasts.entries.len(), 1);
        assert_eq!(view.read(cx).marked, "composition");
        view.update(cx, |view, cx| view.open_keybinds(window, cx));
        assert!(
            view.update(cx, |view, cx| view.render_toasts(window, cx))
                .is_empty()
        );
    });
}

#[gpui::test]
fn notifications_honor_all_corners_and_global_card_limit(cx: &mut TestAppContext) {
    use herdr_client::protocol::ToastHerdrPosition;
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(1000.), px(600.)));
    for position in [
        ToastHerdrPosition::TopLeft,
        ToastHerdrPosition::TopRight,
        ToastHerdrPosition::BottomLeft,
        ToastHerdrPosition::BottomRight,
    ] {
        cx.update(|window, cx| {
            view.update(cx, |view, _| {
                view.endpoints[0].toasts = Default::default();
                let mut wire = notification("Corner");
                wire.position = Some(position);
                view.endpoints[0]
                    .toasts
                    .receive([Notice::new(wire, Instant::now()).preview()]);
            });
            window.draw(cx).clear(cx);
        });
        let bounds = cx.debug_bounds("toast-local-0").unwrap();
        if matches!(
            position,
            ToastHerdrPosition::TopLeft | ToastHerdrPosition::TopRight
        ) {
            assert_eq!(bounds.top(), px(72.));
        } else {
            assert_eq!(bounds.bottom(), px(564.));
        }
        if matches!(
            position,
            ToastHerdrPosition::TopLeft | ToastHerdrPosition::BottomLeft
        ) {
            assert_eq!(bounds.left(), px(12.));
        } else {
            assert_eq!(bounds.right(), px(988.));
        }
    }
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            for id in ["one", "two", "three"] {
                let mut endpoint = crate::endpoint::Endpoint::new(
                    id.into(),
                    id.into(),
                    herdr_client::ConnectTarget::Socket("/unused-toast-test.sock".into()),
                    true,
                );
                endpoint
                    .toasts
                    .receive([Notice::new(notification(id), Instant::now()).preview()]);
                view.endpoints.push(endpoint);
            }
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("toast-local-0").is_some());
    assert!(cx.debug_bounds("toast-one-0").is_none());
    assert!(cx.debug_bounds("toast-two-0").is_none());
    assert!(cx.debug_bounds("toast-three-0").is_none());
    let dismiss = cx.debug_bounds("toast-dismiss-local-0").unwrap();
    cx.simulate_click(dismiss.center(), Default::default());
    view.read_with(cx, |view, _| {
        assert!(view.endpoints[0].toasts.entries.is_empty());
        assert_eq!(view.endpoints[2].toasts.entries.len(), 1);
        assert_eq!(view.selected_endpoint, 0);
    });
}
