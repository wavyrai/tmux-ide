#![allow(clippy::unwrap_used)]
use super::*;
use gpui::AssetSource;

#[test]
fn daemon_harness_ids_resolve_to_embedded_marks() {
    for (harness, expected) in [
        ("claude-code", "icons/agent-claude.svg"),
        ("claude", "icons/agent-claude.svg"),
        ("codex", "icons/agent-codex.svg"),
        ("gemini", "icons/agent-gemini.svg"),
        ("opencode", "icons/agent-opencode.svg"),
    ] {
        let asset = path(Some(harness));
        assert_eq!(asset, expected);
        assert!(crate::icons::Icons.load(asset).unwrap().is_some());
    }
}

#[test]
fn unknown_identity_never_guesses_a_brand_from_a_display_name() {
    for identity in [
        None,
        Some("custom"),
        Some(""),
        Some("Claude"),
        Some("codex project"),
        Some("claude-code\0"),
    ] {
        assert_eq!(path(identity), "icons/terminal.svg");
    }
    assert!(crate::icons::Icons.load(path(None)).unwrap().is_some());
}
