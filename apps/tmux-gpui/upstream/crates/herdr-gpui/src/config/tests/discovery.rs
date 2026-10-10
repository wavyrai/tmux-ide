use super::*;

#[cfg(windows)]
#[test]
fn shared_windows_config_path_matches_upstream_roaming_layout() {
    let vars = [
        ("USERPROFILE", r"C:\Users\test"),
        ("APPDATA", r"C:\Roaming"),
        ("XDG_CONFIG_HOME", r"C:\xdg"),
        ("HERDR_CONFIG_PATH", r"C:\explicit.toml"),
    ];
    for (count, expected) in [
        (1, r"C:\Users\test\AppData\Roaming\herdr\config.toml"),
        (2, r"C:\Roaming\herdr\config.toml"),
        (3, r"C:\xdg\herdr\config.toml"),
        (4, r"C:\explicit.toml"),
    ] {
        assert_eq!(
            daemon_config_path(|key| vars[..count]
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| (*value).into())),
            PathBuf::from(expected)
        );
    }
}

#[test]
fn discovers_sorted_names_and_loads_in_precedence_order() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let first = temp.0.join("first");
    let second = temp.0.join("second");
    fs::create_dir(&first)?;
    fs::create_dir(&second)?;
    fs::create_dir(first.join("not-a-theme"))?;
    for name in ["zebra", "alpha", "Nord"] {
        fs::write(first.join(name), "background=112233")?;
    }
    fs::write(second.join("Alpha"), "background=445566")?;
    fs::write(second.join("zebra"), "background=445566")?;
    let directories = vec![temp.0.join("missing"), first, second];
    let config = Config {
        theme: "alpha".into(),
        ..Config::default()
    };
    assert_eq!(
        config.available_themes_in(&directories)?,
        vec![
            "Alpha",
            "alpha",
            "Catppuccin Latte",
            "Catppuccin Mocha",
            "Default",
            "Dracula",
            "Follow Herdr",
            "Nord",
            "zebra",
        ]
    );
    assert_eq!(
        config
            .theme_with_directories(false, || Ok(directories.clone()))?
            .background,
        0x112233
    );
    let builtin = Config {
        theme: "Nord".into(),
        ..Config::default()
    };
    assert_eq!(
        builtin.theme_with_directories(false, || Ok(directories))?,
        Theme::builtin("Nord").context("missing builtin")?
    );
    Ok(())
}

#[test]
fn discovery_includes_explicit_selection_and_reports_errors() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    for name in [
        temp.0.join("custom").to_string_lossy().into_owned(),
        "~/custom".into(),
    ] {
        let config = Config {
            theme: name.clone(),
            ..Config::default()
        };
        assert!(config.available_themes_in(&[])?.contains(&name));
    }
    let not_directory = temp.0.join("file");
    fs::write(&not_directory, "")?;
    assert!(
        Config::default()
            .available_themes_in(&[not_directory])
            .is_err()
    );
    for name in Theme::BUILTIN_NAMES {
        let config = Config {
            theme: (*name).into(),
            ..Config::default()
        };
        assert!(
            config
                .theme_with_directories(false, || Err(Error::MissingHome))
                .is_ok()
        );
    }
    Ok(())
}
