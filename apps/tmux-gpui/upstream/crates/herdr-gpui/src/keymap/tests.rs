use super::*;
use herdr_client::protocol::ClientShellCommand;

mod custom_reference;

fn overrides(entries: &[(&str, Binding)]) -> BTreeMap<String, Binding> {
    entries
        .iter()
        .map(|(name, binding)| ((*name).to_owned(), binding.clone()))
        .collect()
}

fn one(keystroke: &str) -> Binding {
    Binding::One(keystroke.into())
}

fn keystroke(text: &str) -> Keystroke {
    Keystroke::parse(text).unwrap()
}

/// A daemon config that binds nothing, isolating the GUI layers.
fn no_keys() -> DaemonKeys {
    DaemonKeys {
        prefixes: vec![keystroke("ctrl-b")],
        bindings: Vec::new(),
        navigate_up: Vec::new(),
        navigate_down: Vec::new(),
    }
}

fn with(entries: &[(&str, Binding)]) -> Result<Keymap> {
    Keymap::with_overrides(&overrides(entries), &PaneKeys::new(), &no_keys())
}

fn list(keymap: &Keymap, command: Command) -> Vec<&str> {
    keymap.shortcuts(command).collect()
}

#[test]
fn defaults_follow_the_catalog_and_herdr() {
    let keymap = Keymap::default();
    assert_eq!(list(&keymap, Command::Tab), ["cmd-t", "ctrl-b c"]);
    assert_eq!(keymap.primary(Command::Tab), "cmd-t");
    assert_eq!(keymap.primary(Command::Workspace), "cmd-shift-n");
    assert_eq!(keymap.primary(Command::Themes), "");
    assert_eq!(
        list(&keymap, Command::SplitDown),
        ["cmd-shift-d", "ctrl-b -"]
    );
    assert_eq!(
        Keymap::with_overrides(
            &BTreeMap::new(),
            &Default::default(),
            &DaemonKeys::default()
        )
        .unwrap(),
        Keymap::default()
    );
    // Herdr's defaults are all chords, so GPUI binds only the catalog.
    let bound: usize = COMMANDS.iter().map(|info| info.shortcuts.len()).sum();
    assert_eq!(keymap.bindings().count(), bound);
    assert!(
        keymap
            .bindings()
            .all(|(_, keystroke)| !keystroke.contains(' '))
    );
}

#[test]
fn overrides_replace_lists_and_empty_values_unbind() {
    let keymap = with(&[
        ("new_workspace", one("cmd-alt-t")),
        (
            "themes",
            Binding::Many(vec!["ctrl-shift-t".into(), " cmd-k ".into()]),
        ),
        ("close_pane", one("")),
        ("toggle_sidebar", Binding::Many(Vec::new())),
    ])
    .unwrap();
    assert_eq!(list(&keymap, Command::Workspace), ["cmd-alt-t"]);
    assert_eq!(list(&keymap, Command::Themes), ["ctrl-shift-t", "cmd-k"]);
    assert!(list(&keymap, Command::ClosePane).is_empty());
    assert!(list(&keymap, Command::ToggleSidebar).is_empty());
    assert_eq!(list(&keymap, Command::Tab), ["cmd-t"]);
}

/// Taking a default keystroke must not force the user to also unbind it
/// from the command that shipped with it.
#[test]
fn configured_keystroke_moves_from_its_default_owner() {
    let keymap = with(&[("new_workspace", one("cmd-t"))]).unwrap();
    assert_eq!(list(&keymap, Command::Workspace), ["cmd-t"]);
    assert!(list(&keymap, Command::Tab).is_empty());
    // Spelling differences still name the same keystroke.
    let keymap = with(&[("about", one("CMD-shift-P"))]).unwrap();
    assert!(list(&keymap, Command::Palette).is_empty());
    let keys: Vec<_> = keymap.bindings().map(|(_, keystroke)| keystroke).collect();
    let unique: HashSet<_> = keys.iter().collect();
    assert_eq!(keys.len(), unique.len());
}

#[test]
fn invalid_configuration_reports_the_command() {
    let error = |entries: &[(&str, Binding)]| with(entries).unwrap_err();
    assert!(matches!(
        error(&[("new_space", one("cmd-n"))]),
        Error::UnknownKeybinding(name) if name == "new_space"
    ));
    let invalid = error(&[("new_tab", one("cmd-n-t"))]);
    assert!(std::error::Error::source(&invalid).is_some());
    assert!(matches!(
        invalid,
        Error::InvalidKeystroke { command: "new_tab", ref keystroke, .. } if keystroke == "cmd-n-t"
    ));
    for keystroke in ["n", "shift-n"] {
        assert!(matches!(
            error(&[("new_tab", one(keystroke))]),
            Error::KeystrokeWithoutModifier {
                command: "new_tab",
                ..
            }
        ));
    }
    assert!(matches!(
        error(&[("new_tab", Binding::Many(vec!["cmd-n".into(); 9]))]),
        Error::TooManyKeystrokes("new_tab")
    ));
    assert!(matches!(
        error(&[("new_tab", one("cmd-k")), ("themes", one("cmd-k"))]),
        Error::DuplicateKeystroke {
            first: "new_tab",
            second: "themes",
            ..
        }
    ));
    // Repeating a keystroke within one command is harmless.
    with(&[(
        "new_tab",
        Binding::Many(vec!["cmd-k".into(), "cmd-k".into()]),
    )])
    .unwrap();
}

#[test]
fn chords_follow_the_prefix() {
    let keymap = Keymap::default();
    assert!(keymap.is_prefix(&keystroke("ctrl-b")));
    assert!(!keymap.is_prefix(&keystroke("ctrl-a")));
    assert!(!keymap.is_prefix(&keystroke("b")));
    assert_eq!(keymap.chord(&keystroke("c")), Some(Command::Tab));
    assert_eq!(keymap.chord(&keystroke("v")), Some(Command::SplitRight));
    assert_eq!(
        keymap.chord(&keystroke("shift-n")),
        Some(Command::Workspace)
    );
    assert_eq!(keymap.chord(&keystroke("3")), Some(Command::TabNumber(3)));
    assert_eq!(
        keymap.chord(&keystroke("shift-tab")),
        Some(Command::PreviousPane)
    );
    // A shifted symbol matches however the keyboard reports it.
    assert_eq!(
        keymap.chord(&keystroke("shift-/->?")),
        Some(Command::Keybinds)
    );
    assert_eq!(keymap.chord(&keystroke("?")), Some(Command::Keybinds));
    assert_eq!(keymap.chord(&keystroke("n")), Some(Command::NextTab));
    assert_eq!(keymap.chord(&keystroke("y")), None);
    assert_eq!(keymap.chord(&keystroke("ctrl-c")), None);
}

#[test]
fn gui_overrides_replace_daemon_bindings() {
    let keys = DaemonKeys {
        prefixes: vec![keystroke("ctrl-a")],
        bindings: vec![
            (Command::Tab, Trigger::Prefixed(keystroke("c"))),
            (Command::Tab, Trigger::Direct(keystroke("alt-t"))),
            (Command::SplitRight, Trigger::Prefixed(keystroke("v"))),
        ],
        ..no_keys()
    };
    let keymap = Keymap::with_overrides(
        &overrides(&[("new_tab", one("cmd-y"))]),
        &Default::default(),
        &keys,
    )
    .unwrap();
    assert_eq!(list(&keymap, Command::Tab), ["cmd-y"]);
    assert_eq!(keymap.chord(&keystroke("c")), None);
    assert_eq!(list(&keymap, Command::SplitRight), ["cmd-d", "ctrl-a v"]);
    assert_eq!(keymap.chord(&keystroke("v")), Some(Command::SplitRight));
    // An empty GUI entry unbinds the daemon's chords too.
    let keymap = Keymap::with_overrides(
        &overrides(&[("split_right", one(""))]),
        &Default::default(),
        &keys,
    )
    .unwrap();
    assert!(list(&keymap, Command::SplitRight).is_empty());
    assert_eq!(keymap.chord(&keystroke("v")), None);
}

#[test]
fn daemon_keystrokes_move_from_gui_defaults_but_not_from_gui_config() {
    let keys = DaemonKeys {
        prefixes: vec![keystroke("ctrl-a")],
        bindings: vec![
            // cmd-d is Split Right's catalog default.
            (Command::Zoom, Trigger::Direct(keystroke("cmd-d"))),
            // The first daemon binding for a keystroke wins.
            (Command::Tab, Trigger::Direct(keystroke("alt-1"))),
            (Command::TabNumber(1), Trigger::Direct(keystroke("alt-1"))),
            (Command::Tab, Trigger::Prefixed(keystroke("c"))),
            (Command::CloseTab, Trigger::Prefixed(keystroke("c"))),
            // Configured below, so the GUI keeps it.
            (Command::ClosePane, Trigger::Direct(keystroke("cmd-e"))),
            // Would swallow typing.
            (Command::NextTab, Trigger::Direct(keystroke("shift-n"))),
            // The prefix typed twice passes it through instead.
            (Command::PreviousTab, Trigger::Prefixed(keystroke("ctrl-a"))),
        ],
        ..no_keys()
    };
    let keymap = Keymap::with_overrides(
        &overrides(&[("about", one("cmd-e"))]),
        &Default::default(),
        &keys,
    )
    .unwrap();
    // Daemon keystrokes read in GPUI's platform spelling (`super-d` on Linux).
    let moved = keystroke("cmd-d").unparse();
    assert_eq!(
        list(&keymap, Command::Zoom),
        ["cmd-shift-enter", moved.as_str()]
    );
    assert!(list(&keymap, Command::SplitRight).is_empty());
    assert_eq!(list(&keymap, Command::Tab), ["cmd-t", "alt-1", "ctrl-a c"]);
    assert_eq!(list(&keymap, Command::TabNumber(1)), ["cmd-1"]);
    assert_eq!(list(&keymap, Command::CloseTab), ["cmd-shift-w"]);
    assert_eq!(list(&keymap, Command::ClosePane), ["cmd-w"]);
    assert_eq!(list(&keymap, Command::About), ["cmd-e"]);
    assert_eq!(list(&keymap, Command::NextTab), ["cmd-shift-]"]);
    assert_eq!(list(&keymap, Command::PreviousTab), ["cmd-shift-["]);
    let keys: Vec<_> = keymap.bindings().map(|(_, keystroke)| keystroke).collect();
    let unique: HashSet<_> = keys.iter().collect();
    assert_eq!(keys.len(), unique.len());
}

#[test]
fn the_prefix_yields_to_gui_config_and_typing() {
    let keys = |prefix| DaemonKeys {
        prefixes: vec![keystroke(prefix)],
        bindings: vec![(Command::Tab, Trigger::Prefixed(keystroke("c")))],
        ..no_keys()
    };
    // cmd-b is Toggle Sidebar's catalog default; the prefix takes it.
    let keymap =
        Keymap::with_overrides(&BTreeMap::new(), &Default::default(), &keys("cmd-b")).unwrap();
    assert!(list(&keymap, Command::ToggleSidebar).is_empty());
    assert!(keymap.is_prefix(&keystroke("cmd-b")));
    // A GUI-configured keystroke keeps its command and disables chords.
    let keymap = Keymap::with_overrides(
        &overrides(&[("themes", one("ctrl-b"))]),
        &Default::default(),
        &keys("ctrl-b"),
    )
    .unwrap();
    assert!(!keymap.is_prefix(&keystroke("ctrl-b")));
    assert_eq!(keymap.chord(&keystroke("c")), None);
    assert_eq!(list(&keymap, Command::Tab), ["cmd-t"]);
    for (prefix, usable) in [
        ("f12", true),
        ("escape", true),
        ("a", false),
        ("shift-a", false),
    ] {
        let keymap =
            Keymap::with_overrides(&BTreeMap::new(), &Default::default(), &keys(prefix)).unwrap();
        assert_eq!(keymap.is_prefix(&keystroke(prefix)), usable, "{prefix}");
        assert_eq!(keymap.chord(&keystroke("c")).is_some(), usable, "{prefix}");
    }
}

/// The labels of a command's bindings that run, as the palette lists them.
fn running(keymap: &Keymap, commands: &[ClientShellCommand], index: usize) -> Vec<String> {
    keymap.custom_bindings(commands)[index]
        .iter()
        .filter(|binding| binding.reach == Reach::Runs)
        .map(|binding| binding.label.clone())
        .collect()
}

fn custom(id: &str, labels: &[&str]) -> ClientShellCommand {
    ClientShellCommand {
        command_id: id.into(),
        binding_label: labels.join(" / "),
        binding_labels: labels.iter().map(|label| (*label).to_owned()).collect(),
        action: herdr_client::protocol::ClientShellCommandAction::Shell,
        description: None,
    }
}

#[test]
fn custom_commands_bind_after_the_keymap() {
    let keymap = Keymap::default();
    let commands = [
        custom("git", &["prefix+y", "ctrl+alt+g"]),
        // Herdr's own chord for New Tab, which the keymap keeps.
        custom("shadowed", &["prefix+c", "cmd+t"]),
        // A bare key would swallow typing, and the prefix is the prefix.
        custom("typing", &["u", "ctrl+b"]),
        custom("legacy", &[]),
    ];
    let find = |typed: &str, prefixed: bool| {
        keymap
            .custom_command(&commands, &keystroke(typed), prefixed)
            .map(|command| command.command_id.as_str())
    };
    assert_eq!(find("y", true), Some("git"));
    assert_eq!(find("ctrl-alt-g", false), Some("git"));
    assert_eq!(find("y", false), None);
    // Herdr's `goto` holds the prefix and g.
    assert_eq!(find("g", true), None);
    assert_eq!(find("ctrl-alt-g", true), None);
    assert_eq!(find("c", true), None);
    assert_eq!(find("cmd-t", false), None);
    assert_eq!(find("u", false), None);
    assert_eq!(find("ctrl-b", false), None);
    assert_eq!(running(&keymap, &commands, 0), ["ctrl-b y", "ctrl-alt-g"]);
    assert!(running(&keymap, &commands, 2).is_empty());
    // `binding_label` drops `prefix+`, so it alone binds nothing.
    let mut old = custom("old", &[]);
    old.binding_label = "g".into();
    let old = [old];
    assert!(running(&keymap, &old, 0).is_empty());
    assert!(keymap.custom_command(&old, &keystroke("g"), true).is_none());
    // Without a usable prefix no chord can reach one.
    let keys = DaemonKeys {
        prefixes: vec![keystroke("a")],
        ..no_keys()
    };
    let keymap = Keymap::with_overrides(&BTreeMap::new(), &Default::default(), &keys).unwrap();
    assert!(
        keymap
            .custom_command(&commands, &keystroke("y"), true)
            .is_none()
    );
    assert_eq!(running(&keymap, &commands, 0), ["ctrl-alt-g"]);
}

#[test]
fn triggers_tell_chords_from_direct_keystrokes() {
    let keys = DaemonKeys {
        bindings: vec![
            (Command::ResizeMode, Trigger::Prefixed(keystroke("r"))),
            (Command::ResizeMode, Trigger::Direct(keystroke("alt-r"))),
        ],
        ..no_keys()
    };
    let keymap = Keymap::with_overrides(&BTreeMap::new(), &Default::default(), &keys).unwrap();
    assert!(keymap.triggers(Command::ResizeMode, &keystroke("r"), true));
    assert!(!keymap.triggers(Command::ResizeMode, &keystroke("r"), false));
    assert!(keymap.triggers(Command::ResizeMode, &keystroke("alt-r"), false));
    assert!(!keymap.triggers(Command::ResizeMode, &keystroke("alt-r"), true));
    assert!(!keymap.triggers(Command::Zoom, &keystroke("r"), true));
}

#[test]
fn navigate_keys_never_take_typing_or_picker_keys() {
    let keys = DaemonKeys {
        navigate_up: ["k", "ctrl-p", "pageup", "enter"].map(keystroke).to_vec(),
        navigate_down: vec![keystroke("ctrl-n")],
        ..no_keys()
    };
    let keymap = Keymap::with_overrides(&BTreeMap::new(), &Default::default(), &keys).unwrap();
    assert_eq!(keymap.navigates_workspace(&keystroke("ctrl-p")), Some(true));
    assert_eq!(keymap.navigates_workspace(&keystroke("pageup")), Some(true));
    assert_eq!(
        keymap.navigates_workspace(&keystroke("ctrl-n")),
        Some(false)
    );
    for typed in ["k", "enter", "up"] {
        assert_eq!(
            keymap.navigates_workspace(&keystroke(typed)),
            None,
            "{typed}"
        );
    }
}

#[test]
fn every_prefix_arms_and_the_first_labels_chords() {
    let keys = DaemonKeys {
        prefixes: vec![keystroke("ctrl-space"), keystroke("ctrl-s")],
        bindings: vec![
            (Command::Tab, Trigger::Prefixed(keystroke("c"))),
            // Any prefix typed after a prefix passes it through instead.
            (Command::NextTab, Trigger::Prefixed(keystroke("ctrl-s"))),
        ],
        ..no_keys()
    };
    let keymap = Keymap::with_overrides(&BTreeMap::new(), &Default::default(), &keys).unwrap();
    assert!(keymap.is_prefix(&keystroke("ctrl-space")));
    assert!(keymap.is_prefix(&keystroke("ctrl-s")));
    assert!(!keymap.is_prefix(&keystroke("ctrl-b")));
    let first = keystroke("ctrl-space").unparse();
    assert_eq!(keymap.prefix_label().as_deref(), Some(first.as_str()));
    assert_eq!(
        list(&keymap, Command::Tab),
        ["cmd-t".to_owned(), format!("{first} c")]
    );
    assert_eq!(keymap.chord(&keystroke("ctrl-s")), None);
    assert_eq!(list(&keymap, Command::NextTab), ["cmd-shift-]"]);

    // A prefix the GUI config claims, or that would swallow typing, is
    // dropped, and the next one labels chords.
    let keys = DaemonKeys {
        prefixes: vec![keystroke("ctrl-b"), keystroke("a"), keystroke("ctrl-s")],
        bindings: vec![(Command::Tab, Trigger::Prefixed(keystroke("c")))],
        ..no_keys()
    };
    let keymap = Keymap::with_overrides(
        &overrides(&[("themes", one("ctrl-b"))]),
        &Default::default(),
        &keys,
    )
    .unwrap();
    assert!(!keymap.is_prefix(&keystroke("ctrl-b")));
    assert!(!keymap.is_prefix(&keystroke("a")));
    assert!(keymap.is_prefix(&keystroke("ctrl-s")));
    assert_eq!(list(&keymap, Command::Tab), ["cmd-t", "ctrl-s c"]);
}

fn pane_keys(entries: &[(&str, &str)]) -> PaneKeys {
    entries
        .iter()
        .map(|(typed, sent)| ((*typed).to_owned(), (*sent).to_owned()))
        .collect()
}

fn sent<'a>(keymap: &'a Keymap, typed: &str) -> Option<&'a Keystroke> {
    keymap.pane_key(&keystroke(typed))
}

#[test]
fn default_pane_keys_follow_ghostty_on_macos() {
    let defaults = DEFAULT_PANE_KEYS
        .iter()
        .map(|(typed, sent)| (keystroke(typed), keystroke(sent)));
    assert!(
        defaults
            .clone()
            .all(|(_, sent)| crate::terminal::reaches_pane(&sent))
    );
    let keymap = Keymap::default();
    assert_eq!(
        keymap.pane_keys.len(),
        if cfg!(target_os = "macos") { 5 } else { 0 }
    );
    // Defaults are replaced by keystroke, not spelling, or removed.
    let resolved = resolve_pane_keys(
        &pane_keys(&[
            ("cmd-backspace", ""),
            ("cmd-left", "home"),
            ("ctrl-shift-enter", "alt-enter"),
        ]),
        defaults,
    )
    .unwrap();
    assert_eq!(
        resolved,
        [
            (keystroke("cmd-right"), keystroke("ctrl-e")),
            (keystroke("alt-left"), keystroke("alt-b")),
            (keystroke("alt-right"), keystroke("alt-f")),
            (keystroke("cmd-left"), keystroke("home")),
            (keystroke("ctrl-shift-enter"), keystroke("alt-enter")),
        ]
    );
}

#[test]
fn pane_keys_take_keystrokes_from_default_and_daemon_commands() {
    let keys = DaemonKeys {
        prefixes: vec![keystroke("ctrl-b"), keystroke("ctrl-s")],
        bindings: vec![(Command::Themes, Trigger::Direct(keystroke("ctrl-alt-t")))],
        ..no_keys()
    };
    let table = pane_keys(&[
        ("cmd-k", "ctrl-l"),
        ("ctrl-alt-t", "f5"),
        ("ctrl-b", "ctrl-a"),
    ]);
    let keymap = Keymap::with_overrides(&BTreeMap::new(), &table, &keys).unwrap();
    assert_eq!(sent(&keymap, "cmd-k"), Some(&keystroke("ctrl-l")));
    assert_eq!(keymap.primary(Command::ClearPane), "");
    assert_eq!(keymap.primary(Command::Themes), "");
    assert!(!keymap.is_prefix(&keystroke("ctrl-b")));
    assert_eq!(keymap.prefix_label(), Some(keystroke("ctrl-s").unparse()));
    assert!(keymap.bindings().all(|(_, label)| label != "cmd-k"));
    assert_eq!(sent(&keymap, "cmd-j"), None);
}

#[test]
fn pane_keys_reject_typing_unsendable_targets_and_configured_commands() {
    let resolve = |entries: &[(&str, &str)], bindings: &[(&str, Binding)]| {
        Keymap::with_overrides(&overrides(bindings), &pane_keys(entries), &no_keys())
    };
    assert!(matches!(
        resolve(&[("a", "ctrl-a")], &[]),
        Err(Error::PaneKeyWithoutModifier(_))
    ));
    assert!(matches!(
        resolve(&[("shift-space", "ctrl-a")], &[]),
        Err(Error::PaneKeyWithoutModifier(_))
    ));
    assert!(matches!(
        resolve(&[("cmd-left", "cmd-a")], &[]),
        Err(Error::UnsendablePaneKey { .. })
    ));
    assert!(matches!(
        resolve(&[("cmd-left", "ctrl-nope-a")], &[]),
        Err(Error::InvalidPaneKey { .. })
    ));
    assert!(matches!(
        resolve(&[("cmd-left", "ctrl-a"), ("super-left", "ctrl-e")], &[]),
        Err(Error::DuplicatePaneKey(_))
    ));
    assert!(matches!(
        resolve(&[("cmd-y", "ctrl-a")], &[("new_tab", one("cmd-y"))]),
        Err(Error::PaneKeyBound {
            command: "new_tab",
            ..
        })
    ));
    // A key that cannot be text needs no modifier.
    assert!(resolve(&[("shift-enter", "alt-enter"), ("f13", "ctrl-u")], &[]).is_ok());
    // Counted before parsing, so a huge table is refused cheaply.
    let many: PaneKeys = (0..=MAX_PANE_KEYS)
        .map(|n| (format!("{}cmd-k", " ".repeat(n)), "ctrl-a".to_owned()))
        .collect();
    assert!(matches!(
        Keymap::with_overrides(&BTreeMap::new(), &many, &no_keys()),
        Err(Error::TooManyPaneKeys(MAX_PANE_KEYS))
    ));
}
