use super::*;

#[test]
fn health_probes_quiet_hosts_and_any_complete_message_satisfies_probe() {
    let now = Instant::now();
    let mut health = Health::new(now);
    assert!(!health.tick(now).unwrap());
    assert!(health.tick(now + Duration::from_secs(5)).unwrap());
    assert!(!health.tick(now + Duration::from_secs(14)).unwrap());
    assert!(health.tick(now + Duration::from_secs(15)).is_err());
    health.received(now + Duration::from_secs(15));
    assert!(!health.tick(now + Duration::from_secs(16)).unwrap());
    assert!(health.tick(now + Duration::from_secs(20)).unwrap());
}

#[test]
fn session_negotiates_remote_health_without_extending_snapshot_deadline() {
    for (surface_active, remote) in [(true, false), (false, false), (true, true), (false, true)] {
        for health_supported in [false, true] {
            let mut session = Session::new(surface_active, remote);
            let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
            welcome["methods"] = json!(["client_shell.surface.set"]);
            welcome["capabilities"] = json!(["surface_interest", "presentation_effects_fence"]);
            if health_supported {
                welcome["capabilities"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("health_check"));
            }
            let mut events = Vec::new();
            let result = session.handle_message(
                ServerMessage::EndpointControl {
                    kind: ENDPOINT_WELCOME_KIND.into(),
                    data: welcome.to_string(),
                },
                |event| {
                    events.push(event);
                    Ok(())
                },
            );
            if remote && !health_supported {
                assert!(matches!(
                    result.unwrap_err(),
                    Error::MissingHealthCheck { server_version } if server_version == "0.8.2"
                ));
                assert!(events.is_empty());
                assert!(session.welcome.is_none());
                continue;
            }
            result.unwrap();
            assert!(matches!(events.as_slice(), [ClientEvent::Connected(_)]));
            assert_eq!(session.health.is_some(), remote);
            if let Some(health) = &mut session.health {
                health.ping = Some((Instant::now(), Instant::now() + limits::PING_TIMEOUT));
            }
            session.started = Instant::now() - TIMEOUT - POLL;
            session
                .handle_message(
                    ServerMessage::EndpointControl {
                        kind: "endpoint.health.pong.v1".into(),
                        data: String::new(),
                    },
                    |_| panic!("health controls must not emit UI events"),
                )
                .unwrap();
            assert!(session.health.as_ref().is_none_or(|h| h.ping.is_none()));
            assert_eq!(
                session.check_timeouts().unwrap_err().to_string(),
                "handshake/snapshot timed out"
            );
        }
    }
}

#[test]
fn ssh_health_uses_named_ping_and_ignores_pong_as_an_optional_control() {
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
    assert!(
        matches!(receive(&mut server), ClientMessage::EndpointControl { kind, data } if kind == "endpoint.health.ping.v1" && data.is_empty())
    );
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: "endpoint.health.pong.v1".into(),
            data: String::new(),
        },
    );
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: SNAPSHOT.into(),
        },
    );
    assert!(matches!(event(&client), ClientEvent::Snapshot(_)));
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}
