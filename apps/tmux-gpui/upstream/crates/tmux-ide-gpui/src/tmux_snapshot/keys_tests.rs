use super::*;
#[test]
fn maps_text_control_and_navigation_without_platform_shortcuts() -> anyhow::Result<()> {
    assert_eq!(
        translate(&Keystroke::parse("a")?),
        Some(Input::Text("a".into()))
    );
    assert_eq!(
        translate(&Keystroke::parse("shift-a")?),
        Some(Input::Text("A".into()))
    );
    assert_eq!(
        translate(&Keystroke::parse("ctrl-c")?),
        Some(Input::Key("C-c".into()))
    );
    assert_eq!(
        translate(&Keystroke::parse("enter")?),
        Some(Input::Key("Enter".into()))
    );
    assert_eq!(translate(&Keystroke::parse("cmd-v")?), None);
    Ok(())
}

#[test]
fn clipboard_admission_is_bounded_and_preserves_unicode() {
    assert_eq!(
        clipboard_text("界\n🌍".into()),
        Some(Input::Paste("界\n🌍".into()))
    );
    for text in [
        String::new(),
        "\0".into(),
        "\u{1b}[201~".into(),
        "界".repeat(22000),
    ] {
        assert_eq!(clipboard_text(text), None);
    }
    assert!(clipboard_text("a".repeat(65536)).is_some());
}

#[test]
fn maps_function_keys_control_punctuation_and_layout_text() -> anyhow::Result<()> {
    for n in 1..=12 {
        assert_eq!(
            translate(&Keystroke::parse(&format!("f{n}"))?),
            Some(Input::Key(format!("F{n}")))
        );
    }
    assert_eq!(
        translate(&Keystroke::parse("ctrl-[")?),
        Some(Input::Bytes("1b".into()))
    );
    assert_eq!(
        translate(&Keystroke::parse("ctrl-_")?),
        Some(Input::Bytes("1f".into()))
    );
    let mut key = Keystroke::parse("shift-1")?;
    key.key_char = Some("!".into());
    assert_eq!(translate(&key), Some(Input::Text("!".into())));
    key.key_char = Some("界".into());
    assert_eq!(translate(&key), Some(Input::Text("界".into())));
    Ok(())
}
