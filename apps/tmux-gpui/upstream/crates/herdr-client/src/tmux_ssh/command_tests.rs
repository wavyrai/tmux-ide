#![allow(clippy::unwrap_used)]
use super::*;
fn args(c: &Command) -> Vec<String> {
    c.get_args()
        .map(|s| s.to_str().unwrap().to_owned())
        .collect()
}
#[test]
fn destination_accepts_aliases_and_rejects_shell_or_option_syntax() {
    for target in [
        "mini",
        "user@mini.example",
        "_host",
        "user@[::1]",
        "[fe80::1234]",
    ] {
        assert!(SshTarget::parse(target).is_ok());
    }
    for target in [
        "",
        "-oProxyCommand=evil",
        "user@host:22",
        "a b",
        "a\nb",
        "$(whoami)",
        "host;id",
        "a@b@c",
        "user@",
        "'host'",
    ] {
        assert!(SshTarget::parse(target).is_err());
    }
    assert!(SshTarget::parse(&"x".repeat(256)).is_err());
}
#[test]
fn discovery_is_fixed_read_only_and_honors_ssh_destination_boundary() {
    let command = discovery_command(&SshTarget::parse("user@jumped-host").unwrap());
    assert_eq!(command.get_program(), "ssh");
    let args = args(&command);
    assert_eq!(
        &args[args.len() - 3..args.len() - 1],
        &["--", "user@jumped-host"]
    );
    let script = args.last().unwrap();
    assert!(script.contains("remote-daemon-info --json"));
    assert!(!script.contains("update --daemon"));
    assert!(!script.contains("source "));
    assert!(args.iter().any(|s| s == "BatchMode=yes"));
    assert!(args.iter().any(|s| s == "ForkAfterAuthentication=no"));
}
#[test]
fn owned_forward_normalizes_wildcard_binds_without_exposing_credentials() {
    for (bind, forward) in [
        ("0.0.0.0", "127.0.0.1:1234:127.0.0.1:4111"),
        ("::", "127.0.0.1:1234:[::1]:4111"),
        ("localhost", "127.0.0.1:1234:localhost:4111"),
    ] {
        let descriptor = RemoteDescriptor::parse(&serde_json::to_vec(&serde_json::json!({"version":1,"daemon":{"pid":123,"port":4111,"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z","bindHostname":bind,"authToken":"secret-fixture"}})).unwrap(), None).unwrap();
        let target = SshTarget::parse("host").unwrap();
        let command = tunnel_command(&target, 1234, &descriptor).unwrap();
        let args = args(&command);
        for expected in [
            forward,
            "ControlPath=none",
            "ControlMaster=no",
            "ForkAfterAuthentication=no",
            "ExitOnForwardFailure=yes",
        ] {
            assert!(args.iter().any(|a| a == expected));
        }
        assert!(!args.iter().any(|s| s.contains("secret-fixture")));
        assert!(matches!(
            tunnel_command(&target, 0, &descriptor),
            Err(Error::Port)
        ));
    }
}
