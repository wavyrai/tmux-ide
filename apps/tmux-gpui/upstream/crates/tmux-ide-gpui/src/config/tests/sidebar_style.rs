use super::*;
use crate::config::{SelectMode, SidebarOverrides, SidebarStyle};

#[test]
fn sidebar_style_defaults_to_the_preset() -> anyhow::Result<()> {
    for config in [
        Config::default(),
        Config::parse("")?,
        Config::parse(DEFAULT_CONFIG)?,
        Config::parse("[sidebar]\nsize = 14")?,
    ] {
        assert_eq!(config.sidebar_style, SidebarStyle::default());
        assert_eq!(config.sidebar_style.overrides, SidebarOverrides::default());
        assert_eq!(config.sidebar_style.select, SelectMode::Row);
        assert!(config.sidebar_style.hosts.is_empty());
    }
    // The font keys the table already carried keep working beside the new ones.
    let config = Config::parse("[sidebar]\nsize = 14\nindent = 20")?;
    assert_eq!(config.sidebar.size, 14.);
    assert_eq!(config.sidebar_style.overrides.indent, Some(20.));
    Ok(())
}

#[test]
fn sidebar_spacing_keys_accept_their_bands() -> anyhow::Result<()> {
    for (key, max) in [
        ("indent", 48.),
        ("row_padding", 16.),
        ("gap", 32.),
        ("host_gap", 48.),
    ] {
        for value in [0., 7.5, max] {
            let config = Config::parse(&format!("[sidebar]\n{key} = {value}"))?;
            let overrides = config.sidebar_style.overrides;
            let got = match key {
                "indent" => overrides.indent,
                "row_padding" => overrides.row_padding,
                "gap" => overrides.gap,
                _ => overrides.host_gap,
            };
            assert_eq!(got, Some(value), "{key} = {value}");
        }
        for text in [
            format!("{key} = {}", max + 0.1),
            format!("{key} = -1"),
            format!("{key} = nan"),
        ] {
            assert!(
                matches!(
                    Config::parse(&format!("[sidebar]\n{text}")),
                    Err(Error::InvalidSidebarMetric { key: bad, .. }) if bad == key
                ),
                "{text}"
            );
        }
    }
    Ok(())
}

#[test]
fn sidebar_select_mode_is_named() -> anyhow::Result<()> {
    for (name, mode) in [
        ("row", SelectMode::Row),
        ("group", SelectMode::Group),
        ("group-dim", SelectMode::GroupDim),
    ] {
        assert_eq!(
            Config::parse(&format!("[sidebar]\nselect = \"{name}\""))?
                .sidebar_style
                .select,
            mode
        );
    }
    assert!(Config::parse("[sidebar]\nselect = \"whole\"").is_err());
    Ok(())
}

#[test]
fn host_colours_parse_hex_and_keep_unknown_hosts() -> anyhow::Result<()> {
    let config = Config::parse(
        "[sidebar.hosts]\nPersonal = \"#abc\"\nWork = \"#AaBbCc\"\n\"Mac mini\" = \"#102030\"",
    )?;
    let hosts = &config.sidebar_style.hosts;
    assert_eq!(hosts.get("Personal"), Some(&0xaabbcc));
    assert_eq!(hosts.get("Work"), Some(&0xaabbcc));
    assert_eq!(hosts.get("Mac mini"), Some(&0x102030));
    // A host that is not connected is simply never looked up.
    assert_eq!(hosts.get("Nowhere"), None);
    for bad in ["red", "#12", "#12345", "123456", "#gggggg"] {
        assert!(
            matches!(
                Config::parse(&format!("[sidebar.hosts]\nPersonal = \"{bad}\"")),
                Err(Error::InvalidHostColor { host, .. }) if host == "Personal"
            ),
            "{bad}"
        );
    }
    Ok(())
}

#[test]
fn unknown_sidebar_keys_are_still_reported() -> anyhow::Result<()> {
    let config = Config::parse("[sidebar]\nindent = 4\nindnet = 4")?;
    assert_eq!(config.unknown_keys, vec!["sidebar.indnet".to_owned()]);
    Ok(())
}

#[test]
fn saving_a_layout_keeps_sidebar_style_keys() -> anyhow::Result<()> {
    let directory = TempDirectory::new()?;
    let path = directory.0.join("config-gpui.toml");
    let local = path.with_extension("local.toml");
    fs::write(
        &local,
        "[sidebar]\nindent = 20\nselect = \"group\"\n\n[sidebar.hosts]\nPersonal = \"#abc\"\n",
    )?;
    Config::save_layout_path(LayoutMode::Orca, &local)?;
    let text = fs::read_to_string(&local)?;
    assert!(text.contains("indent = 20"), "{text}");
    assert!(text.contains("select = \"group\""), "{text}");
    assert!(text.contains("Personal = \"#abc\""), "{text}");
    let config = Config::parse(&text)?;
    assert_eq!(config.layout.mode, LayoutMode::Orca);
    assert_eq!(config.sidebar_style.overrides.indent, Some(20.));
    Ok(())
}
