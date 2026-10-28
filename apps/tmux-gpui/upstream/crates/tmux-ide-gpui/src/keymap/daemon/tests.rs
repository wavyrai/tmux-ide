use super::*;

fn keys(text: &str) -> DaemonKeys {
    let table: toml::Table = text.parse().unwrap();
    DaemonKeys::from_table(table.get("keys").and_then(toml::Value::as_table))
}

fn parsed(text: &str) -> Keystroke {
    Keystroke::parse(text).unwrap()
}

fn prefixed(key: &str) -> Trigger {
    Trigger::Prefixed(parsed(key))
}

fn bound(keys: &DaemonKeys, command: Command) -> Vec<Trigger> {
    keys.bindings
        .iter()
        .filter(|(bound, _)| *bound == command)
        .map(|(_, trigger)| trigger.clone())
        .collect()
}

#[test]
fn keystrokes_translate_herdr_spelling() {
    for (herdr, gpui) in [
        ("ctrl+b", "ctrl-b"),
        ("Control+Shift+N", "ctrl-shift-n"),
        ("N", "shift-n"),
        ("option+1", "alt-1"),
        ("meta+x", "alt-x"),
        ("cmd+t", "cmd-t"),
        ("super+t", "cmd-t"),
        ("minus", "-"),
        ("\\", "\\"),
        ("backslash", "\\"),
        ("?", "?"),
        ("[", "["),
        ("shift+tab", "shift-tab"),
        ("esc", "escape"),
        ("return", "enter"),
        ("space", "space"),
        ("f12", "f12"),
        ("f", "f"),
    ] {
        assert_eq!(keystroke(herdr), Some(parsed(gpui)), "{herdr}");
    }
    for invalid in [
        "", "ctrl+", "ctrl++b", "a+b", "hyper+x", "f0", "f99", "nope",
    ] {
        assert_eq!(keystroke(invalid), None, "{invalid}");
    }
}

#[test]
fn defaults_match_herdr() {
    let keys = DaemonKeys::default();
    assert_eq!(keys.prefixes, [parsed("ctrl-b")]);
    assert_eq!(bound(&keys, Command::SplitRight), [prefixed("v")]);
    assert_eq!(bound(&keys, Command::SplitDown), [prefixed("-")]);
    assert_eq!(bound(&keys, Command::Keybinds), [prefixed("?")]);
    assert_eq!(bound(&keys, Command::Workspace), [prefixed("shift-n")]);
    assert_eq!(
        bound(&keys, Command::WorkspacePicker),
        [prefixed("w"), prefixed("g")]
    );
    assert_eq!(bound(&keys, Command::PreviousPane), [prefixed("shift-tab")]);
    for digit in 1..=9 {
        let key = prefixed(&digit.to_string());
        assert_eq!(bound(&keys, Command::TabNumber(digit)), [key]);
    }
    assert!(bound(&keys, Command::ClearPane).is_empty());
    assert_eq!(keys, DaemonKeys::from_table(Some(&toml::Table::new())));
}

#[test]
fn the_issue_example_reads_as_written() {
    let keys = keys(
        r#"
            [keys]
            prefix = "ctrl+a"
            split_vertical = ["prefix+v", "prefix+\\"]
            focus_pane_left = ["prefix+h", "prefix+left"]
            switch_tab = ["prefix+1..9", "alt+1..9"]
            "#,
    );
    assert_eq!(keys.prefixes, [parsed("ctrl-a")]);
    assert_eq!(
        bound(&keys, Command::SplitRight),
        [
            Trigger::Prefixed(parsed("v")),
            Trigger::Prefixed(parsed("\\"))
        ]
    );
    assert_eq!(
        bound(&keys, Command::FocusLeft),
        [
            Trigger::Prefixed(parsed("h")),
            Trigger::Prefixed(parsed("left"))
        ]
    );
    assert_eq!(
        bound(&keys, Command::TabNumber(3)),
        [
            Trigger::Prefixed(parsed("3")),
            Trigger::Direct(parsed("alt-3"))
        ]
    );
    // Actions the file leaves alone keep Herdr's defaults.
    assert_eq!(bound(&keys, Command::Tab), [Trigger::Prefixed(parsed("c"))]);
}

#[test]
fn a_server_profile_reads_like_the_local_table() {
    let profile = r#"
            [keys]
            prefix = "ctrl+a"
            extra_prefixes = ["ctrl+s"]
            split_vertical = ["prefix+v", "prefix+\\"]
            switch_tab = "alt+1..9"
            "#;
    let keys = DaemonKeys::from_profile(Some(profile)).unwrap();
    assert_eq!(keys, self::keys(profile));
    // Herdr publishes every prefix after the first as `extra_prefixes`.
    assert_eq!(keys.prefixes, [parsed("ctrl-a"), parsed("ctrl-s")]);
    assert_eq!(
        bound(&keys, Command::TabNumber(2)),
        [Trigger::Direct(parsed("alt-2"))]
    );
    // An empty published table is Herdr's defaults, not a failure.
    assert_eq!(
        DaemonKeys::from_profile(Some("[keys]\n")).unwrap(),
        DaemonKeys::default()
    );
}

#[test]
fn an_unusable_server_profile_is_an_error() {
    assert!(matches!(
        DaemonKeys::from_profile(None),
        Err(Error::ServerKeybindingsMissing)
    ));
    assert!(matches!(
        DaemonKeys::from_profile(Some("[keys\n")),
        Err(Error::ServerKeybindingsParse(_))
    ));
    for profile in ["", "prefix = 'ctrl+a'", "keys = 'ctrl+a'"] {
        assert!(
            matches!(
                DaemonKeys::from_profile(Some(profile)),
                Err(Error::ServerKeybindingsNoKeys)
            ),
            "{profile:?}"
        );
    }
    let oversized = format!("[keys]\n{}", "# pad\n".repeat(MAX_PROFILE_BYTES / 6 + 1));
    assert!(matches!(
        DaemonKeys::from_profile(Some(&oversized)),
        Err(Error::ServerKeybindingsTooLarge {
            max: MAX_PROFILE_BYTES
        })
    ));
    let error = DaemonKeys::from_profile(Some("[keys\n")).unwrap_err();
    assert!(std::error::Error::source(&error).is_some());
}

#[test]
fn unusable_entries_are_skipped_not_fatal() {
    let keys = keys(
        r#"
            [keys]
            prefix = "hyper+a"
            new_tab = ""
            next_tab = ["prefix+hyper+n", "prefix+n"]
            close_tab = 5
            fullscreen = "prefix+f"
            switch_tab = ["prefix+0", "prefix+4", "prefix+x"]
            reload_config = "prefix+r"
            "#,
    );
    // A prefix this client cannot express falls back to ctrl+b.
    assert_eq!(keys.prefixes, [parsed("ctrl-b")]);
    assert!(bound(&keys, Command::Tab).is_empty());
    assert_eq!(
        bound(&keys, Command::NextTab),
        [Trigger::Prefixed(parsed("n"))]
    );
    assert_eq!(
        bound(&keys, Command::CloseTab),
        [Trigger::Prefixed(parsed("shift-x"))]
    );
    assert_eq!(
        bound(&keys, Command::Zoom),
        [Trigger::Prefixed(parsed("f"))]
    );
    assert_eq!(
        bound(&keys, Command::TabNumber(4)),
        [Trigger::Prefixed(parsed("4"))]
    );
    assert!(bound(&keys, Command::TabNumber(1)).is_empty());
}

#[test]
fn layout_and_navigation_actions_take_herdr_defaults() {
    let keys = DaemonKeys::default();
    for (command, key) in [
        (Command::RenameWorkspace, "shift-w"),
        (Command::CloseWorkspace, "shift-d"),
        (Command::ReloadConfig, "shift-r"),
        (Command::RenameTab, "shift-t"),
        (Command::RenamePane, "shift-p"),
        (Command::SwapLeft, "shift-h"),
        (Command::SwapDown, "shift-j"),
        (Command::SwapUp, "shift-k"),
        (Command::SwapRight, "shift-l"),
        (Command::ResizeMode, "r"),
        (Command::EditScrollback, "e"),
        (Command::CopyMode, "["),
    ] {
        assert_eq!(bound(&keys, command), [prefixed(key)], "{command:?}");
    }
    // Herdr leaves these unset until the user binds them.
    for command in [
        Command::MoveTabPrevious,
        Command::MoveTabNext,
        Command::ResizeLeft,
        Command::ResizeRight,
        Command::ResizeUp,
        Command::ResizeDown,
        Command::LastPane,
        Command::PreviousWorkspace,
        Command::NextWorkspace,
        Command::WorkspaceNumber(1),
        Command::PreviousAgent,
        Command::NextAgent,
        Command::AgentNumber(1),
    ] {
        assert!(bound(&keys, command).is_empty(), "{command:?}");
    }
    assert_eq!(keys.navigate_up, [parsed("up")]);
    assert_eq!(keys.navigate_down, [parsed("down")]);
}

#[test]
fn configured_actions_bind_and_indexed_actions_count_digits() {
    let keys = keys(
        r#"
            [keys]
            move_tab_previous = "alt+shift+["
            move_tab_next = "alt+shift+]"
            resize_pane_left = ["prefix+alt+h", "ctrl+alt+left"]
            last_pane = "prefix+;"
            previous_workspace = "ctrl+alt+k"
            next_agent = "prefix+a"
            switch_workspace = "prefix+alt+1..9"
            focus_agent = ["ctrl+1", "ctrl+2"]
            navigate_workspace_up = ["k", "ctrl+p", "prefix+p"]
            "#,
    );
    assert_eq!(
        bound(&keys, Command::MoveTabPrevious),
        [Trigger::Direct(parsed("alt-shift-["))]
    );
    assert_eq!(
        bound(&keys, Command::MoveTabNext),
        [Trigger::Direct(parsed("alt-shift-]"))]
    );
    assert_eq!(
        bound(&keys, Command::ResizeLeft),
        [prefixed("alt-h"), Trigger::Direct(parsed("ctrl-alt-left"))]
    );
    assert_eq!(bound(&keys, Command::LastPane), [prefixed(";")]);
    assert_eq!(
        bound(&keys, Command::PreviousWorkspace),
        [Trigger::Direct(parsed("ctrl-alt-k"))]
    );
    assert_eq!(bound(&keys, Command::NextAgent), [prefixed("a")]);
    for digit in 1..=9 {
        let key = prefixed(&format!("alt-{digit}"));
        assert_eq!(bound(&keys, Command::WorkspaceNumber(digit)), [key]);
    }
    assert_eq!(
        bound(&keys, Command::AgentNumber(2)),
        [Trigger::Direct(parsed("ctrl-2"))]
    );
    assert!(bound(&keys, Command::AgentNumber(3)).is_empty());
    // Navigate mode takes no prefix chords.
    assert_eq!(keys.navigate_up, [parsed("k"), parsed("ctrl-p")]);
    assert_eq!(keys.navigate_down, [parsed("down")]);
}

/// `[keys.indexed]` names a modifier combo for the digits 1-9. Like
/// Herdr, it displaces the action's default unless the action is set too.
#[test]
fn legacy_indexed_combos_bind_digits() {
    let keys = keys(
        r#"
            [keys]
            switch_workspace = "prefix+alt+1..9"
            [keys.indexed]
            tabs = "alt"
            workspaces = "ctrl+shift"
            agents = "  "
            "#,
    );
    for digit in 1..=9 {
        let key = |text: String| Trigger::Direct(parsed(&text));
        assert_eq!(
            bound(&keys, Command::TabNumber(digit)),
            [key(format!("alt-{digit}"))]
        );
        assert_eq!(
            bound(&keys, Command::WorkspaceNumber(digit)),
            [
                prefixed(&format!("alt-{digit}")),
                key(format!("ctrl-shift-{digit}"))
            ]
        );
        assert!(bound(&keys, Command::AgentNumber(digit)).is_empty());
    }
    // A combo Herdr cannot read binds nothing, yet still displaces.
    let hyper = self::keys("[keys.indexed]\ntabs = \"hyper\"");
    assert!(bound(&hyper, Command::TabNumber(1)).is_empty());
}

/// Herdr drops a default that collides with a binding the user wrote, so
/// user bindings come first and win the keymap's first-come keystroke.
#[test]
fn user_bindings_precede_defaults() {
    let keys = keys(
        r#"
            [keys]
            reload_config = "prefix+r"
            "#,
    );
    let first = keys
        .bindings
        .iter()
        .position(|(_, trigger)| *trigger == prefixed("r"))
        .unwrap();
    assert_eq!(keys.bindings[first].0, Command::ReloadConfig);
    assert_eq!(bound(&keys, Command::ResizeMode), [prefixed("r")]);
    let keymap =
        super::super::Keymap::with_overrides(&Default::default(), &Default::default(), &keys)
            .unwrap();
    assert_eq!(keymap.chord(&parsed("r")), Some(Command::ReloadConfig));
}

#[test]
fn a_prefix_list_keeps_every_key_in_order() {
    let keys = keys(
        r#"
            [keys]
            prefix = ["ctrl+space", "ctrl+s"]
            "#,
    );
    assert_eq!(keys.prefixes, [parsed("ctrl-space"), parsed("ctrl-s")]);
    // Prefixed actions do not depend on which prefix armed them.
    assert_eq!(bound(&keys, Command::Tab), [prefixed("c")]);
}

#[test]
fn prefix_lists_follow_herdr_validation() {
    let prefixes = |value: &str| keys(&format!("[keys]\nprefix = {value}")).prefixes;
    // Invalid entries are dropped while valid ones survive.
    assert_eq!(prefixes(r#"["ctrl+a", "wat", ""]"#), [parsed("ctrl-a")]);
    // Later duplicates, however spelled, are ignored.
    assert_eq!(
        prefixes(r#"["ctrl+a", " Control+a ", "f12", "ctrl+a"]"#),
        [parsed("ctrl-a"), parsed("f12")]
    );
    // An empty list, or one with nothing usable, keeps the default.
    assert_eq!(prefixes("[]"), [parsed("ctrl-b")]);
    assert_eq!(prefixes(r#"["wat", "hyper+a"]"#), [parsed("ctrl-b")]);
    // Herdr rejects a list of anything but strings, as does a number.
    assert_eq!(prefixes(r#"["ctrl+a", 5]"#), [parsed("ctrl-b")]);
    assert_eq!(prefixes("5"), [parsed("ctrl-b")]);
}

#[test]
fn published_extra_prefixes_follow_the_primary() {
    let keys = keys(
        r#"
            [keys]
            prefix = "ctrl+a"
            extra_prefixes = ["ctrl+s", "ctrl+a"]
            "#,
    );
    assert_eq!(keys.prefixes, [parsed("ctrl-a"), parsed("ctrl-s")]);
}
