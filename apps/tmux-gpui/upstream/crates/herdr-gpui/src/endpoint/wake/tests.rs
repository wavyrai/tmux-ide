use super::*;

#[test]
fn a_wall_clock_running_ahead_of_the_monotonic_one_is_a_sleep() {
    let start = Instant::now();
    let wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let mut clock = WakeClock::new(start, wall);
    // Both clocks advance together while awake, however long the gap.
    let awake = start + Duration::from_secs(60);
    assert!(!clock.woke(awake, wall + Duration::from_secs(60)));
    // Jitter between them is not a sleep.
    let jitter = awake + Duration::from_secs(1);
    assert!(!clock.woke(jitter, wall + Duration::from_secs(64)));
    // Ten minutes asleep: the monotonic clock moved a moment, the wall clock did not stop.
    let woke = jitter + Duration::from_millis(16);
    assert!(clock.woke(woke, wall + Duration::from_secs(64 + 600)));
    // The next reading is measured from the wake, not the sleep.
    assert!(!clock.woke(
        woke + Duration::from_millis(16),
        wall + Duration::from_secs(664) + Duration::from_millis(16)
    ));
}

#[test]
fn a_wall_clock_set_backwards_is_not_a_sleep() {
    let start = Instant::now();
    let wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let mut clock = WakeClock::new(start, wall);
    assert!(!clock.woke(
        start + Duration::from_secs(1),
        wall - Duration::from_secs(3600)
    ));
}

#[gpui::test]
fn waking_redials_dropped_endpoints_now_and_leaves_detached_ones(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.reconcile_catalog(
            vec![
                crate::endpoint::tests::host("down", true),
                crate::endpoint::tests::host("parked", true),
            ],
            Vec::new(),
            cx,
        );
        let now = Instant::now();
        let later = now + Duration::from_secs(30);
        for endpoint in &mut view.endpoints {
            endpoint.connection.handle = None;
            endpoint.retry_at = later;
        }
        view.endpoints[2].detached = true;
        let wall = SystemTime::now();
        view.wake = WakeClock::new(now, wall);

        assert!(
            !view.recover_after_sleep(now + Duration::from_secs(1), wall + Duration::from_secs(1))
        );
        assert!(view.endpoints.iter().all(|e| e.retry_at == later));

        let woke = now + Duration::from_secs(2);
        assert!(view.recover_after_sleep(woke, wall + Duration::from_secs(600)));
        assert_eq!(view.endpoints[1].retry_at, woke);
        // A detached endpoint is never dialled by the poll loop, whatever its time.
        assert!(view.endpoints[2].detached);
    });
}
