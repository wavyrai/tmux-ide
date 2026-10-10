use super::*;

#[test]
fn primary_selection_text_contrasts_in_every_builtin_theme() {
    let luminance = |color: u32| {
        let channel = |shift: u32| ((color >> shift) & 255) as f32 / 255.;
        0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    };
    for name in Theme::BUILTIN_NAMES {
        let theme = Theme::builtin(name).unwrap_or_else(|| panic!("missing theme {name}"));
        assert_eq!(
            theme.primary(),
            theme.palette[5],
            "{name}: accent is ANSI 5"
        );
        // The tab fill is the softened wash, not the raw accent.
        let primary = theme.primary_wash();
        let text = theme.text_on(primary);
        assert_ne!(primary, theme.surface, "{name}: selection must be visible");
        assert_ne!(
            primary, theme.active,
            "{name}: selection must outrank hover"
        );
        assert!(
            text == theme.background || text == theme.foreground,
            "{name}: text must be one of the theme's own colors"
        );
        let gap = (luminance(text) - luminance(primary)).abs();
        let other = if text == theme.background {
            theme.foreground
        } else {
            theme.background
        };
        assert!(gap >= 0.3, "{name}: unreadable selection, gap {gap}");
        assert!(
            gap >= (luminance(other) - luminance(primary)).abs(),
            "{name}: the other text color contrasts more"
        );
    }
}

#[test]
fn contrast_parses_reaches_the_theme_and_saves_in_place() -> anyhow::Result<()> {
    assert_eq!(Config::parse("")?.contrast, Contrast::Standard);
    let high = Config::parse("theme = 'Catppuccin Latte'\ncontrast = 'high'")?;
    assert_eq!(high.contrast, Contrast::High);
    assert_eq!(high.theme(false)?.contrast, Contrast::High);
    assert!(Config::parse("contrast = 'loud'").is_err());
    assert!(Config::parse("contrast = true").is_err());

    let temp = TempDirectory::new()?;
    let path = temp.0.join("config.toml");
    let original = "theme = 'Nord' # keep\ncontrast = 'standard' # mine\n[usage]\nshow = false\n";
    fs::write(&path, original)?;
    Config::save_contrast_path(Contrast::High, &path)?;
    let saved = fs::read_to_string(&path)?;
    assert_eq!(saved, original.replace("'standard'", "\"high\""));
    assert_eq!(Config::parse(&saved)?.contrast, Contrast::High);
    assert!(!Config::parse(&saved)?.usage.show);
    fs::remove_file(&path)?;
    Config::save_contrast_path(Contrast::High, &path)?;
    let created = fs::read_to_string(&path)?;
    assert!(created.starts_with(LOCAL_CONFIG), "{created}");
    assert_eq!(Config::parse(&created)?.contrast, Contrast::High);
    Ok(())
}

#[test]
fn high_contrast_parts_selected_rows_and_lifts_dim_labels_on_every_theme() {
    let ratio = crate::contrast::ratio;
    for name in Theme::BUILTIN_NAMES {
        let standard = Theme::builtin(name).unwrap_or_else(|| panic!("missing {name}"));
        assert_eq!(standard.clone().with_contrast(Contrast::Standard), standard);
        let high = standard.clone().with_contrast(Contrast::High);
        // Terminal cells keep the program's colors.
        assert_eq!(high.palette, standard.palette);
        assert_eq!(
            (high.background, high.foreground, high.cursor, high.surface),
            (
                standard.background,
                standard.foreground,
                standard.cursor,
                standard.surface
            )
        );
        assert!(ratio(high.active, high.surface) > ratio(standard.active, standard.surface));
        for background in [high.background, high.surface, high.active] {
            assert!(ratio(high.muted, background) >= 4.5, "{name} muted");
            assert!(ratio(high.subtext(), background) >= 4.5, "{name} subtext");
            assert!(ratio(high.foreground, background) >= 4.5, "{name} text");
        }
    }
}

#[test]
fn saves_only_theme_and_preserves_latest_settings_and_comments() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config.toml");
    let config = Config::default();
    // These on-disk settings differ from the in-memory snapshot, including
    // a setting this version does not understand.
    let original = "# heading\ntheme = 'Default' # selection\nfuture = true\n\n[tabs] # fonts\nsize = 19 # keep\n\n[github] # public only\noauth_client_id = 'Iv1.fixture' # keep ID\n";
    fs::write(&path, original)?;
    config.save_theme_path("Nord", &path)?;
    assert_eq!(
        fs::read_to_string(&path)?,
        original.replace("'Default'", "\"Nord\"")
    );
    assert_eq!(config.theme, "Default");
    assert_eq!(fs::read_dir(&temp.0)?.count(), 1);

    fs::write(
        &path,
        "# no theme\n[tabs]\nsize = 19\n[github]\noauth_client_id = 'Iv1.fixture'\n",
    )?;
    config.save_theme_path("Dracula", &path)?;
    let saved = fs::read_to_string(&path)?;
    let parsed = Config::parse(&saved)?;
    assert_eq!(parsed.theme, "Dracula");
    assert_eq!(parsed.tabs.size, 19.0);
    assert_eq!(
        parsed.github.oauth_client_id.as_deref(),
        Some("Iv1.fixture")
    );
    assert!(saved.contains("# no theme"));
    Ok(())
}

#[test]
fn save_validates_theme_and_toml_before_writing() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config.toml");
    let config = Config::default();
    let custom = temp.0.join("custom");
    fs::write(&custom, "background=invalid")?;
    let custom_name = custom.to_str().context("non-UTF8 temporary path")?;
    for name in ["", "../invalid", custom_name] {
        assert!(config.save_theme_path(name, &path).is_err());
        assert!(!path.exists());
    }
    for text in ["theme = [", "theme = 'Nord'\ntheme = 'Dracula'\n"] {
        fs::write(&path, text)?;
        assert!(config.save_theme_path("Nord", &path).is_err());
        assert_eq!(fs::read_to_string(&path)?, text);
        assert_eq!(fs::read_dir(&temp.0)?.count(), 2);
    }
    fs::write(&custom, "background=112233")?;
    let new_path = temp.0.join("nested/config.toml");
    config.save_theme_path(custom_name, &new_path)?;
    assert_eq!(
        Config::parse(&fs::read_to_string(&new_path)?)?
            .theme(false)?
            .background,
        0x112233
    );
    assert_eq!(
        fs::read_dir(new_path.parent().context("missing parent")?)?.count(),
        1
    );
    Ok(())
}

#[test]
fn default_palette_and_builtins() -> anyhow::Result<()> {
    let default = Theme::default();
    assert_eq!(default.palette[16], 0);
    assert_eq!(default.palette[21], 0x0000ff);
    assert_eq!(default.palette[231], 0xffffff);
    assert_eq!(default.palette[232], 0x080808);
    assert_eq!(default.palette[255], 0xeeeeee);
    assert_eq!(default.surface, 0x1c1c22);
    for name in ["Nord", "Dracula", "Catppuccin Mocha", "Catppuccin Latte"] {
        let theme = Config {
            theme: name.into(),
            ..Config::default()
        }
        .theme(false)?;
        assert_ne!(theme, default);
        assert_ne!(theme.surface, theme.background);
        assert_eq!(theme.palette[255], default.palette[255]);
    }
    Ok(())
}

#[test]
fn ghostty_colors_and_ignored_settings() -> anyhow::Result<()> {
    let theme = Theme::parse_ghostty(
        "# comment\nbackground = #123aBC\nforeground=abcdef\n\
             palette = 0 = #010203\npalette=255=fefefe\npalette=0=040506\n\
             font-size = nonsense\nconfig-file = /do/not/read\nignored line",
    )?;
    assert_eq!(theme.background, 0x123abc);
    assert_eq!(theme.foreground, 0xabcdef);
    assert_eq!(theme.cursor, theme.foreground);
    assert_eq!(theme.palette[0], 0x040506);
    assert_eq!(theme.palette[255], 0xfefefe);
    assert_eq!(
        Theme::parse_ghostty("cursor-color=#ffffff")?.cursor,
        0xffffff
    );
    Ok(())
}

#[test]
fn ghostty_errors_have_line_numbers() {
    for line in [
        "background=red",
        "foreground=#fff",
        "cursor-color=0x123456",
        "palette=256=ffffff",
        "palette=-1=ffffff",
        "palette=0=oops",
        "palette=ffffff",
        "background",
        "foreground=#12345678",
    ] {
        let result = Theme::parse_ghostty(&format!("# comment\n{line}"));
        assert!(
            matches!(result, Err(Error::ThemeLine { line: 2, .. })),
            "{result:?}"
        );
    }
}

#[test]
fn theme_save_updates_only_local_overrides() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config-gpui.toml");
    let daemon = temp.0.join("absent.toml");
    let legacy = "# user fonts\n[terminal]\nsize = 19 # keep\n";
    fs::write(&path, legacy)?;
    Config::default().save_theme_at("Nord", &path)?;
    assert_eq!(fs::read_to_string(&path)?, DEFAULT_CONFIG);
    let local = fs::read_to_string(path.with_extension("local.toml"))?;
    assert!(local.contains("# user fonts"));
    assert!(local.contains("size = 19 # keep"));
    let config = Config::load_path(&path, &daemon)?;
    assert_eq!(config.theme, "Nord");
    assert_eq!(config.terminal.size, 19.);
    Ok(())
}
