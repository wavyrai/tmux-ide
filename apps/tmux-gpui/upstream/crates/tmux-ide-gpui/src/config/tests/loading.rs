use super::*;
use crate::error::ThemeParseError;

#[test]
fn startup_reads_settings_without_writes_or_waiting_for_maintenance() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config-gpui.toml");
    let daemon = temp.0.join("absent.toml");
    // A fresh install's first frame already shows the layout its seeded
    // overrides will hold, without writing them yet.
    assert_eq!(
        Config::load_startup_path(&path, &daemon)?.layout.mode,
        LayoutMode::new(Density::Comfortable, Style::Rounded)
    );
    assert_eq!(fs::read_dir(&temp.0)?.count(), 0);
    let legacy = "layout = 'compact'\ntheme = 'Nord'\n[terminal]\nsize = 18\n";
    fs::write(&path, legacy)?;
    let config = Config::load_startup_path(&path, &daemon)?;
    assert_eq!(config.layout.mode, LayoutMode::from(Density::Compact));
    assert_eq!(config.theme, "Nord");
    assert_eq!(config.terminal.size, 18.);
    assert_eq!(fs::read_to_string(&path)?, legacy);
    assert_eq!(fs::read_dir(&temp.0)?.count(), 1);

    let local = path.with_extension("local.toml");
    fs::write(&local, "layout = 'compact'\ntheme = 'Dracula'")?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path.with_extension("lock"))?;
    lock.lock()?;
    // Hold the maintenance lock until the read finishes, with a bounded wait
    // so accidentally adding lock acquisition is a deterministic failure.
    let (send, receive) = std::sync::mpsc::channel();
    let (worker_path, worker_daemon) = (path.clone(), daemon.clone());
    let worker = std::thread::spawn(move || {
        let _ = send.send(Config::load_startup_path(&worker_path, &worker_daemon));
    });
    let result = receive.recv_timeout(std::time::Duration::from_secs(5));
    drop(lock);
    worker
        .join()
        .map_err(|_| anyhow::anyhow!("startup reader panicked"))?;
    assert_eq!(result??.theme, "Dracula");
    assert_eq!(fs::read_to_string(&path)?, legacy);
    assert_eq!(
        fs::read_to_string(&local)?,
        "layout = 'compact'\ntheme = 'Dracula'"
    );
    Ok(())
}

#[test]
fn startup_appearance_read_timing() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config-gpui.toml");
    let daemon = temp.0.join("absent.toml");
    fs::write(
        path.with_extension("local.toml"),
        "layout = 'compact'\ntheme = 'Nord'",
    )?;
    let mut samples = Vec::new();
    for _ in 0..100 {
        let start = std::time::Instant::now();
        let config = Config::load_startup_path(&path, &daemon)?;
        let theme = config.theme(false)?;
        samples.push(start.elapsed());
        assert_eq!(config.layout.mode, LayoutMode::from(Density::Compact));
        assert_eq!(Some(theme), Theme::builtin("Nord"));
    }
    let first = samples[0];
    samples.sort();
    eprintln!(
        "Startup config + built-in theme: first={first:?}, median={:?}, p95={:?} (100 reads)",
        samples[50], samples[94]
    );
    // Timing is reported, not gated: filesystem latency is machine-dependent.
    Ok(())
}

#[test]
fn local_overrides_merge_tables_replace_arrays_and_refresh_defaults() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config-gpui.toml");
    let local = path.with_extension("local.toml");
    let daemon = temp.0.join("absent.toml");
    Config::load_path(&path, &daemon)?;
    assert_eq!(
        fs::read_to_string(&path)?.lines().next(),
        Some(MANAGED_HEADER)
    );
    assert_eq!(fs::read_to_string(&local)?, LOCAL_CONFIG);
    let overrides = "# personal settings\nlayout = 'compact'\n[terminal]\nsize = 19\nfallback = []\n[notifications]\nenabled = true\n";
    fs::write(&local, overrides)?;
    fs::write(&path, format!("{MANAGED_HEADER}\ntheme = 'old-default'\n"))?;
    let config = Config::load_path(&path, &daemon)?;
    assert_eq!(config.layout.mode, LayoutMode::from(Density::Compact));
    assert_eq!(config.terminal.size, 19.);
    assert_eq!(config.terminal.fallbacks, Some(vec![]));
    assert!(config.notifications.enabled);
    assert_eq!(config.notifications.delay_seconds, 1);
    assert_eq!(config.theme, "Default");
    assert_eq!(fs::read_to_string(&local)?, overrides);
    assert_eq!(fs::read_to_string(&path)?, DEFAULT_CONFIG);
    // A table can replace the named default without losing layout defaults.
    fs::write(&local, "[layout]\nmode = 'compact'\nsidebar_gap = 3")?;
    assert_eq!(Config::load_path(&path, &daemon)?.layout.sidebar_gap, 3.);
    let merged = Config::parse_layers(
        [
            "[terminal]\nfallback = ['first', 'second']",
            "[terminal]\nfallback = []",
        ],
        &Daemon::default(),
    )?;
    assert_eq!(merged.terminal.fallbacks, Some(vec![]));
    Ok(())
}

#[test]
fn managed_headers_accept_lf_and_crlf_without_migrating_defaults() -> anyhow::Result<()> {
    for newline in ["\n", "\r\n"] {
        for overrides in [None, Some("theme = 'Nord'\r\n")] {
            let temp = TempDirectory::new()?;
            let path = temp.0.join("config-gpui.toml");
            let local = path.with_extension("local.toml");
            let daemon = temp.0.join("absent.toml");
            let managed =
                format!("# DO NOT EDIT -- WILL BE OVERWRITTEN{newline}theme = 'Dracula'{newline}");
            fs::write(&path, &managed)?;
            if let Some(text) = overrides {
                fs::write(&local, text)?;
            }
            let expected_theme = if overrides.is_some() {
                "Nord"
            } else {
                "Default"
            };
            assert_eq!(
                Config::load_startup_path(&path, &daemon)?.theme,
                expected_theme
            );
            assert_eq!(fs::read_to_string(&path)?, managed);
            assert_eq!(local.exists(), overrides.is_some());
            for _ in 0..2 {
                assert_eq!(Config::load_path(&path, &daemon)?.theme, expected_theme);
                assert_eq!(fs::read_to_string(&path)?, DEFAULT_CONFIG);
                assert_eq!(
                    fs::read_to_string(&local)?,
                    overrides.unwrap_or(LOCAL_CONFIG)
                );
            }
        }
    }
    Ok(())
}

#[test]
fn legacy_config_migrates_verbatim_and_conflicts_never_overwrite() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config-gpui.toml");
    let local = path.with_extension("local.toml");
    let daemon = temp.0.join("absent.toml");
    // A longer comment is not the exact managed marker. Preserve CRLF too.
    let legacy = "# DO NOT EDIT -- WILL BE OVERWRITTEN (personal copy)\r\ntheme = 'Nord'\r\n[layout]\r\nsidebar_gap = 4\r\n";
    fs::write(&path, legacy)?;
    assert_eq!(Config::load_path(&path, &daemon)?.theme, "Nord");
    assert_eq!(fs::read_to_string(&local)?, legacy);
    assert_eq!(fs::read_to_string(&path)?, DEFAULT_CONFIG);
    assert_eq!(Config::load_path(&path, &daemon)?.layout.sidebar_gap, 4.);
    // A crash after the local copy but before refresh is safe to resume.
    fs::write(&path, legacy)?;
    assert_eq!(Config::load_path(&path, &daemon)?.theme, "Nord");
    assert_eq!(fs::read_to_string(&local)?, legacy);
    assert_eq!(fs::read_to_string(&path)?, DEFAULT_CONFIG);
    fs::write(&path, "theme = 'Dracula'")?;
    assert!(matches!(
        Config::load_path(&path, &daemon),
        Err(Error::ConfigMigrationConflict { .. })
    ));
    assert_eq!(fs::read_to_string(&local)?, legacy);
    assert_eq!(fs::read_to_string(&path)?, "theme = 'Dracula'");
    Ok(())
}

#[test]
fn unknown_keys_are_ignored_and_reported() -> anyhow::Result<()> {
    // What a newer build might write: every key it knows still applies.
    let config = Config::parse(
        "future = 1\ntheme = 'Nord'\n[future_table]\nx = 1\n\
             [terminal]\nsize = 18\nligatures = true\n\
             [notifications]\nenabled = true\nsound = 'ping'\n\
             [clipboard_toast]\nduration = 3\n[features]\nnew_flag = true\n\
             [github]\nenterprise = 'x'\n[layout]\nsidebar_gap = 4\nshadow = true\n\
             [usage.providers.future]\ntoken = 'y'",
    )?;
    assert_eq!(config.theme, "Nord");
    assert_eq!(config.terminal.size, 18.);
    assert!(config.notifications.enabled);
    assert_eq!(config.layout.sidebar_gap, 4.);
    assert_eq!(
        config.unknown_keys,
        [
            "clipboard_toast.duration",
            "features.new_flag",
            "future",
            "future_table",
            "github.enterprise",
            "layout.shadow",
            "notifications.sound",
            "terminal.ligatures",
            "usage.providers.future",
        ]
    );
    assert_eq!(
        config.diagnostic().as_deref(),
        Some(
            "config-gpui.local.toml: ignoring unknown keys clipboard_toast.duration, \
                 features.new_flag, future, future_table, github.enterprise and 4 more"
        )
    );
    assert_eq!(Config::parse("")?.diagnostic(), None);
    assert_eq!(
        Config::parse("[sidebar]\nnope = 1")?
            .diagnostic()
            .as_deref(),
        Some("config-gpui.local.toml: ignoring unknown keys sidebar.nope")
    );
    // The managed defaults layered underneath name no unknown keys.
    assert!(
        Config::parse_layers([DEFAULT_CONFIG], &Daemon::default())?
            .unknown_keys
            .is_empty()
    );
    // Credentials stay refused rather than ignored.
    for name in ["client_secret", "private_key", "token"] {
        assert!(matches!(
            Config::parse(&format!("[github]\n{name} = 'x'")),
            Err(Error::GitHubSecretInConfig(found)) if found == name
        ));
    }

    // Loading from disk keeps going too, and leaves the file alone.
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config-gpui.toml");
    let local = path.with_extension("local.toml");
    let daemon = temp.0.join("absent.toml");
    Config::load_path(&path, &daemon)?;
    let text = "theme = 'Dracula'\n[notifications]\nunknown = true\n";
    fs::write(&local, text)?;
    let loaded = Config::load_path(&path, &daemon)?;
    assert_eq!(loaded.theme, "Dracula");
    assert_eq!(loaded.unknown_keys, ["notifications.unknown"]);
    assert_eq!(Config::load_startup_path(&path, &daemon)?.theme, "Dracula");
    assert_eq!(fs::read_to_string(&local)?, text);
    Ok(())
}

#[test]
fn invalid_local_overrides_keep_their_path_and_contents() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config-gpui.toml");
    let local = path.with_extension("local.toml");
    let daemon = temp.0.join("absent.toml");
    Config::load_path(&path, &daemon)?;
    for text in [
        "theme = [",
        "[terminal]\nsize = '19'",
        "[notifications]\nenabled = 1",
    ] {
        fs::write(&local, text)?;
        let error = Config::load_path(&path, &daemon)
            .err()
            .context("accepted bad local config")?;
        assert!(
            matches!(&error, Error::Path { path, source } if path == &local
                && matches!(source.as_ref(), Error::ConfigFile { .. } | Error::Toml(_))),
            "{error:?}"
        );
        assert_eq!(fs::read_to_string(&local)?, text);
    }
    Ok(())
}

#[test]
fn simultaneous_migration_keeps_user_settings() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config-gpui.toml");
    fs::write(&path, "theme = 'Nord'")?;
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| Config::load_path(&path, &temp.0.join("absent.toml"))))
            .collect();
        for handle in handles {
            let config = handle
                .join()
                .map_err(|_| anyhow::anyhow!("config loader panicked"))??;
            assert_eq!(config.theme, "Nord");
        }
        anyhow::Ok(())
    })?;
    assert_eq!(
        fs::read_to_string(path.with_extension("local.toml"))?,
        "theme = 'Nord'"
    );
    Ok(())
}

#[test]
fn errors_retain_paths_categories_and_parser_sources() -> anyhow::Result<()> {
    use std::error::Error as _;

    let temp = TempDirectory::new()?;
    let path = temp.0.join("invalid.toml");
    fs::write(&path, "theme = [")?;
    let error = Config::load_path(&path, &temp.0.join("absent.toml"))
        .err()
        .ok_or_else(|| anyhow::anyhow!("accepted invalid TOML"))?;
    assert!(
        error
            .to_string()
            .starts_with(&format!("{}: ", path.display()))
    );
    let Error::Path {
        path: actual,
        source,
    } = error
    else {
        anyhow::bail!("missing path context");
    };
    assert_eq!(actual, path);
    assert!(matches!(source.as_ref(), Error::ConfigFile { .. }));
    assert!(source.source().is_some());
    assert!(matches!(
        Config::parse("[ui]\nsize = nan"),
        Err(Error::InvalidFontSize("ui"))
    ));

    let error = Theme::parse_ghostty("# ignored\npalette=bad=ffffff")
        .err()
        .ok_or_else(|| anyhow::anyhow!("accepted invalid palette index"))?;
    assert_eq!(
        error.to_string(),
        "line 2: palette: palette index must be between 0 and 255"
    );
    assert!(matches!(
        &error,
        Error::ThemeLine {
            line: 2,
            source: ThemeParseError::InvalidPaletteIndex(_),
            ..
        }
    ));
    assert!(
        error
            .source()
            .and_then(|source| source.source())
            .is_some_and(|source| source.is::<std::num::ParseIntError>())
    );
    assert!(matches!(
        Theme::parse_ghostty("palette=256=ffffff"),
        Err(Error::ThemeLine {
            source: ThemeParseError::PaletteIndexOutOfRange,
            ..
        })
    ));
    Ok(())
}

#[test]
fn refreshes_managed_config_and_loads_absolute_theme() -> anyhow::Result<()> {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let directory = env::temp_dir().join(format!("herdr-config-{}-{unique}", std::process::id()));
    let path = directory.join("config-gpui.toml");
    let result = (|| {
        let absent = directory.join("config.toml");
        Config::load_path(&path, &absent)?;
        assert_eq!(fs::read_to_string(&path)?, DEFAULT_CONFIG);
        let local = path.with_extension("local.toml");
        fs::write(&local, "theme = 'Nord'")?;
        fs::write(&path, format!("{MANAGED_HEADER}\ntheme = 'Dracula'"))?;
        assert_eq!(Config::load_path(&path, &absent)?.theme, "Nord");
        assert_eq!(fs::read_to_string(&path)?, DEFAULT_CONFIG);
        assert_eq!(fs::read_to_string(&local)?, "theme = 'Nord'");
        let theme_path = directory.join("custom-theme");
        fs::write(&theme_path, "background=112233")?;
        let config = Config {
            theme: theme_path.to_string_lossy().into_owned(),
            ..Config::default()
        };
        assert_eq!(config.theme(false)?.background, 0x112233);
        Ok(())
    })();
    fs::remove_dir_all(directory)?;
    result
}
