use super::*;
use crate::config::fonts::LINE_HEIGHT_RANGE;

#[test]
fn every_face_keeps_the_default_proportion_until_configured() -> anyhow::Result<()> {
    for config in [
        Config::default(),
        Config::parse("")?,
        Config::parse(DEFAULT_CONFIG)?,
    ] {
        for font in [&config.sidebar, &config.tabs, &config.terminal, &config.ui] {
            assert_eq!(font.line_height_multiple, None);
            assert_eq!(font.line_height(), font.size * 20.0 / 14.0);
        }
        assert_eq!(config.terminal.line_height(), 20.0);
    }
    Ok(())
}

#[test]
fn terminal_line_height_is_a_multiple_of_the_font_size() -> anyhow::Result<()> {
    let mut config = Config::parse("[terminal]\nsize = 16\nline_height = 1.25")?;
    assert_eq!(config.terminal.line_height_multiple, Some(1.25));
    assert_eq!(config.terminal.line_height(), 20.0);
    assert!(config.unknown_keys.is_empty(), "{:?}", config.unknown_keys);

    // A runtime size change, as Cmd-= makes, keeps the proportion.
    FontFace::Terminal.set_size(&mut config, 20.0);
    assert_eq!(config.terminal.line_height(), 25.0);

    // Both bounds are usable, and an integer is a whole multiple.
    for (text, multiple) in [
        ("line_height = 1", *LINE_HEIGHT_RANGE.start()),
        ("line_height = 2.0", *LINE_HEIGHT_RANGE.end()),
    ] {
        let config = Config::parse(&format!("[terminal]\nsize = 14\n{text}"))?;
        assert_eq!(config.terminal.line_height(), 14.0 * multiple);
    }
    Ok(())
}

#[test]
fn local_line_height_merges_over_managed_defaults() -> anyhow::Result<()> {
    let config = Config::parse_layers(
        [DEFAULT_CONFIG, "[terminal]\nline_height = 1.5"],
        &Daemon::default(),
    )?;
    // The managed file's size stays, and the local file adds the multiple.
    assert_eq!(config.terminal.size, 14.0);
    assert_eq!(config.terminal.line_height(), 21.0);
    Ok(())
}

#[test]
fn rejects_line_heights_outside_the_range() {
    for value in [
        "0.99", "2.01", "0", "-1.3", "nan", "inf", "'1.3'", "true", "[1.3]",
    ] {
        assert!(
            matches!(
                Config::parse(&format!("[terminal]\nline_height = {value}")),
                Err(Error::InvalidLineHeight("terminal"))
            ),
            "accepted line_height = {value}"
        );
    }
}

#[test]
fn line_height_outside_terminal_is_reported_and_ignored() -> anyhow::Result<()> {
    // Out of range too: an ignored key is never validated.
    let config = Config::parse(
        "[sidebar]\nline_height = 1.2\n[tabs]\nline_height = 1.2\n[ui]\nline_height = 9",
    )?;
    assert_eq!(
        config.unknown_keys,
        ["sidebar.line_height", "tabs.line_height", "ui.line_height"]
    );
    for font in [&config.sidebar, &config.tabs, &config.ui] {
        assert_eq!(font.line_height_multiple, None);
    }

    // Nor is its type checked: a quoted number is still only reported.
    let config = Config::parse(
        "[sidebar]\nline_height = '1.2'\n[tabs]\nline_height = true\n[ui]\nline_height = [1]",
    )?;
    assert_eq!(
        config.unknown_keys,
        ["sidebar.line_height", "tabs.line_height", "ui.line_height"]
    );
    Ok(())
}

#[test]
fn saving_a_font_size_keeps_the_line_height() -> anyhow::Result<()> {
    let directory = TempDirectory::new()?;
    let path = directory.0.join("config-gpui.local.toml");
    fs::write(
        &path,
        "[terminal]\nsize = 13\nline_height = 1.25 # tighter\n",
    )?;
    Config::save_font_sizes_path(&[(FontFace::Terminal, 16.)], &path)?;
    let saved = fs::read_to_string(&path)?;
    assert!(saved.contains("line_height = 1.25 # tighter"));
    assert_eq!(Config::parse(&saved)?.terminal.line_height(), 20.0);
    Ok(())
}
