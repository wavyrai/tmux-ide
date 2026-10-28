use super::*;
use crate::config::fonts::MAX_FONT_FALLBACKS;

#[test]
fn font_family_saves_and_reset_preserve_other_overrides() -> anyhow::Result<()> {
    let directory = TempDirectory::new()?;
    let path = directory.0.join("config-gpui.local.toml");
    let original = "# keep me\ntheme = 'Nord'\n\n[terminal]\nsize = 18 # size comment\nfamily = 'Old' # family comment\n";
    fs::write(&path, original)?;
    for face in [
        FontFace::Sidebar,
        FontFace::Tabs,
        FontFace::Terminal,
        FontFace::Ui,
    ] {
        Config::save_font_family_path(face, Some("Any Installed Font"), &path)?;
        let text = fs::read_to_string(&path)?;
        let document = text.parse::<toml_edit::DocumentMut>()?;
        assert_eq!(
            document[face.name()]["family"].as_str(),
            Some("Any Installed Font")
        );
        assert!(text.contains("# keep me"));
        assert!(text.contains("size = 18 # size comment"));
        Config::save_font_family_path(face, None, &path)?;
        let text = fs::read_to_string(&path)?;
        let document = text.parse::<toml_edit::DocumentMut>()?;
        assert!(
            document
                .get(face.name())
                .and_then(|item| item.get("family"))
                .is_none()
        );
        assert!(text.contains("# keep me"));
        assert!(text.contains("size = 18 # size comment"));
    }
    Ok(())
}

#[test]
fn all_font_families_save_and_reset_in_one_document() -> anyhow::Result<()> {
    let directory = TempDirectory::new()?;
    let path = directory.0.join("config-gpui.local.toml");
    fs::write(
        &path,
        "# keep\n[terminal]\nsize = 18 # keep size\nfamily = 'Old'\n",
    )?;
    let faces = [
        FontFace::Sidebar,
        FontFace::Tabs,
        FontFace::Terminal,
        FontFace::Ui,
    ];
    Config::save_font_families_path(&faces, Some("Shared"), &path)?;
    let document = fs::read_to_string(&path)?;
    let parsed = document.parse::<toml_edit::DocumentMut>()?;
    for face in faces {
        assert_eq!(parsed[face.name()]["family"].as_str(), Some("Shared"));
    }
    Config::save_font_family_path(FontFace::Tabs, Some("Independent"), &path)?;
    let parsed = fs::read_to_string(&path)?.parse::<toml_edit::DocumentMut>()?;
    assert_eq!(parsed["tabs"]["family"].as_str(), Some("Independent"));
    assert_eq!(parsed["terminal"]["family"].as_str(), Some("Shared"));
    Config::save_font_families_path(&faces, None, &path)?;
    let text = fs::read_to_string(&path)?;
    let parsed = text.parse::<toml_edit::DocumentMut>()?;
    for face in faces {
        assert!(
            parsed
                .get(face.name())
                .and_then(|item| item.get("family"))
                .is_none()
        );
    }
    assert!(text.contains("# keep"));
    assert!(text.contains("size = 18 # keep size"));
    Ok(())
}

#[test]
fn font_size_saves_preserve_other_overrides_and_comments() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config.toml");
    let original = "# user settings\ntheme = 'Nord'\nfuture = true\n\n[tabs] # keep table\nsize = 19 # keep size\nfamily = 'Custom'\n";
    fs::write(&path, original)?;
    for (face, size) in [
        (FontFace::Sidebar, 8.),
        (FontFace::Tabs, 20.),
        (FontFace::Terminal, 48.),
        (FontFace::Ui, 14.),
    ] {
        Config::save_font_sizes_path(&[(face, size)], &path)?;
        let text = fs::read_to_string(&path)?;
        let known = text.replace("future = true\n", "");
        assert_eq!(
            face.size(&Config::parse_layers(
                [DEFAULT_CONFIG, &known],
                &Daemon::default()
            )?),
            size
        );
        assert!(text.contains("future = true"));
        assert!(text.contains("family = 'Custom'"));
        assert!(text.contains("[tabs] # keep table"));
        assert!(text.contains("size = 20.0 # keep size") || face != FontFace::Tabs);
    }
    let before = fs::read_to_string(&path)?;
    for invalid in [7., 49., f32::NAN, f32::INFINITY] {
        assert!(Config::save_font_sizes_path(&[(FontFace::Tabs, invalid)], &path).is_err());
        assert_eq!(fs::read_to_string(&path)?, before);
    }
    Ok(())
}

#[test]
fn font_size_batches_validate_every_change_before_writing() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config-gpui.local.toml");
    let original = "# retained\ntheme = 'Nord'\n[sidebar]\nsize = 12 # retained size\n";
    fs::write(&path, original)?;
    assert!(matches!(
        Config::save_font_sizes_path(&[(FontFace::Sidebar, 14.), (FontFace::Ui, 49.)], &path),
        Err(Error::InvalidFontSize("ui"))
    ));
    assert_eq!(fs::read_to_string(&path)?, original);
    Config::save_font_sizes_path(&[(FontFace::Sidebar, 14.), (FontFace::Ui, 20.)], &path)?;
    let saved = fs::read_to_string(&path)?;
    let config = Config::parse(&saved)?;
    assert_eq!((config.sidebar.size, config.ui.size), (14., 20.));
    assert!(saved.contains("size = 14.0 # retained size"));
    assert!(saved.contains("theme = 'Nord'"));
    Ok(())
}

/// Installed families as macOS reports them, in arbitrary order.
fn installed() -> Vec<String> {
    [
        "Menlo",
        "Zapfino",
        "JetBrainsMono Nerd Font Propo",
        "Symbols Nerd Font",
        "Hack Nerd Font Mono",
        "Symbols Nerd Font Mono",
        "Agave Nerd Font Mono",
        "Hack Nerd Font Mono",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[test]
fn detection_ranks_symbol_and_mono_faces_and_ignores_text_families() {
    // Symbols first, then single-cell Mono faces, alphabetical within each
    // rank, deduplicated, and capped so the cascade stays short.
    assert_eq!(
        symbol_fallbacks(installed()),
        [
            "Symbols Nerd Font Mono",
            "Symbols Nerd Font",
            "Agave Nerd Font Mono",
        ]
    );
    assert!(symbol_fallbacks(["Menlo".to_owned(), "Zapfino".to_owned()]).is_empty());
}

#[test]
fn detection_fills_only_the_faces_the_config_left_alone() -> anyhow::Result<()> {
    let mut config = Config::parse("[terminal]\nfallback = ['Menlo']\n[ui]\nfallback = []")?;
    config.resolve_fonts(installed);
    assert_eq!(
        config.terminal.fallbacks.as_deref(),
        Some(["Menlo".to_owned()].as_slice())
    );
    // An explicit empty list opts out; it is not "unset".
    assert_eq!(config.ui.fallbacks.as_deref(), Some([].as_slice()));
    assert_eq!(config.ui.font().fallbacks, None);
    let detected = symbol_fallbacks(installed());
    assert_eq!(
        config.sidebar.fallbacks.as_deref(),
        Some(detected.as_slice())
    );
    assert_eq!(config.tabs.fallbacks.as_deref(), Some(detected.as_slice()));
    Ok(())
}

#[test]
fn detection_does_not_enumerate_fonts_when_every_face_is_configured() -> anyhow::Result<()> {
    // Enumerating installed families is slow, so a fully configured file
    // must not pay for it, even on Linux where defaults are checked.
    let mut config = Config::parse(
        "[sidebar]\nfamily = 'A'\nfallback = []\n[tabs]\nfamily = 'A'\nfallback = []\n\
             [terminal]\nfamily = 'A'\nfallback = []\n[ui]\nfamily = 'A'\nfallback = []",
    )?;
    config.resolve_fonts(|| -> Vec<String> { panic!("enumerated installed fonts") });
    Ok(())
}

#[test]
fn configured_fallbacks_reach_the_shaping_font_in_order() -> anyhow::Result<()> {
    let config =
        Config::parse("[terminal]\nfallback = ['Symbols Nerd Font Mono', 'Hack Nerd Font Mono']")?;
    let font = config.terminal.font();
    assert_eq!(font.family, config.terminal.family);
    let fallbacks = font
        .fallbacks
        .ok_or_else(|| anyhow::anyhow!("missing cascade"))?;
    assert_eq!(
        fallbacks.fallback_list(),
        ["Symbols Nerd Font Mono", "Hack Nerd Font Mono"]
    );
    // The default face shapes without a cascade until one is resolved.
    assert_eq!(Config::default().terminal.font().fallbacks, None);
    Ok(())
}

#[test]
fn fallback_lists_are_validated_per_face() {
    assert!(matches!(
        Config::parse("[terminal]\nfallback = ['Menlo', '  ']"),
        Err(Error::EmptyFontFallback("terminal"))
    ));
    let list = |count: usize| {
        (0..count)
            .map(|index| format!("'face{index}'"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    assert!(matches!(
        Config::parse(&format!(
            "[sidebar]\nfallback = [{}]",
            list(MAX_FONT_FALLBACKS + 1)
        )),
        Err(Error::TooManyFontFallbacks("sidebar"))
    ));
    assert!(
        Config::parse(&format!(
            "[sidebar]\nfallback = [{}]",
            list(MAX_FONT_FALLBACKS)
        ))
        .is_ok()
    );
}

#[test]
fn defaults_and_partial_settings() -> anyhow::Result<()> {
    // Sidebar, tabs, terminal, ui: only the status bar and modals are sans.
    #[cfg(target_os = "linux")]
    let families = [
        "DejaVu Sans Mono",
        "DejaVu Sans Mono",
        "DejaVu Sans Mono",
        "DejaVu Sans",
    ];
    #[cfg(windows)]
    let families = [
        "Cascadia Mono",
        "Cascadia Mono",
        "Cascadia Mono",
        ".SystemUIFont",
    ];
    #[cfg(not(any(target_os = "linux", windows)))]
    let families = ["Menlo", "Menlo", "Menlo", ".SystemUIFont"];

    for config in [
        Config::default(),
        Config::parse("")?,
        Config::parse(DEFAULT_CONFIG)?,
    ] {
        assert_eq!(config.theme(false)?, Theme::default());
        assert!(config.github.oauth_client_id.is_none());
        // Every feature ships off, including in the example config.
        assert_eq!(config.features, Features::default());
        assert!(!config.features.sidebar_hover_menu);
        assert_eq!(config.terminal.line_height(), 20.0);
        for ((font, family), size) in [config.sidebar, config.tabs, config.terminal, config.ui]
            .into_iter()
            .zip(families)
            .zip([12.0, 12.0, 14.0, 12.0])
        {
            assert_eq!(font.family, family);
            assert_eq!(font.size, size);
        }
    }

    for settings in ["", "size = 18", "family = 'Custom Font'"] {
        let text = ["sidebar", "tabs", "terminal", "ui"]
            .map(|section| format!("[{section}]\n{settings}\n"))
            .join("\n");
        let config = Config::parse(&text)?;
        for ((font, family), size) in [config.sidebar, config.tabs, config.terminal, config.ui]
            .into_iter()
            .zip(families)
            .zip([12.0, 12.0, 14.0, 12.0])
        {
            assert_eq!(
                font.family,
                if settings.starts_with("family") {
                    "Custom Font"
                } else {
                    family
                }
            );
            assert_eq!(
                font.size,
                if settings.starts_with("size") {
                    18.0
                } else {
                    size
                }
            );
        }
    }
    Ok(())
}
