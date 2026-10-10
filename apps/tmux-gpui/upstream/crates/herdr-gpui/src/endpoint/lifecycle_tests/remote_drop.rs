use super::*;

#[test]
fn a_drop_is_an_outage_until_a_connection_has_a_snapshot() {
    let (mut endpoint, server) = connected_endpoint("ssh:remote");
    assert_eq!(endpoint.outage(), None);
    server.stream.shutdown(std::net::Shutdown::Both).unwrap();
    wait_until(|| {
        endpoint.poll(Instant::now());
        endpoint.connection.handle.is_none()
    });
    assert!(endpoint.outage().is_some());
    assert_eq!(endpoint.status(), "reconnecting");
    // A retry replaces `live` with a fresh attempt; the outage outlives it,
    // whether or not that attempt has already failed.
    endpoint.connect(ConnectOptions::default(), false);
    assert!(endpoint.outage().is_some());
    assert_eq!(endpoint.status(), "reconnecting");

    let (mut endpoint, _server) = connected_endpoint("ssh:remote");
    endpoint.outage = Some("connection lost".into());
    endpoint.poll(Instant::now());
    assert_eq!(endpoint.outage(), None);
    assert_eq!(endpoint.status(), "online");
}

#[gpui::test]
fn a_dropped_remote_stays_selected_with_its_last_picture_dimmed(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, server) = connected_endpoint("ssh:remote");
    view.update(cx, |view, cx| {
        prepare_mouse(view, endpoint, cx);
        assert!(view.presentation.picture(&view.live).is_some());
        assert!(!view.presentation.stale());
        view.endpoints[1].retry_at = Instant::now() + Duration::from_secs(120);
    });
    server.stream.shutdown(std::net::Shutdown::Both).unwrap();
    view.update(cx, |view, cx| {
        project_until(view, cx, "the drop", |view| {
            view.endpoints[1].connection.handle.is_none()
        });
        // An expired activation budget is renewed while there is no snapshot.
        view.activation_deadline = Some(Instant::now());
        view.poll_endpoints(cx);
        assert_eq!(
            view.selected_endpoint, 1,
            "a drop must not fall back to Local"
        );
        assert!(view.activation_deadline.unwrap() > Instant::now());
        assert!(view.presentation.stale());
        assert!(view.presentation.picture(&view.live).is_some());

        // Keys typed into the lost connection go nowhere, and say so.
        view.send(ClientPaneInputEvent::TextCommit("x".into()), cx);
        let (flash, _) = view.flash.as_ref().unwrap();
        assert!(flash.text.contains("Not connected"));
        assert_eq!(view.pending_input.len(), 0);

        // An automatic retry keeps the picture up while it connects.
        view.endpoints[1].retry_at = Instant::now();
        view.poll_endpoints(cx);
        assert_eq!(view.selected_endpoint, 1);
        assert_eq!(view.selected_generation, view.endpoints[1].generation);
        assert!(view.presentation.stale());
        assert!(view.presentation.picture(&view.live).is_some());

        // Leaving the endpoint leaves its picture behind.
        assert!(view.switch_endpoint(LOCAL, cx));
        assert!(!view.presentation.stale());
        assert!(view.presentation.picture(&view.live).is_none());
    });
}

#[test]
fn a_refusal_only_the_user_can_fix_waits_the_longest_retry_delay() {
    for (failure, waits_longest) in [
        (SshFailure::Auth, true),
        (SshFailure::HostKey, true),
        (SshFailure::HerdrMissing, true),
        (SshFailure::Unreachable, false),
    ] {
        let (mut endpoint, _server) = connected_endpoint("ssh:remote");
        let error = herdr_client::Error::SshRefused(failure).to_string();
        endpoint
            .connection
            .inbox
            .lock()
            .unwrap()
            .apply(ClientEvent::Disconnected {
                reason: error.clone(),
                ssh: Some(failure),
            });
        endpoint.connection.handle.as_ref().unwrap().disconnect();
        let now = Instant::now();
        // The inbox may be busy for a poll; the state still lands on a later one.
        wait_until(|| {
            endpoint.poll(now);
            endpoint.live.ssh_failure.is_some()
        });
        let expected = if waits_longest {
            MAX_RETRY_DELAY
        } else {
            endpoint.retry_delay()
        };
        assert_eq!(endpoint.retry_at, now + expected, "{failure:?}");
        assert_eq!(endpoint.outage(), Some(error.as_str()));
    }
}

/// The worker stops the handle before its disconnect state reaches the inbox,
/// so a poll can find the connection gone while `live` still holds the old
/// snapshot. An activation budget must not run out in that gap either.
#[gpui::test]
fn a_drop_seen_before_its_state_arrives_does_not_fall_back_to_local(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, _server) = connected_endpoint("ssh:remote");
    view.update(cx, |view, cx| {
        prepare_mouse(view, endpoint, cx);
        view.endpoints[1].retry_at = Instant::now() + Duration::from_secs(120);
        // A stopped handle delivers no disconnect state at all.
        view.endpoints[1]
            .connection
            .handle
            .as_ref()
            .unwrap()
            .disconnect();
        view.activation_deadline = Some(Instant::now());
        view.poll_endpoints(cx);
        assert_eq!(
            view.selected_endpoint, 1,
            "a drop must not fall back to Local"
        );
        assert!(view.endpoints[1].connection.handle.is_none());
        assert!(view.live.snapshot.is_some(), "the gap under test");
        assert!(view.activation_deadline.unwrap() > Instant::now());
        // `live` still holds the lost connection's ready frame; painting it
        // must not undo the dimming.
        assert!(view.live.surface_ready());
        assert!(view.presentation.picture(&view.live).is_some());
        assert!(view.presentation.stale());
        assert!(view.reconnecting());
    });
}

#[test]
fn a_stopped_handle_reads_as_reconnecting_before_its_state_arrives() {
    let (mut endpoint, _server) = connected_endpoint("ssh:remote");
    // A stopped handle delivers no disconnect state at all.
    endpoint.connection.handle.as_ref().unwrap().disconnect();
    endpoint.poll(Instant::now());
    assert!(endpoint.live.status.is_connected(), "the gap under test");
    assert_eq!(endpoint.outage(), Some("connection lost"));
    assert_eq!(endpoint.status(), "reconnecting");
}

/// The refusal can reach the inbox a poll after the stop it explains. It must
/// still hold the host to the longest delay, and name the reason.
#[test]
fn a_refusal_that_arrives_after_its_stop_still_waits_the_longest_delay() {
    let (mut endpoint, _server) = connected_endpoint("ssh:remote");
    endpoint.connection.handle.as_ref().unwrap().disconnect();
    let dropped = Instant::now();
    endpoint.poll(dropped);
    assert_eq!(endpoint.outage(), Some("connection lost"));
    assert_eq!(endpoint.retry_at, dropped + endpoint.retry_delay());

    let error = herdr_client::Error::SshRefused(SshFailure::HostKey).to_string();
    endpoint
        .connection
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Disconnected {
            reason: error.clone(),
            ssh: Some(SshFailure::HostKey),
        });
    let arrived = dropped + Duration::from_millis(16);
    endpoint.poll(arrived);
    assert_eq!(endpoint.outage(), Some(error.as_str()));
    assert_eq!(endpoint.retry_at, arrived + MAX_RETRY_DELAY);
}

/// The replacement connection's snapshot ends the outage before its first
/// frame arrives. The old picture must stay dimmed, under the card, until then.
#[gpui::test]
fn the_card_stays_until_the_replacement_frame_lands(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, _server) = connected_endpoint("ssh:remote");
    view.update(cx, |view, cx| {
        prepare_mouse(view, endpoint, cx);
        let first = view.presentation.picture(&view.live).unwrap().frame;
        view.endpoints[1].retry_at = Instant::now() + Duration::from_secs(120);
        view.endpoints[1]
            .connection
            .handle
            .as_ref()
            .unwrap()
            .disconnect();
        view.poll_endpoints(cx);
        assert!(view.presentation.stale());

        // Stand in for the replacement: a connection with a snapshot ends the
        // outage, and its surface is not ready yet.
        view.endpoints[1].outage = None;
        view.poll_endpoints(cx);
        let mut waiting = view.live.clone();
        waiting.surface = None;
        let shown = view.presentation.picture(&waiting).unwrap().frame;
        assert!(Arc::ptr_eq(&shown, &first));
        assert!(view.presentation.stale());
        assert!(view.reconnecting(), "the card outlives the outage");

        let mut replacement = view.live.clone();
        let mut frame = (*first).clone();
        frame.surface_revision += 1;
        replacement.surface = Some(Arc::new(frame));
        assert!(replacement.surface_ready());
        view.presentation.picture(&replacement);
        assert!(!view.presentation.stale());
        assert!(!view.reconnecting());
    });
}
