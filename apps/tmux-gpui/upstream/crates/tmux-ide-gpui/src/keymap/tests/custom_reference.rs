use super::*;

fn reference(keymap: &Keymap, commands: &[ClientShellCommand]) -> Vec<Vec<(String, Reach)>> {
    keymap
        .custom_bindings(commands)
        .into_iter()
        .map(|bindings| {
            bindings
                .into_iter()
                .map(|binding| (binding.label, binding.reach))
                .collect()
        })
        .collect()
}

fn entry(label: &str, reach: Reach) -> (String, Reach) {
    (label.to_owned(), reach)
}

#[test]
fn a_trigger_two_commands_share_runs_only_the_first() {
    let keymap = Keymap::default();
    let commands = [
        custom("first", &["ctrl+alt+a", "prefix+y"]),
        custom("second", &["ctrl+alt+a", "prefix+y", "ctrl+alt+b"]),
    ];
    assert_eq!(
        reference(&keymap, &commands),
        [
            vec![
                entry("ctrl-alt-a", Reach::Runs),
                entry("ctrl-b y", Reach::Runs),
            ],
            vec![
                entry("ctrl-alt-a", Reach::Taken),
                entry("ctrl-b y", Reach::Taken),
                entry("ctrl-alt-b", Reach::Runs),
            ],
        ]
    );
    let find = |typed: &str, prefixed: bool| {
        keymap
            .custom_command(&commands, &keystroke(typed), prefixed)
            .map(|command| command.command_id.as_str())
    };
    assert_eq!(find("ctrl-alt-a", false), Some("first"));
    assert_eq!(find("y", true), Some("first"));
    assert_eq!(find("ctrl-alt-b", false), Some("second"));
}

#[test]
fn a_repeated_trigger_is_listed_once_with_its_first_reach() {
    let keymap = Keymap::default();
    let mut labels = vec!["ctrl+alt+a", "prefix+y", " alt + ctrl + a "];
    labels.extend(["ctrl+alt+b"; 6]);
    // Past the alias limit, repeating the first entry.
    labels.extend(["ctrl+alt+a", "ctrl+alt+z"]);
    assert_eq!(
        reference(&keymap, &[custom("aliases", &labels)]),
        [vec![
            entry("ctrl-alt-a", Reach::Runs),
            entry("ctrl-b y", Reach::Runs),
            entry("ctrl-alt-b", Reach::Runs),
            entry("ctrl-alt-z", Reach::OverLimit),
        ]]
    );
}

#[test]
fn unsupported_labels_read_as_separate_keys() {
    let keymap = Keymap::default();
    let commands = [custom(
        "hyper",
        &["CTRL+hyper+Y", "  ", "", "prefix+hyper+a", "+"],
    )];
    assert_eq!(
        reference(&keymap, &commands),
        [vec![
            entry("ctrl-hyper-y", Reach::Unsupported),
            entry("ctrl-b hyper-a", Reach::Unsupported),
        ]]
    );
}

#[test]
fn chords_without_a_usable_prefix_keep_separate_keys() {
    let keys = DaemonKeys {
        prefixes: vec![keystroke("a")],
        ..no_keys()
    };
    let keymap = Keymap::with_overrides(&BTreeMap::new(), &Default::default(), &keys).unwrap();
    assert_eq!(
        reference(&keymap, &[custom("chord", &["prefix+y"])]),
        [vec![entry("prefix y", Reach::NoPrefix)]]
    );
}

#[test]
fn reserved_and_keymap_keystrokes_never_reach_a_custom_command() {
    let keymap = Keymap::default();
    let commands = [custom(
        "conflicts",
        &["cmd+v", "cmd+a", "prefix+c", "prefix+ctrl+b", "u"],
    )];
    // Labels read in GPUI's platform spelling (`super-v` on Linux).
    let paste = keystroke("cmd-v").unparse();
    let select_all = keystroke("cmd-a").unparse();
    assert_eq!(
        reference(&keymap, &commands),
        [vec![
            entry(&paste, Reach::Shadowed),
            entry(&select_all, Reach::Shadowed),
            entry("ctrl-b c", Reach::Shadowed),
            entry("ctrl-b ctrl-b", Reach::Shadowed),
            entry("u", Reach::NeedsModifier),
        ]]
    );
    for typed in ["cmd-v", "cmd-a"] {
        assert!(
            keymap
                .custom_command(&commands, &keystroke(typed), false)
                .is_none(),
            "{typed} must stay with the Edit menu"
        );
    }
}
