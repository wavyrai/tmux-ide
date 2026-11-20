#![allow(clippy::unwrap_used)]
use super::*;

fn said(stderr: &str) -> Option<String> {
    Said::from_stderr(stderr.as_bytes()).line().map(Into::into)
}

/// ssh's own reasons come through as ssh wrote them.
#[test]
fn ssh_s_own_reasons_come_through() {
    for line in [
        "ssh: connect to host spark port 22: No route to host",
        "ssh: connect to host 192.168.178.12 port 2222: Connection refused",
        "ssh: connect to host spark.local port 22: Operation timed out",
        "ssh: connect to host spark port 22: Network is unreachable",
        "ssh: connect to host spark port 22: Connection timed out",
        "ssh: Could not resolve hostname spark: nodename nor servname provided, or not known",
        "ssh: Could not resolve hostname spark: Name or service not known",
        "ssh: Could not resolve hostname spark: Temporary failure in name resolution",
        "Host key verification failed.",
        "kex_exchange_identification: read: Connection reset by peer",
        "kex_exchange_identification: Connection closed by remote host",
        "Connection closed by 10.0.0.2 port 22",
        "Connection reset by 10.0.0.2 port 22",
        "Connection timed out during banner exchange",
        "channel 0: open failed: connect failed: No route to host",
    ] {
        assert_eq!(said(line).as_deref(), Some(line), "{line}");
        assert_eq!(said(&format!("{line}\r\n")).as_deref(), Some(line));
    }
}

/// "Permission denied" keeps ssh's words and the methods it tried, never
/// the user and host before them or anything after.
#[test]
fn permission_denied_keeps_the_methods_only() {
    assert_eq!(
        said("thijs@spark: Permission denied (publickey,password).").as_deref(),
        Some("Permission denied (publickey,password).")
    );
    assert_eq!(
        said("Permission denied (publickey). secret").as_deref(),
        Some("Permission denied (publickey).")
    );
    assert_eq!(said("Permission denied (rm -rf /)."), None);
}

/// The remote command's own stderr, and anything not in ssh's forms, never
/// comes through: not as a reason and not inside one.
#[test]
fn nothing_but_ssh_s_forms_comes_through() {
    for stderr in [
        "",
        "secret",
        "curl: (7) Failed to connect to localhost port 8080: Connection refused",
        "Error: getaddrinfo: Could not resolve hostname db",
        "  ssh: connect to host spark port 22: Connection refused",
        "ssh: connect to host spark port 22: token=abc123",
        "ssh: connect to host sp ark port 22: Connection refused",
        "ssh: connect to host spark port 22x: Connection refused",
        "ssh: Could not resolve hostname spark: $(id)",
        "Host key verification failed. secret",
        "Connection closed by 10.0.0.2 port 22 secret",
        "channel 0: open failed: administratively prohibited: open failed",
        "kex_exchange_identification: banner line contains invalid characters",
        "tmux-ide: command not found",
    ] {
        assert_eq!(said(stderr), None, "{stderr}");
    }
}

/// The last of ssh's lines is its reason, as ssh writes its fatal error
/// last; a host key or authentication failure wins, as the classification
/// reads them first.
#[test]
fn the_reason_is_ssh_s_last_line_and_auth_and_host_keys_come_first() {
    assert_eq!(
        said(
            "channel 0: open failed: connect failed: Connection refused\r\n\
             stdio forwarding failed\r\n\
             Connection closed by UNKNOWN port 65535\r\n"
        )
        .as_deref(),
        Some("channel 0: open failed: connect failed: Connection refused")
    );
    assert_eq!(
        said("remote noise\nssh: connect to host spark port 22: No route to host\nmore noise")
            .as_deref(),
        Some("ssh: connect to host spark port 22: No route to host")
    );
    assert_eq!(
        said(
            "ssh: connect to host spark port 22: Connection refused\n\
             user@spark: Permission denied (publickey)."
        )
        .as_deref(),
        Some("Permission denied (publickey).")
    );
    assert_eq!(
        said(
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
             @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n\
             Host key verification failed.\n"
        )
        .as_deref(),
        Some("Host key verification failed.")
    );
}

/// A failed discovery carries ssh's reason; its Debug and Display never
/// carry anything else the process wrote.
#[test]
fn a_failed_discovery_carries_only_ssh_s_reason() {
    let mut diagnostics = super::super::discovery::Diagnostics::default();
    diagnostics.observe(b"secret\nssh: connect to host spark port 22: No route to host\n");
    let error = diagnostics.failure();
    assert_eq!(
        error.said(),
        Some("ssh: connect to host spark port 22: No route to host")
    );
    assert!(!format!("{error:?} {error}").contains("secret"));
    let mut diagnostics = super::super::discovery::Diagnostics::default();
    diagnostics.observe(b"secret only\n");
    let error = diagnostics.failure();
    assert_eq!(error.said(), None);
    assert!(!format!("{error:?} {error}").contains("secret"));
}
