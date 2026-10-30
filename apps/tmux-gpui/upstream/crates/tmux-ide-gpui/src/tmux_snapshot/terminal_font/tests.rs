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
    assert_eq!(font.line_height(), 30.);
    assert!(font.font().fallbacks.is_some());
}

#[path = "tests/choices.rs"]
mod choices;
