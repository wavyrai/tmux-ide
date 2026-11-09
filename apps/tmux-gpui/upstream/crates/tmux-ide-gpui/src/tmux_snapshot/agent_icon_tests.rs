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

fn pane(
    label: &str,
    source: Option<crate::tmux_snapshot::browser::NameSource>,
) -> crate::tmux_snapshot::browser::Choice {
    crate::tmux_snapshot::browser::Choice {
        pane_count: None,
        id: "pane".into(),
        label: label.into(),
        window_id: None,
        window_label: None,
        browser_icon: None,
        display_name_source: source,
    }
}

#[test]
fn a_panes_kind_comes_from_the_roster_or_how_the_daemon_named_it() {
    use crate::tmux_snapshot::browser::NameSource::*;
    assert_eq!(
        kind(Some("claude-code"), Some(&pane("nvim", Some(Process)))),
        Kind::Agent("icons/agent-claude.svg")
    );
    for (label, source, expected) in [
        ("nvim", Some(Process), Kind::Neovim),
        ("vim", Some(Process), Kind::Neovim),
        ("pane_chrome.rs - NVIM", Some(Title), Kind::Neovim),
        ("htop", Some(Process), Kind::Other),
        ("brisk-otter", Some(Generated), Kind::Shell),
        ("cargo test", Some(Title), Kind::Shell),
        // A name the user typed never decides the kind.
        ("nvim", Some(Manual), Kind::Shell),
        ("nvim", None, Kind::Shell),
    ] {
        assert_eq!(kind(None, Some(&pane(label, source))), expected, "{label}");
    }
    assert_eq!(kind(None, None), Kind::Shell);
    for kind in [Kind::Neovim, Kind::Shell, Kind::Other] {
        assert!(crate::icons::Icons.load(kind.icon()).unwrap().is_some());
    }
}
