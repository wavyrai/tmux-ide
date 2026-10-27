#![allow(clippy::unwrap_used)]
use super::*;

fn access(command: &str, token: &str) -> SshAccess {
    serde_json::from_value(serde_json::json!({ "token": token, "sshCommand": command })).unwrap()
}

#[test]
fn daytona_ssh_commands_are_read_not_run() {
    assert_eq!(
        endpoint("ssh tok-1@ssh.app.daytona.io", "tok-1").unwrap(),
        Endpoint {
            host: "ssh.app.daytona.io".into(),
            port: 22
        }
    );
    assert_eq!(
        endpoint("ssh -p 2222 tok@localhost", "tok").unwrap(),
        Endpoint {
            host: "localhost".into(),
            port: 2222
        }
    );
    for command in [
        "ssh other@ssh.app.daytona.io",
        "ssh -o ProxyCommand=x tok@host",
        "ssh tok@host; rm -rf ~",
        "ssh tok@-oProxyCommand=x",
        "ssh -p 0 tok@host",
        "ssh -p tok@host",
        "scp tok@host",
        "ssh tok@host extra",
        "ssh",
    ] {
        assert!(endpoint(command, "tok").is_err(), "{command}");
    }
    assert!(endpoint("ssh a\nb@host", "a\nb").is_err());
}

#[test]
fn the_token_stays_out_of_argv_and_the_users_config_is_bypassed() {
    let dir = tempfile::tempdir().unwrap();
    let known = dir.path().join("state").join("daytona_known_hosts");
    let gateway = Gateway::new(
        &access("ssh -p 2200 secret-tok@gw.example.com", "secret-tok"),
        &known,
    )
    .unwrap();
    let args: Vec<_> = gateway
        .command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args[0], "-F");
    assert_eq!(&args[2..], ["-T", "--", ALIAS]);
    assert!(!args.iter().any(|arg| arg.contains("secret-tok")));
    let config = std::fs::read_to_string(&args[1]).unwrap();
    assert!(config.contains("\tUser secret-tok\n"));
    assert!(config.contains("\tHostName gw.example.com\n\tPort 2200\n"));
    assert!(config.contains("StrictHostKeyChecking accept-new"));
    assert!(config.contains(&format!("UserKnownHostsFile \"{}\"", known.display())));
    assert!(known.parent().unwrap().is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&args[1]).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "the config is private");
    }
    let path = args[1].clone();
    drop(gateway);
    assert!(!Path::new(&path).exists(), "dropping removes it");
}
