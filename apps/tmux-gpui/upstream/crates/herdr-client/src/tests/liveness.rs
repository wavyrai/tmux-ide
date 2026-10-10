use super::*;
use crate::limits::{LIVENESS_TIMEOUT, PING_TIMEOUT};

#[test]
fn a_liveness_probe_pings_at_once_and_fails_sooner_than_a_routine_ping() {
    let now = Instant::now();
    let mut health = Health::new(now);
    assert!(health.probe(now));
    assert!(!health.tick(now + LIVENESS_TIMEOUT - POLL).unwrap());
    assert!(matches!(
        health.tick(now + LIVENESS_TIMEOUT),
        Err(Error::HealthTimeout)
    ));

    // A probe while a routine ping is outstanding only brings its deadline forward.
    let mut health = Health::new(now);
    assert!(health.tick(now + Duration::from_secs(5)).unwrap());
    let probed = now + Duration::from_secs(6);
    assert!(!health.probe(probed));
    assert!(health.tick(probed + LIVENESS_TIMEOUT).is_err());

    // An answer clears it, and a later probe sends a new ping.
    let mut health = Health::new(now);
    assert!(health.probe(now));
    health.received(now + POLL);
    assert!(!health.tick(now + LIVENESS_TIMEOUT).unwrap());
    assert!(health.probe(now + LIVENESS_TIMEOUT));
}

#[test]
fn check_liveness_sends_a_ping_now_on_an_ssh_link_and_drops_a_silent_one() {
    let (client, mut server, worker) = test_client_mode(false, true);
    server
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    receive(&mut server);
    let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
    welcome["methods"] = json!(["client_shell.surface.set"]);
    welcome["capabilities"] = json!([
        "surface_interest",
        "presentation_effects_fence",
        "health_check"
    ]);
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_WELCOME_KIND.into(),
            data: welcome.to_string(),
        },
    );
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: SNAPSHOT.into(),
        },
    );
    event(&client);
    event(&client);
    let asked = Instant::now();
    client.handle.check_liveness();
    assert!(
        matches!(receive(&mut server), ClientMessage::EndpointControl { kind, .. } if kind == "endpoint.health.ping.v1")
    );
    // Well before a quiet link's five seconds: the probe sent it.
    assert!(asked.elapsed() < Duration::from_secs(2));
    // Unanswered, the link fails on the probe's deadline, not the routine one.
    assert!(matches!(worker.join().unwrap(), Err(Error::HealthTimeout)));
    let waited = asked.elapsed();
    assert!(
        waited >= LIVENESS_TIMEOUT && waited < PING_TIMEOUT,
        "{waited:?}"
    );
}
