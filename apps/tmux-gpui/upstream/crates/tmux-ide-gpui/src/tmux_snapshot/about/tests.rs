#![allow(clippy::unwrap_used)]
use super::{CONNECTION_LABEL, channel, connection_line, version_line};
use crate::tmux_snapshot::diagnostics::Versions;

fn versions(daemon: Option<&str>, tmux: Option<&str>) -> Versions {
    serde_json::from_value(serde_json::json!({"daemonVersion": daemon, "tmuxVersion": tmux}))
        .unwrap()
}

#[test]
fn the_version_line_reads_the_bundle_or_says_development() {
    assert_eq!(
        version_line(Some("0.1.16"), Some("2026111101")),
        "Version 0.1.16 (2026111101)"
    );
    assert_eq!(version_line(Some("0.1.16"), None), "Version 0.1.16");
    assert_eq!(version_line(None, Some("1")), "Development build");
    assert_eq!(version_line(None, None), "Development build");
}

#[test]
fn the_channel_tag_comes_from_the_identifier() {
    assert_eq!(channel(Some("com.tmux-ide.gpui.alpha")), Some("Alpha"));
    assert_eq!(channel(Some("com.tmux-ide.gpui.preview")), Some("Preview"));
    assert_eq!(channel(Some("com.tmux-ide.gpui.development")), None);
    assert_eq!(channel(Some("com.tmux-ide.gpui")), None);
    assert_eq!(channel(None), None);
}

#[test]
fn the_connection_line_never_shows_a_version_it_does_not_hold() {
    let live = versions(Some("2.9.22"), Some("3.5a"));
    assert_eq!(
        connection_line(Some(&live), true),
        "tmux-ide 2.9.22 · tmux 3.5a"
    );
    let no_tmux = versions(Some("2.9.22"), None);
    assert_eq!(connection_line(Some(&no_tmux), true), "tmux-ide 2.9.22");
    assert_eq!(connection_line(None, false), "Not connected");
    assert_eq!(
        connection_line(None, true),
        "Connected · open a terminal to see its version"
    );
    let unknown = versions(None, Some("3.5a"));
    assert_eq!(connection_line(Some(&unknown), false), "Not connected");
}

#[test]
fn the_icon_is_the_app_icon_at_128_px() {
    let bytes = include_bytes!("../../../../../assets/about/app-icon-128.png");
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    // IHDR: width and height, big-endian, after the signature and chunk head.
    assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 128);
    assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 128);
}

#[test]
fn about_says_background_service_not_daemon() {
    assert_eq!(CONNECTION_LABEL, "CLI and background service");
    let live = versions(Some("2.9.22"), Some("3.5a"));
    for text in [
        CONNECTION_LABEL.to_owned(),
        connection_line(Some(&live), true),
        connection_line(None, true),
        connection_line(None, false),
    ] {
        assert!(!text.to_lowercase().contains("daemon"), "{text}");
    }
}
