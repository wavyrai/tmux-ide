use super::*;

#[test]
fn forwarding_binds_only_loopback_and_keeps_the_bridge_policy() {
    let command = forward_command("user@host", 41000, 3000).unwrap();
    let args: Vec<_> = command.get_args().map(|a| a.to_str().unwrap()).collect();
    for option in [
        "-N",
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ControlMaster=no",
        "ExitOnForwardFailure=yes",
        "127.0.0.1:41000:localhost:3000",
        "ControlPath=none",
        "PermitLocalCommand=yes",
        "LocalCommand=echo herdr-forward-ready",
    ] {
        assert!(args.contains(&option), "{option} missing from {args:?}");
    }
    // Clearing forwardings would clear this one too.
    assert!(!args.contains(&"ClearAllForwardings=yes"));
    assert_eq!(args[args.len() - 2], "--");
    assert_eq!(args[args.len() - 1], "user@host");
    assert!(forward_command("-oProxyCommand=bad", 1, 2).is_err());
    // The bridge itself still forwards nothing.
    let bridge: Vec<String> = command_for("user@host")
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert!(bridge.contains(&"ClearAllForwardings=yes".to_owned()));
}

fn command_for(target: &str) -> Command {
    command(target, "true")
}
