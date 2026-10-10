use super::*;

#[test]
fn ghostty_bold_color_is_optional() -> anyhow::Result<()> {
    assert_eq!(Theme::parse_ghostty("foreground=#999999")?.bold, None);
    assert_eq!(
        Theme::parse_ghostty("bold-color = #FFFFFF")?.bold,
        Some(0xffffff)
    );
    // Ghostty's bold-is-bright spelling loads but leaves bold on the foreground.
    assert_eq!(Theme::parse_ghostty("bold-color = bright")?.bold, None);
    Ok(())
}

#[test]
fn ghostty_bold_color_rejects_non_hex_values() {
    for line in ["bold-color=white", "bold-color=#fff", "bold-color=0x123456"] {
        let result = Theme::parse_ghostty(&format!("# comment\n{line}"));
        assert!(
            matches!(result, Err(Error::ThemeLine { line: 2, .. })),
            "{result:?}"
        );
    }
}
