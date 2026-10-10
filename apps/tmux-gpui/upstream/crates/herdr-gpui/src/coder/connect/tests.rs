#![allow(clippy::unwrap_used)]
use super::*;
use crate::coder::tests::settings;

#[test]
fn coder_ssh_carries_the_token_only_in_the_child_environment() {
    let command = ssh_command(
        Path::new("/usr/local/bin/coder"),
        &settings(),
        &"token-fixture".into(),
        "herdr-box",
        "main",
    )
    .unwrap();
    let args: Vec<_> = command.get_args().map(|a| a.to_str().unwrap()).collect();
    assert_eq!(args, ["ssh", "--wait=no", "--", "herdr-box.main"]);
    assert!(!args.iter().any(|arg| arg.contains("token-fixture")));
    let envs: std::collections::HashMap<_, _> = command
        .get_envs()
        .map(|(k, v)| (k.to_str().unwrap(), v.unwrap().to_str().unwrap()))
        .collect();
    assert_eq!(envs["CODER_SESSION_TOKEN"], "token-fixture");
    assert_eq!(envs["CODER_URL"], "https://coder.example.com");
    // Workspaces created outside this app may use uppercase.
    assert!(
        ssh_command(
            Path::new("coder"),
            &settings(),
            &"t".into(),
            "DevBox",
            "main"
        )
        .is_ok()
    );
    for (workspace, agent) in [("-oops", "main"), ("herdr-box", "a.b"), ("herdr-box", "")] {
        assert!(
            ssh_command(
                Path::new("coder"),
                &settings(),
                &"t".into(),
                workspace,
                agent
            )
            .is_err()
        );
    }
}

// Windows checks only that the file exists; this test covers permissions.
#[cfg(unix)]
#[test]
fn a_configured_cli_path_wins_over_discovery_only_when_it_can_run() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("coder");
    let mut settings = settings();
    settings.cli = Some(path.clone());
    assert!(matches!(cli(&settings), Err(Error::Cli)), "missing");
    std::fs::write(&path, "#!/bin/sh\n").unwrap();
    assert!(matches!(cli(&settings), Err(Error::Cli)), "not executable");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(cli(&settings).unwrap(), path);
}
