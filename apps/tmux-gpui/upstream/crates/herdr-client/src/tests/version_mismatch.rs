use super::*;
use crate::VersionMismatch;

fn welcome_with(edit: impl FnOnce(&mut Value)) -> ServerMessage {
    let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
    edit(&mut welcome);
    ServerMessage::EndpointControl {
        kind: ENDPOINT_WELCOME_KIND.into(),
        data: welcome.to_string(),
    }
}

fn refusal(remote: bool, message: ServerMessage) -> Error {
    Session::new(true, remote)
        .handle_message(message, |_| Ok(()))
        .unwrap_err()
}

#[test]
fn legacy_welcome_means_the_daemon_predates_the_endpoint() {
    let error = refusal(
        false,
        ServerMessage::Welcome {
            version: 22,
            encoding: RenderEncoding::SemanticFrame,
            error: Some("expected TerminalHello or ClientShellHello".into()),
        },
    );
    assert!(matches!(error, Error::LegacyDaemon));
    assert_eq!(
        error.version_mismatch(),
        Some(VersionMismatch::DaemonOutdated {
            server_version: None
        })
    );
    assert!(error.to_string().contains("herdr update"));
}

#[test]
fn generation_says_which_side_is_older_even_in_a_rejection() {
    let older = refusal(false, welcome_with(|w| w["generation"] = json!(0)));
    assert!(matches!(
        older,
        Error::EndpointGeneration { generation: 0, .. }
    ));
    assert_eq!(
        older.version_mismatch(),
        Some(VersionMismatch::DaemonOutdated {
            server_version: Some("0.8.2".into())
        })
    );
    assert!(older.to_string().contains("run `herdr update`"));

    // Upstream rejects a generation it does not speak with a welcome carrying
    // its own generation and an error; the generation decides, not the code.
    let newer = refusal(
        false,
        welcome_with(|w| {
            w["generation"] = json!(2);
            w["error"] = json!({"code": "unsupported_generation", "message": "no"});
        }),
    );
    assert_eq!(
        newer.version_mismatch(),
        Some(VersionMismatch::ClientOutdated {
            server_version: Some("0.8.2".into())
        })
    );
    assert!(newer.to_string().contains("update Herdr GPUI"));
}

#[test]
fn missing_required_capabilities_mean_the_daemon_is_outdated() {
    let remote = refusal(true, welcome_with(|w| w["capabilities"] = json!([])));
    assert!(matches!(remote, Error::MissingSurfaceInterest { .. }));
    let health = refusal(
        true,
        welcome_with(|w| {
            w["methods"] = json!(["client_shell.surface.set"]);
            w["capabilities"] = json!(["surface_interest", "presentation_effects_fence"]);
        }),
    );
    assert!(matches!(health, Error::MissingHealthCheck { .. }));
    for error in [remote, health] {
        assert_eq!(
            error.version_mismatch(),
            Some(VersionMismatch::DaemonOutdated {
                server_version: Some("0.8.2".into())
            }),
            "{error}"
        );
        assert!(error.to_string().contains("Herdr server 0.8.2"), "{error}");
    }
}

#[test]
fn other_refusals_are_not_version_mismatches() {
    for error in [
        refusal(
            false,
            welcome_with(|w| {
                w["error"] = json!({"code": "no_common_core", "message": "unsupported"})
            }),
        ),
        refusal(
            false,
            welcome_with(|w| w["snapshot_codec"] = json!("future.codec")),
        ),
        refusal(false, ServerMessage::ServerShutdown { reason: None }),
        Error::SocketClosed,
        Error::HealthTimeout,
    ] {
        assert_eq!(error.version_mismatch(), None, "{error}");
    }
}

#[test]
fn reported_server_version_is_bounded_and_printable() {
    let error = Error::EndpointGeneration {
        generation: 0,
        server_version: format!(" \u{1b}[31m{}\n", "9".repeat(200)),
    };
    let mismatch = error.version_mismatch().unwrap();
    let version = mismatch.server_version().unwrap();
    assert_eq!(version.chars().count(), 64);
    assert!(version.starts_with("[31m9"));
    assert!(!version.chars().any(char::is_control));

    let blank = Error::MissingHealthCheck {
        server_version: "\n\t ".into(),
    };
    assert_eq!(blank.version_mismatch().unwrap().server_version(), None);
}

#[test]
fn connection_reports_the_mismatch_before_disconnecting() {
    let (stream, mut server) = Stream::pair().unwrap();
    let daemon = thread::spawn(move || {
        receive(&mut server);
        send(
            &mut server,
            ServerMessage::Welcome {
                version: 22,
                encoding: RenderEncoding::SemanticFrame,
                error: None,
            },
        );
        server
    });
    let mut stream = Some(stream);
    let client = connect_with_connector(
        ConnectTarget::Local,
        ConnectOptions::default(),
        true,
        move |_, _| {
            stream
                .take()
                .ok_or_else(|| io::Error::other("connected once"))
        },
    )
    .unwrap();
    assert!(matches!(
        event(&client),
        ClientEvent::VersionMismatch(VersionMismatch::DaemonOutdated {
            server_version: None
        })
    ));
    let ClientEvent::Disconnected { reason, .. } = event(&client) else {
        panic!("expected disconnect")
    };
    assert!(
        reason.contains("predates the endpoint protocol"),
        "{reason}"
    );
    drop(daemon.join().unwrap());
}

/// Releases before 0.9.0 cannot decode the endpoint hello and close without
/// any reply, as Herdr 0.7.5 and 0.8.2 were observed to do.
fn closed_after_hello(remote: bool, welcome_first: bool) -> Error {
    let (client, mut server, worker) = test_client_mode(true, remote);
    receive(&mut server);
    if welcome_first {
        send(&mut server, welcome_with(|_| {}));
    }
    drop(server);
    let error = worker.join().unwrap().unwrap_err();
    drop(client);
    error
}

#[test]
fn a_local_daemon_closing_before_any_welcome_is_outdated() {
    let error = closed_after_hello(false, false);
    assert!(matches!(error, Error::ClosedBeforeWelcome), "{error}");
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    assert_eq!(
        error.version_mismatch(),
        Some(VersionMismatch::DaemonOutdated {
            server_version: None
        })
    );
    assert!(error.to_string().contains("older than 0.9.0"), "{error}");
}

#[test]
fn closes_after_a_welcome_or_over_ssh_stay_plain_disconnects() {
    // SSH discovery vets the remote binary, so an early close there is a
    // transport failure, and a daemon that answered is not outdated.
    for (remote, welcome_first) in [(true, false), (false, true)] {
        let error = closed_after_hello(remote, welcome_first);
        assert!(
            matches!(error, Error::SocketClosed),
            "{remote} {welcome_first}: {error}"
        );
        assert_eq!(error.version_mismatch(), None);
    }
}
