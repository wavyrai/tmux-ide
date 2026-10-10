use super::*;

#[test]
fn devices_opt_into_server_keybindings_one_by_one() -> anyhow::Result<()> {
    const ID: &str = "0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210";
    let config = Config::parse(&format!(
        "[keybindings]\nnew_tab = 'cmd-y'\n[devices.{ID}]\nkeybindings = 'server'\n[devices.{OTHER}]\nkeybindings = 'local'"
    ))?;
    assert_eq!(
        config.keybinding_source(&format!("ssh:{ID}")),
        KeybindingSource::Server
    );
    assert_eq!(
        config.keybinding_source(&format!("ssh:{OTHER}")),
        KeybindingSource::Local
    );
    // Local, explicit sockets, and unlisted devices keep local keys, and
    // a bare profile ID is not an endpoint ID.
    for endpoint in [
        "local",
        "socket",
        ID,
        "ssh:00000000000000000000000000000000",
    ] {
        assert_eq!(
            config.keybinding_source(endpoint),
            KeybindingSource::Local,
            "{endpoint}"
        );
    }
    assert_eq!(
        Config::parse("")?.keybinding_source(&format!("ssh:{ID}")),
        KeybindingSource::Local
    );
    // The overrides stay available to layer over a server profile.
    assert_eq!(
        config.keybinding_overrides.get("new_tab"),
        Some(&Binding::One("cmd-y".into()))
    );
    // A non-catalog ID, or a key this build does not know, is ignored
    // and reported, as other unknown keys are.
    let ignored = Config::parse(&format!(
        "[devices.box]\nkeybindings = 'server'\n[devices.{ID}]\nkeybindings = 'server'\ntheme = 'Nord'"
    ))?;
    assert_eq!(
        ignored.unknown_keys,
        [format!("devices.{ID}.theme"), "devices.box".to_owned()]
    );
    assert_eq!(ignored.devices.len(), 1);
    assert_eq!(
        ignored.keybinding_source(&format!("ssh:{ID}")),
        KeybindingSource::Server
    );
    for text in [
        format!("[devices.{ID}]\nkeybindings = 'remote'"),
        format!("[devices.{ID}]\nkeybindings = true"),
        "devices = 'server'".into(),
    ] {
        assert!(Config::parse(&text).is_err(), "accepted {text:?}");
    }
    let many: String = (0..=MAX_DEVICES)
        .map(|index| format!("[devices.{index:032x}]\n"))
        .collect();
    assert!(matches!(
        Config::parse(&many),
        Err(Error::TooManyDevices(MAX_DEVICES))
    ));
    Ok(())
}

#[test]
fn device_keybindings_save_in_place_and_local_removes_them() -> anyhow::Result<()> {
    const ID: &str = "0123456789abcdef0123456789abcdef";
    let endpoint = format!("ssh:{ID}");
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config.toml");
    let original = "theme = 'Nord' # keep\n[usage]\nshow = false\n";
    fs::write(&path, original)?;
    Config::save_device_keybindings_path(ID, KeybindingSource::Server, &path)?;
    let saved = fs::read_to_string(&path)?;
    assert!(saved.starts_with(original), "{saved}");
    assert!(
        saved.contains(&format!("[devices.{ID}]\nkeybindings = \"server\"")),
        "{saved}"
    );
    let config = Config::parse(&saved)?;
    assert_eq!(
        config.keybinding_source(&endpoint),
        KeybindingSource::Server
    );
    assert!(!config.usage.show);
    // Saving it again is a no-op, and Local restores the original file.
    Config::save_device_keybindings_path(ID, KeybindingSource::Server, &path)?;
    assert_eq!(fs::read_to_string(&path)?, saved);
    Config::save_device_keybindings_path(ID, KeybindingSource::Local, &path)?;
    assert_eq!(fs::read_to_string(&path)?, original);
    Config::save_device_keybindings_path(ID, KeybindingSource::Local, &path)?;
    assert_eq!(fs::read_to_string(&path)?, original);
    // Another device's entry, and unknown keys, survive.
    let shared = format!(
        "[devices.{ID}]\nkeybindings = 'server'\n[devices.fedcba9876543210fedcba9876543210]\nkeybindings = 'server'\n"
    );
    fs::write(&path, &shared)?;
    Config::save_device_keybindings_path(ID, KeybindingSource::Local, &path)?;
    let kept = fs::read_to_string(&path)?;
    assert!(!kept.contains(ID), "{kept}");
    assert!(kept.contains("fedcba9876543210fedcba9876543210"), "{kept}");
    // An ID that is not a catalog profile never reaches the file.
    assert!(matches!(
        Config::save_device_keybindings_path("../x", KeybindingSource::Server, &path),
        Err(Error::InvalidDeviceId(_))
    ));
    assert_eq!(fs::read_to_string(&path)?, kept);
    fs::remove_file(&path)?;
    Config::save_device_keybindings_path(ID, KeybindingSource::Server, &path)?;
    let created = fs::read_to_string(&path)?;
    assert!(created.starts_with(LOCAL_CONFIG), "{created}");
    assert_eq!(
        Config::parse(&created)?.keybinding_source(&endpoint),
        KeybindingSource::Server
    );
    Ok(())
}

#[test]
fn keybindings_override_defaults_and_reject_bad_entries() -> anyhow::Result<()> {
    use crate::Command;
    let config = Config::parse("")?;
    assert_eq!(config.keybindings.primary(Command::Tab), "cmd-t");
    let config = Config::parse(
        "[keybindings]\nnew_workspace = \"cmd-n\"\nnew_tab = [\"cmd-t\", \"ctrl-t\"]\nquit = \"\"",
    )?;
    let shortcuts = |command| config.keybindings.shortcuts(command).collect::<Vec<_>>();
    assert_eq!(shortcuts(Command::Workspace), ["cmd-n"]);
    assert_eq!(shortcuts(Command::Tab), ["cmd-t", "ctrl-t"]);
    assert!(shortcuts(Command::Quit).is_empty());
    // The managed defaults document the table without setting it.
    let layered = Config::parse_layers(
        [DEFAULT_CONFIG, "[keybindings]\nthemes = \"cmd-k\""],
        &Daemon::default(),
    )?;
    assert_eq!(layered.keybindings.primary(Command::Themes), "cmd-k");
    assert_eq!(layered.keybindings.primary(Command::Tab), "cmd-t");
    // A command this build does not have is ignored, not fatal.
    let config = Config::parse("[keybindings]\nnew_space = \"cmd-n\"\nthemes = \"cmd-k\"")?;
    assert_eq!(config.unknown_keys, ["keybindings.new_space"]);
    assert_eq!(config.keybindings.primary(Command::Themes), "cmd-k");
    assert!(matches!(
        Config::parse("[keybindings]\nnew_tab = \"t\""),
        Err(Error::KeystrokeWithoutModifier { .. })
    ));
    assert!(Config::parse("[keybindings]\nnew_tab = 5").is_err());
    Ok(())
}

/// The daemon's `[keys]` reach the GUI keymap under the GUI's own
/// `[keybindings]`, and a daemon file the GUI cannot use falls back to
/// Herdr's defaults instead of failing the GUI config.
#[test]
fn daemon_keys_layer_under_gui_keybindings() -> anyhow::Result<()> {
    use crate::Command;
    let temp = TempDirectory::new()?;
    let gui = temp.0.join("config-gpui.toml");
    let local = gui.with_extension("local.toml");
    let daemon = temp.0.join("config.toml");
    let load = || Config::load_path(&gui, &daemon);
    fs::write(&gui, "")?;
    let shortcuts = |config: &Config, command| {
        config
            .keybindings
            .shortcuts(command)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };

    // No daemon file: Herdr's defaults.
    assert_eq!(shortcuts(&load()?, Command::Tab), ["cmd-t", "ctrl-b c"]);

    fs::write(
        &daemon,
        "[keys]\nprefix = \"ctrl+a\"\nsplit_vertical = [\"prefix+v\", \"prefix+\\\\\"]\nswitch_tab = [\"prefix+1..9\", \"alt+1..9\"]\n",
    )?;
    let config = load()?;
    assert_eq!(
        shortcuts(&config, Command::SplitRight),
        ["cmd-d", "ctrl-a v", "ctrl-a \\"]
    );
    assert_eq!(
        shortcuts(&config, Command::TabNumber(2)),
        ["cmd-2", "ctrl-a 2", "alt-2"]
    );
    assert!(
        config
            .keybindings
            .bindings()
            .any(|binding| binding == (Command::TabNumber(2), "alt-2"))
    );

    // The GUI's own entry replaces the command's list, daemon chords too.
    fs::write(&local, "[keybindings]\nsplit_right = \"cmd-d\"\n")?;
    assert_eq!(shortcuts(&load()?, Command::SplitRight), ["cmd-d"]);

    fs::write(&local, "")?;
    fs::write(&daemon, "[keys\nprefix = ")?;
    assert_eq!(shortcuts(&load()?, Command::Tab), ["cmd-t", "ctrl-b c"]);
    Ok(())
}

#[test]
fn pane_keys_reach_the_keymap_as_written() -> anyhow::Result<()> {
    let config = Config::parse(
        "[pane_keys]\n\"cmd-k\" = \"ctrl-l\"\n\"cmd-.\" = \"alt-.\"\n\"cmd-left\" = \"\"\n",
    )?;
    let keymap = &config.keybindings;
    let sent = |typed| {
        keymap
            .pane_key(&gpui::Keystroke::parse(typed).unwrap_or_default())
            .map(|sent| sent.unparse())
    };
    assert_eq!(sent("cmd-k").as_deref(), Some("ctrl-l"));
    assert_eq!(sent("cmd-.").as_deref(), Some("alt-."));
    assert_eq!(sent("cmd-left"), None);
    assert_eq!(keymap.primary(crate::controls::Command::ClearPane), "");
    assert_eq!(config.pane_keys.len(), 3);
    assert!(config.unknown_keys.is_empty(), "{:?}", config.unknown_keys);
    assert!(matches!(
        Config::parse(
            "[pane_keys]\n\"cmd-k\" = \"ctrl-l\"\n[keybindings]\nclear_pane = \"cmd-k\"\n"
        ),
        Err(Error::PaneKeyBound {
            command: "clear_pane",
            ..
        })
    ));
    Ok(())
}
