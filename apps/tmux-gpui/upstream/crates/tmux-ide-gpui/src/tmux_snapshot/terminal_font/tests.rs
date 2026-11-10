use super::*;
#[test]
fn preferences_roundtrip_and_invalid_load_preserves_file() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("gpui-fonts.json");
    let saved = Saved {
        version: 1,
        family: "Test Mono".into(),
        size: 18.,
    };
    write(&path, &saved)?;
    assert_eq!(read(&path)?.family, "Test Mono");
    assert_eq!(read(&path)?.size, 18.);
    assert!(
        write(
            &path,
            &Saved {
                version: 1,
                family: "bad\nfont".into(),
                size: 18.
            }
        )
        .is_err()
    );
    assert_eq!(read(&path)?.family, "Test Mono");
    std::fs::write(&path, r#"{"version":1,"family":"Test","size":100}"#)?;
    assert!(read(&path).is_err());
    Ok(())
}
#[test]
fn fontconfig_line_height_scales_with_size_and_preserves_fallbacks() {
    let mut font = Settings::default().config;
    font.fallbacks = Some(vec!["Symbols Nerd Font Mono".into()]);
    font.size = 21.;
    assert_eq!(font.line_height(), 26.25);
    assert!(font.font().fallbacks.is_some());
}
#[test]
fn the_default_is_twelve_on_fifteen_and_a_saved_size_wins() -> anyhow::Result<()> {
    // #746 v3: 12 pt on a 15 pt line by default.
    let default = Settings::default().config;
    assert_eq!(default.size, 12.);
    assert_eq!(default.line_height(), 15.);
    // A size the user saved wins over the default, on the same line multiple.
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("gpui-fonts.json");
    write(
        &path,
        &Saved {
            version: 1,
            family: "Test Mono".into(),
            size: 14.,
        },
    )?;
    let loaded = Settings::load_from(Some(path)).config;
    assert_eq!(loaded.size, 14.);
    assert_eq!(loaded.line_height(), 17.5);
    // With no saved file, the default stands.
    let missing = Settings::load_from(Some(dir.path().join("missing.json"))).config;
    assert_eq!(missing.size, 12.);
    Ok(())
}

#[path = "tests/choices.rs"]
mod choices;
