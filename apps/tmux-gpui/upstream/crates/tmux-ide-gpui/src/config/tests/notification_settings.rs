use super::*;

#[test]
fn shared_notifications_inherit_without_resetting_session() -> anyhow::Result<()> {
    use crate::herdr_settings::Settings as Shared;
    use herdr_client::protocol::ToastHerdrPosition;

    for mut config in [
        Config::default(),
        Config::parse("")?,
        Config::parse("[notifications]")?,
        Config::parse(DEFAULT_CONFIG)?,
    ] {
        assert_eq!(config.notifications, NotificationConfig::default());
        config.terminal.size = 27.5;
        config.ui.size = 18.;
        config.terminal.fallbacks = Some(vec!["Session Fallback".into()]);
        config.clipboard_toast.enabled = false;
        config.contrast = Contrast::High;
        let session = config.clone();
        for (delivery, enabled, system) in [
            ("herdr", true, false),
            ("off", false, false),
            ("system", false, true),
            ("terminal", false, false),
            ("herdr", true, false),
        ] {
            let shared = Shared::parse_text(&format!(
                "[ui.toast]\ndelivery = '{delivery}'\ndelay_seconds = 7\n[ui.toast.herdr]\nposition = 'top-left'\n"
            ))?;
            config.apply_shared_notifications(&shared);
            assert_eq!(
                config.notifications,
                NotificationConfig {
                    enabled,
                    system,
                    delay_seconds: 7,
                    position: ToastHerdrPosition::TopLeft
                }
            );
            for (font, original) in [
                (&config.sidebar, &session.sidebar),
                (&config.tabs, &session.tabs),
                (&config.terminal, &session.terminal),
                (&config.ui, &session.ui),
            ] {
                assert_eq!(font.family, original.family);
                assert_eq!(font.size, original.size);
                assert_eq!(font.fallbacks, original.fallbacks);
            }
            assert_eq!(config.clipboard_toast, session.clipboard_toast);
            assert_eq!(config.layout, session.layout);
            assert_eq!(config.theme, session.theme);
            assert_eq!(config.contrast, session.contrast);
            assert_eq!(
                config.keybindings.bindings().collect::<Vec<_>>(),
                session.keybindings.bindings().collect::<Vec<_>>()
            );
        }
        config.apply_shared_notifications(&Shared::parse_text("")?);
        assert_eq!(config.notifications, NotificationConfig::default());
    }
    Ok(())
}

#[test]
fn shared_notifications_respect_each_explicit_native_override() -> anyhow::Result<()> {
    use crate::herdr_settings::Settings as Shared;
    use herdr_client::protocol::ToastHerdrPosition::{BottomLeft, TopRight};
    let shared = Shared::parse_text(
        "[ui.toast]\ndelivery = 'herdr'\ndelay_seconds = 7\n[ui.toast.herdr]\nposition = 'top-right'",
    )?;
    for (text, enabled, delay_seconds, position) in [
        ("enabled = false", false, 7, TopRight),
        ("delay_seconds = 0", true, 0, TopRight),
        ("position = 'bottom-left'", true, 7, BottomLeft),
        (
            "enabled = false\ndelay_seconds = 0\nposition = 'bottom-left'",
            false,
            0,
            BottomLeft,
        ),
    ] {
        let mut config = Config::parse_layers(
            [DEFAULT_CONFIG, &format!("[notifications]\n{text}")],
            &Daemon::default(),
        )?;
        for _ in 0..2 {
            config.apply_shared_notifications(&shared);
            assert_eq!(
                config.notifications,
                NotificationConfig {
                    enabled,
                    system: false,
                    delay_seconds,
                    position
                },
                "{text}"
            );
        }
    }
    let mut config = Config::parse("[notifications]\nenabled = true")?;
    for delivery in ["off", "terminal", "system"] {
        config.apply_shared_notifications(&Shared::parse_text(&format!(
            "[ui.toast]\ndelivery = '{delivery}'"
        ))?);
        assert!(config.notifications.enabled);
        assert_eq!(config.notifications.delivery(), NotificationDelivery::InApp);
    }
    // A local opt-out of in-app toasts leaves shared system delivery in charge.
    let mut config = Config::parse("[notifications]\nenabled = false")?;
    for (delivery, expected) in [
        ("system", NotificationDelivery::System),
        ("herdr", NotificationDelivery::Off),
        ("terminal", NotificationDelivery::Off),
    ] {
        config.apply_shared_notifications(&Shared::parse_text(&format!(
            "[ui.toast]\ndelivery = '{delivery}'"
        ))?);
        assert_eq!(config.notifications.delivery(), expected, "{delivery}");
    }
    Ok(())
}

#[test]
fn managed_notifications_defer_but_local_and_legacy_keys_win() -> anyhow::Result<()> {
    use crate::herdr_settings::Settings as Shared;
    let shared = Shared::parse_text("[ui.toast]\ndelivery = 'herdr'\ndelay_seconds = 9")?;
    for legacy in [false, true] {
        let temp = TempDirectory::new()?;
        let path = temp.0.join("config-gpui.toml");
        let daemon = temp.0.join("absent.toml");
        if legacy {
            fs::write(&path, "[notifications]\nenabled = false\n")?;
        }
        for mut config in [
            Config::load_startup_path(&path, &daemon)?,
            Config::load_path(&path, &daemon)?,
        ] {
            config.apply_shared_notifications(&shared);
            assert_eq!(config.notifications.enabled, !legacy);
            assert_eq!(config.notifications.delay_seconds, 9);
        }
        fs::write(
            path.with_extension("local.toml"),
            "[notifications]\nenabled = false\ndelay_seconds = 1\nposition = 'bottom-right'\n",
        )?;
        for mut config in [
            Config::load_startup_path(&path, &daemon)?,
            Config::load_path(&path, &daemon)?,
        ] {
            config.apply_shared_notifications(&shared);
            assert_eq!(config.notifications, NotificationConfig::default());
        }
        assert_eq!(fs::read_to_string(&path)?, DEFAULT_CONFIG);
    }
    Ok(())
}

#[test]
fn bell_defaults_to_attention_and_rejects_unknown_keys() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let gui = temp.0.join("config-gpui.toml");
    let local = gui.with_extension("local.toml");
    let daemon = temp.0.join("config.toml");
    fs::write(&gui, "")?;
    assert_eq!(
        Config::load_path(&gui, &daemon)?.bell,
        BellConfig {
            attention: true,
            sound: false
        }
    );
    fs::write(&local, "[bell]\nsound = true\n")?;
    assert_eq!(
        Config::load_path(&gui, &daemon)?.bell,
        BellConfig {
            attention: true,
            sound: true
        }
    );
    fs::write(&local, "[bell]\nattention = false\n")?;
    assert!(!Config::load_path(&gui, &daemon)?.bell.attention);
    fs::write(&local, "[bell]\nvisual = true\n")?;
    assert!(Config::load_path(&gui, &daemon).is_err());
    Ok(())
}

/// The daemon's own answer is the starting point, each GUI key overrides
/// it alone, and the file this GUI writes for a new user pins neither.
#[test]
fn clipboard_toast_layers_the_daemon_config_under_the_gui_config() -> anyhow::Result<()> {
    use ClipboardToastPosition::*;
    let temp = TempDirectory::new()?;
    let gui = temp.0.join("config-gpui.toml");
    let local = gui.with_extension("local.toml");
    let daemon = temp.0.join("config.toml");

    // No files at all: herdr's defaults, so both clients agree.
    fs::write(&gui, "")?;
    let load = |daemon: &Path| Config::load_path(&gui, daemon);
    assert_eq!(
        load(&daemon)?.clipboard_toast,
        ClipboardToast {
            enabled: true,
            position: BottomCenter
        }
    );

    // The daemon config alone decides when the GUI config is silent.
    fs::write(
        &daemon,
        "onboarding = false\n[ui]\nstatus_indicators = \"dots\"\n[ui.toast.clipboard]\nenabled = false\nposition = \"top-right\"\n",
    )?;
    assert_eq!(
        load(&daemon)?.clipboard_toast,
        ClipboardToast {
            enabled: false,
            position: TopRight
        }
    );

    // Each GUI key overrides on its own, leaving the other one alone.
    for (text, expected) in [
        (
            "[clipboard_toast]\nenabled = true",
            ClipboardToast {
                enabled: true,
                position: TopRight,
            },
        ),
        (
            "[clipboard_toast]\nposition = \"bottom-left\"",
            ClipboardToast {
                enabled: false,
                position: BottomLeft,
            },
        ),
        (
            "[clipboard_toast]\nenabled = true\nposition = \"top-center\"",
            ClipboardToast {
                enabled: true,
                position: TopCenter,
            },
        ),
        (
            "[clipboard_toast]",
            ClipboardToast {
                enabled: false,
                position: TopRight,
            },
        ),
    ] {
        fs::write(&local, text)?;
        assert_eq!(load(&daemon)?.clipboard_toast, expected, "{text}");
    }

    // A daemon config the GUI cannot use leaves herdr's defaults standing:
    // it belongs to another program and may hold anything.
    fs::write(&local, "")?;
    for text in [
        "not toml",
        "[ui.toast.clipboard]\nenabled = \"yes\"\nposition = 3",
        "[ui.toast.clipboard]\nposition = \"middle\"",
        "[ui.toast]\nclipboard = 7",
        "[ui]\ntoast = false",
        "",
    ] {
        fs::write(&daemon, text)?;
        assert_eq!(
            load(&daemon)?.clipboard_toast,
            ClipboardToast::default(),
            "{text}"
        );
    }
    fs::remove_file(&daemon)?;
    assert_eq!(load(&daemon)?.clipboard_toast, ClipboardToast::default());
    assert_eq!(
        load(&temp.0)?.clipboard_toast,
        ClipboardToast::default(),
        "a directory is not a config"
    );

    // Oversized files are skipped rather than parsed on every config load.
    let mut oversized = "[ui.toast.clipboard]\nenabled = false\n".to_owned();
    oversized.push_str(&"# pad\n".repeat(MAX_DAEMON_CONFIG_BYTES as usize / 6));
    assert!(oversized.len() as u64 > MAX_DAEMON_CONFIG_BYTES);
    fs::write(&daemon, &oversized)?;
    assert_eq!(load(&daemon)?.clipboard_toast, ClipboardToast::default());

    // The file written for a new user must not pin either key, or the
    // daemon config could never reach a GUI that has run once.
    assert_eq!(
        ClipboardToastSettings::default().resolve(ClipboardToast {
            enabled: false,
            position: TopLeft
        }),
        ClipboardToast {
            enabled: false,
            position: TopLeft
        }
    );
    fs::write(&gui, DEFAULT_CONFIG)?;
    fs::write(
        &daemon,
        "[ui.toast.clipboard]\nenabled = false\nposition = \"top-left\"\n",
    )?;
    assert_eq!(
        load(&daemon)?.clipboard_toast,
        ClipboardToast {
            enabled: false,
            position: TopLeft
        }
    );
    Ok(())
}

#[test]
fn clipboard_toast_keys_are_strict() {
    for text in [
        "[clipboard_toast]\nenabled = 1",
        "[clipboard_toast]\nenabled = \"true\"",
        "[clipboard_toast]\nposition = \"middle\"",
        "[clipboard_toast]\nposition = \"BottomCenter\"",
        "[clipboard_toast]\nposition = 1",
        "clipboard_toast = true",
    ] {
        assert!(Config::parse(text).is_err(), "{text}");
    }
}

#[test]
fn notification_settings_defaults_bounds_corners_and_strict_types() -> anyhow::Result<()> {
    use herdr_client::protocol::ToastHerdrPosition;
    use std::error::Error as _;
    for text in ["", "[notifications]", DEFAULT_CONFIG] {
        assert_eq!(
            Config::parse(text)?.notifications,
            NotificationConfig::default()
        );
    }
    for delay in [0, 1, 3600] {
        for (name, position) in [
            ("top-left", ToastHerdrPosition::TopLeft),
            ("top-right", ToastHerdrPosition::TopRight),
            ("bottom-left", ToastHerdrPosition::BottomLeft),
            ("bottom-right", ToastHerdrPosition::BottomRight),
        ] {
            let config = Config::parse(&format!(
                "[notifications]\nenabled=true\ndelay_seconds={delay}\nposition=\"{name}\"\n[layout]\nsidebar_gap=16\n[terminal]\nsize=18"
            ))?;
            assert_eq!(config.layout.sidebar_gap, 16.);
            assert_eq!(config.terminal.size, 18.);
            assert_eq!(
                config.notifications,
                NotificationConfig {
                    enabled: true,
                    system: false,
                    delay_seconds: delay,
                    position
                }
            );
        }
    }
    for field in [
        "enabled=1",
        "enabled=\"true\"",
        "delay_seconds=-1",
        "delay_seconds=3601",
        "delay_seconds=1.5",
        "delay_seconds=\"1\"",
        "position=\"center\"",
    ] {
        let error = Config::parse(&format!("[notifications]\n{field}"))
            .err()
            .ok_or_else(|| anyhow::anyhow!("accepted {field}"))?;
        assert!(matches!(error, Error::Toml(_)), "{field}: {error:?}");
        assert!(error.source().is_some());
    }
    // Delivery is a shared Herdr setting; a native `system` key is unknown.
    assert_eq!(
        Config::parse("[notifications]\nsystem=true")?
            .notifications
            .delivery(),
        NotificationDelivery::Off
    );
    Ok(())
}
