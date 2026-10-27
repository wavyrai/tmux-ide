use super::*;

#[test]
fn usage_visibility_preserves_settings_and_rejects_invalid_tables() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config.toml");
    let original =
        "theme = 'Nord' # keep\n[usage]\nshow = true # visibility\nhide_providers = ['claude']\n";
    fs::write(&path, original)?;
    Config::save_usage_visibility_path(false, &path)?;
    assert_eq!(
        fs::read_to_string(&path)?,
        original.replace("show = true", "show = false")
    );
    assert!(!Config::parse(&fs::read_to_string(&path)?)?.usage.show);
    Config::save_usage_visibility_path(true, &path)?;
    assert_eq!(fs::read_to_string(&path)?, original);
    for original in [
        "theme = 'Nord'\n",
        "usage = { show = true, browser_cookies = false }\n",
    ] {
        fs::write(&path, original)?;
        Config::save_usage_visibility_path(false, &path)?;
        assert!(!Config::parse(&fs::read_to_string(&path)?)?.usage.show);
    }
    fs::write(&path, "usage = false\n")?;
    let error = Config::save_usage_visibility_path(false, &path)
        .err()
        .context("invalid usage table must be rejected")?;
    assert!(matches!(&error, Error::Path { path: failed, source }
        if failed == &path && matches!(**source, Error::InvalidUsageTable)));
    assert!(std::error::Error::source(&error).is_some());
    assert_eq!(fs::read_to_string(&path)?, "usage = false\n");
    Ok(())
}

#[test]
fn show_agents_saves_in_place_and_keeps_other_settings() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config.toml");
    let original = "theme = 'Nord' # keep\nshow_agents = true # mine\n[usage]\nshow = false\n";
    fs::write(&path, original)?;
    Config::save_show_agents_path(false, &path)?;
    let saved = fs::read_to_string(&path)?;
    assert_eq!(
        saved,
        original.replace("show_agents = true", "show_agents = false")
    );
    let config = Config::parse(&saved)?;
    assert!(!config.show_agents);
    assert!(!config.usage.show);
    Config::save_show_agents_path(true, &path)?;
    assert_eq!(fs::read_to_string(&path)?, original);

    // A key added to a file with tables must stay top-level, not join [usage].
    fs::write(&path, "theme = 'Nord'\n[usage]\nshow = true\n")?;
    Config::save_show_agents_path(false, &path)?;
    let config = Config::parse(&fs::read_to_string(&path)?)?;
    assert!(!config.show_agents);
    assert!(config.usage.show);

    fs::remove_file(&path)?;
    Config::save_show_agents_path(false, &path)?;
    let created = fs::read_to_string(&path)?;
    assert!(created.starts_with(LOCAL_CONFIG), "{created}");
    assert!(!Config::parse(&created)?.show_agents);
    Ok(())
}

#[test]
fn appearance_and_close_options_preserve_defaults() -> anyhow::Result<()> {
    for config in [
        Config::default(),
        Config::parse("")?,
        Config::parse(DEFAULT_CONFIG)?,
    ] {
        assert!(config.confirm_close_tab);
        assert!(config.confirm_close_pane);
        assert!(config.show_agents);
    }
    let config = Config::parse("confirm_close_tab = false\nshow_agents = false")?;
    assert!(!config.confirm_close_tab);
    assert!(config.confirm_close_pane);
    assert!(!config.show_agents);
    let config = Config::parse("confirm_close_pane = false")?;
    assert!(config.confirm_close_tab);
    assert!(!config.confirm_close_pane);
    assert!(Config::parse("confirm_close_tab = 'false'").is_err());
    assert!(Config::parse("confirm_close_pane = 0").is_err());
    assert!(Config::parse("show_agents = 0").is_err());
    Ok(())
}

#[test]
fn links_open_in_the_system_browser_unless_configured() -> anyhow::Result<()> {
    assert_eq!(Config::parse("")?.open_links_in, LinkTarget::System);
    assert_eq!(
        Config::parse(DEFAULT_CONFIG)?.open_links_in,
        LinkTarget::System
    );
    assert_eq!(
        Config::parse("open_links_in = \"browser-tab\"")?.open_links_in,
        LinkTarget::BrowserTab
    );
    assert!(Config::parse("open_links_in = \"tab\"").is_err());
    Ok(())
}

#[test]
fn selections_stay_after_copy_unless_configured() -> anyhow::Result<()> {
    assert!(Config::parse("")?.keep_selection_after_copy);
    assert!(Config::parse(DEFAULT_CONFIG)?.keep_selection_after_copy);
    assert!(!Config::parse("keep_selection_after_copy = false")?.keep_selection_after_copy);
    assert!(Config::parse("keep_selection_after_copy = 'no'").is_err());
    Ok(())
}

#[test]
fn option_as_alt_accepts_auto_a_side_or_a_bool() -> anyhow::Result<()> {
    assert_eq!(Config::parse("")?.option_as_alt, OptionAsAlt::Auto);
    assert_eq!(
        Config::parse(DEFAULT_CONFIG)?.option_as_alt,
        OptionAsAlt::Auto
    );
    for (value, expected) in [
        ("'auto'", OptionAsAlt::Auto),
        ("true", OptionAsAlt::Always),
        ("false", OptionAsAlt::Never),
        ("'left'", OptionAsAlt::Left),
        ("'right'", OptionAsAlt::Right),
    ] {
        let config = Config::parse(&format!("option_as_alt = {value}"))?;
        assert_eq!(config.option_as_alt, expected);
    }
    for value in ["'both'", "'true'", "1"] {
        assert!(Config::parse(&format!("option_as_alt = {value}")).is_err());
    }
    Ok(())
}

#[test]
fn rejects_invalid_settings() {
    for text in [
        "theme = ''",
        "[ui]\nfamily = '  '",
        "[tabs]\nsize = 7.9",
        "[terminal]\nsize = 48.1",
        "[sidebar]\nsize = nan",
        "[sidebar]\nsize = inf",
        "[sidebar]\nsize = -inf",
        "[tabs]\nsize = '14'",
        "[tabs]\nfamily = 14",
        "[github]\nclient_secret = 'not-allowed'",
        "[github]\nprivate_key = 'not-allowed'",
        "[github]\ntoken = 'not-allowed'",
        "[github]\noauth_client_id = 123",
        "[github]\noauth_client_id = ''",
        "[github]\noauth_client_id = ' bad-id'",
        "[github]\noauth_client_id = 'bad/id'",
        "[github]\noauth_client_id = '\u{e9}'",
        "[features]\nsidebar_hover_menu = 'true'",
        "[features]\nsidebar_hover_menu = 1",
        "[layout]\nsidebar_gap = -1",
        "[layout]\nsidebar_gap = 65",
        "[layout]\nsidebar_gap = inf",
        "[layout]\nsidebar_gap = '8'",
    ] {
        assert!(Config::parse(text).is_err(), "accepted {text:?}");
    }
    assert!(Config::parse("[tabs]\nsize = 8\n[ui]\nsize = 48").is_ok());
}

#[test]
fn features_are_opt_in_per_flag() -> anyhow::Result<()> {
    assert!(!Config::parse("[features]")?.features.sidebar_hover_menu);
    let config = Config::parse("[features]\nsidebar_hover_menu = true")?;
    assert!(config.features.sidebar_hover_menu);
    // Turning a flag on leaves the rest of the settings at their defaults.
    assert_eq!(config.theme, Config::default().theme);
    assert!(
        !Config::parse("[features]\nsidebar_hover_menu = false")?
            .features
            .sidebar_hover_menu
    );
    Ok(())
}

#[test]
fn palette_defaults_overrides_and_validation() -> anyhow::Result<()> {
    let defaults = Config::parse("")?;
    assert!(defaults.palette.double_shift);
    assert!(defaults.palette.project_roots.is_empty());
    let config = Config::parse(
        "[palette]\ndouble_shift = false\nproject_roots = ['~/Code', '$HOME/Projects']",
    )?;
    assert!(!config.palette.double_shift);
    assert_eq!(config.palette.project_roots, ["~/Code", "$HOME/Projects"]);
    for text in [
        "[palette]\nproject_roots = ['']",
        "[palette]\nproject_roots = ['   ']",
        "[palette]\nproject_roots = ['x', 1]",
        "[palette]\ndouble_shift = 'yes'",
    ] {
        assert!(Config::parse(text).is_err(), "{text}");
    }
    assert_eq!(
        Config::parse("[palette]\nunknown = true")?.unknown_keys,
        ["palette.unknown"]
    );
    assert!(matches!(
        Config::parse(&format!(
            "[palette]\nproject_roots = [{}]",
            vec!["'x'"; 17].join(",")
        )),
        Err(Error::PaletteProjectRoots)
    ));
    Ok(())
}
