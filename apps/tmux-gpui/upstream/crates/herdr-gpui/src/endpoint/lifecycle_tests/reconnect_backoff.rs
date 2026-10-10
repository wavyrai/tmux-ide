use super::*;

#[test]
fn retry_backoff_resets_only_after_sixty_seconds_of_healthy_connection() {
    let (mut endpoint, _server) = connected_endpoint(LOCAL);
    endpoint.attempts = 8;
    let now = Instant::now();
    endpoint.online_since = None;
    endpoint.poll(now);
    endpoint.poll(now + Duration::from_secs(59));
    assert_eq!(endpoint.retry_delay(), Duration::from_secs(30));
    endpoint.poll(now + Duration::from_secs(60));
    assert_eq!(endpoint.attempts, 0);
    assert_eq!(endpoint.retry_delay(), Duration::from_millis(500));
    endpoint.connection.handle.as_ref().unwrap().disconnect();
    endpoint.poll(now + Duration::from_secs(61));
    assert_eq!(
        endpoint.retry_at,
        now + Duration::from_secs(61) + Duration::from_millis(500)
    );
    assert!(endpoint.online_since.is_none());
}

#[test]
fn retry_backoff_doubles_from_half_a_second_to_thirty_seconds() {
    let mut endpoint = Endpoint::new(
        LOCAL.into(),
        LOCAL.into(),
        ConnectTarget::Socket("/nonexistent".into()),
        true,
    );
    let delays: Vec<_> = (0..10)
        .map(|attempts| {
            endpoint.attempts = attempts;
            endpoint.retry_delay().as_millis()
        })
        .collect();
    assert_eq!(
        delays,
        [
            500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000
        ]
    );
    endpoint.attempts = u32::MAX;
    assert_eq!(endpoint.retry_delay(), Duration::from_secs(30));
}

#[test]
fn brief_success_preserves_backoff_and_disconnect_restarts_stability_window() {
    let (mut endpoint, _server) = connected_endpoint(LOCAL);
    endpoint.attempts = 8;
    let now = Instant::now();
    endpoint.online_since = None;
    endpoint.poll(now);
    endpoint.poll(now + Duration::from_secs(59));
    endpoint.connection.handle.as_ref().unwrap().disconnect();
    endpoint.poll(now + Duration::from_secs(59));
    assert_eq!(endpoint.attempts, 8);
    assert!(endpoint.online_since.is_none());
    assert_eq!(endpoint.retry_at, now + Duration::from_secs(59 + 30));
    endpoint.connect(ConnectOptions::default(), false);
    assert_eq!(
        endpoint.attempts, 9,
        "automatic retry must preserve failed attempts"
    );
    assert!(endpoint.online_since.is_none());
}

#[gpui::test]
fn changed_target_and_manual_reconnect_reset_retry_history(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    view.update(cx, |view, cx| {
        let host = SavedHost {
            id: "test".into(),
            label: "Test".into(),
            target: "unused".into(),
            session: "default".into(),
            enabled: true,
        };
        view.reconcile_catalog(vec![host.clone()], Vec::new(), cx);
        view.endpoints[1].attempts = 8;
        view.reconcile_catalog(vec![host.clone()], Vec::new(), cx);
        assert_eq!(
            view.endpoints[1].attempts, 8,
            "unchanged catalog preserves backoff"
        );
        view.reconcile_catalog(
            vec![SavedHost {
                session: "changed".into(),
                ..host
            }],
            Vec::new(),
            cx,
        );
        assert_eq!(view.endpoints[1].attempts, 0);
        assert!(view.endpoints[1].online_since.is_none());
        view.endpoints[0].attempts = 8;
        view.reconnect(cx); // Explicit isolated missing socket, never SSH/discovery.
        assert_eq!(
            view.endpoints[0].attempts, 1,
            "manual reconnect starts a fresh first attempt"
        );
        assert_eq!(view.endpoints[0].retry_delay(), Duration::from_secs(1));
    });
}
