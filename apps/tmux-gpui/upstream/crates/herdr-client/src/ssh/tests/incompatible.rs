use super::*;
use crate::VersionMismatch;

const CURRENT: &str = r#"{"version":"0.9.3","endpoint_protocol_generation":1,"endpoint_capabilities":["surface_interest","presentation_effects_fence","health_check"]}"#;

/// Plays the bridge script's side: each installed candidate prints its status
/// and the ready line, then waits for `accept` or `skip`; the script exits
/// once every candidate was skipped. A real script would also probe this
/// machine's own install locations, so the peer is scripted instead.
fn choose(statuses: &[&str]) -> Result<()> {
    let (mut stream, mut remote) = Stream::pair().unwrap();
    stream.set_read_timeout(Some(POLL)).unwrap();
    let statuses: Vec<String> = statuses.iter().map(|s| (*s).to_owned()).collect();
    let script = std::thread::spawn(move || {
        remote
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        for status in statuses {
            remote
                .write_all(format!("motd\n{status}\n\nherdr-remote-output-ready:1\n").as_bytes())
                .unwrap();
            let mut choice = Vec::new();
            let mut byte = [0];
            while byte != *b"\n" {
                remote.read_exact(&mut byte).unwrap();
                choice.push(byte[0]);
            }
            if choice.starts_with(b"accept") {
                return;
            }
        }
    });
    let result = handshake(&mut stream, &AtomicBool::new(false));
    script.join().unwrap();
    result
}

#[test]
fn an_outdated_remote_install_is_named_instead_of_a_closed_bridge() {
    let error = choose(&[r#"{"version":"0.8.0","endpoint_capabilities":[]}"#]).unwrap_err();
    assert!(matches!(
        &error,
        Error::BridgeIncompatible { generation: None, version: Some(version) } if version == "0.8.0"
    ));
    assert_eq!(
        error.to_string(),
        "Herdr (version 0.8.0) on this host cannot serve this app; run `herdr update` and reconnect"
    );
    assert_eq!(
        error.version_mismatch(),
        Some(VersionMismatch::DaemonOutdated {
            server_version: Some("0.8.0".into())
        })
    );
}

#[test]
fn missing_capabilities_and_newer_generations_point_at_the_right_side() {
    let missing = choose(&[
        r#"{"version":"0.9.0","endpoint_protocol_generation":1,"endpoint_capabilities":["surface_interest"]}"#,
    ])
    .unwrap_err();
    assert!(matches!(
        missing.version_mismatch(),
        Some(VersionMismatch::DaemonOutdated { .. })
    ));
    let newer = choose(&[
        r#"{"version":"2.0.0","endpoint_protocol_generation":2,"endpoint_capabilities":[]}"#,
    ])
    .unwrap_err();
    assert_eq!(
        newer.version_mismatch(),
        Some(VersionMismatch::ClientOutdated {
            server_version: Some("2.0.0".into())
        })
    );
    assert!(newer.to_string().ends_with("update Herdr GPUI"), "{newer}");
}

#[test]
fn a_later_compatible_install_still_wins_and_no_install_stays_closed() {
    choose(&[r#"{"version":"0.8.0","endpoint_capabilities":[]}"#, CURRENT]).unwrap();
    let error = choose(&[]).unwrap_err();
    assert!(matches!(error, Error::SshClosed));
    assert_eq!(error.version_mismatch(), None);
}
