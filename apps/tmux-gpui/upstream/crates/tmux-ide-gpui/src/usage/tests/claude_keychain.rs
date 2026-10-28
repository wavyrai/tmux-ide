use super::*;
use crate::usage::{probe::Shell, providers::claude};

/// A Mac whose keychain answers a lookup by service alone with `root`'s item,
/// which holds only MCP sign-ins, as one `sudo claude` leaves behind. Only
/// `alice` has a Claude sign-in.
fn mac(user: &str) -> (tempfile::TempDir, Shell) {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let bin = home.join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    crate::test_executable::write(bin.join("uname"), "#!/bin/sh\necho Darwin\n", 0o755).unwrap();
    crate::test_executable::write(
        bin.join("security"),
        concat!(
            "#!/bin/sh\n",
            "case \"$*\" in\n",
            "  *'-a alice'*) printf '%s' '{\"claudeAiOauth\":{\"accessToken\":\"alice-token\",\"subscriptionType\":\"max\"}}' ;;\n",
            "  *' -a '*) exit 44 ;;\n",
            "  *) printf '%s' '{\"mcpOAuth\":{}}' ;;\n",
            "esac\n",
        ),
        0o755,
    )
    .unwrap();
    let mut command = std::process::Command::new("/bin/sh");
    command
        .arg("-s")
        .env_clear()
        .env("HOME", &home)
        .env("USER", user)
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    (root, Shell::start(command).unwrap())
}

#[test]
fn claude_reads_the_users_own_keychain_item() {
    let mut jar = CookieJar::default();
    let (_root, shell) = mac("alice");
    let mut exec = Exec::Remote(shell);
    let mut probe = Probe::new(
        &mut exec,
        provider("claude"),
        None,
        &mut jar,
        Consent::Quiet,
    );
    let credentials = claude::keychain(&mut probe).unwrap();
    assert_eq!(
        probe
            .text(&credentials, &["claudeAiOauth", "subscriptionType"])
            .as_deref(),
        Some("max")
    );

    let (_root, shell) = mac("carol");
    let mut exec = Exec::Remote(shell);
    let mut probe = Probe::new(
        &mut exec,
        provider("claude"),
        None,
        &mut jar,
        Consent::Quiet,
    );
    assert!(
        claude::keychain(&mut probe).is_none(),
        "an item without a Claude sign-in is still skipped"
    );
}
