#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("native-appearance-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn config(&self) -> PathBuf {
        self.0.join("config.json")
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn every_generated_palette_is_valid_and_system_changes_do_not_write() {
    let mut owner = Owner::load(None).unwrap();
    assert!(owner.publication().valid());
    assert_eq!(owner.state.selected, "system");
    let dark = owner.state.theme.background;
    assert!(owner.system(System::Light));
    assert_ne!(owner.state.theme.background, dark);
    assert!(!owner.system(System::Light));
    for p in &owner.presets {
        assert_eq!(p.dark.palette.len(), 256);
        assert_eq!(&p.dark.palette[16..], &p.light.palette[16..]);
        if p.id != "system" {
            assert_eq!(p.dark.background, p.light.background);
        }
    }
}
#[test]
fn save_preserves_unrelated_fields_and_restores_in_a_new_owner() {
    let scratch = Scratch::new();
    let path = scratch.config();
    fs::write(
        &path,
        br#"{"theme":{"mode":"dark","automaticContrast":false},"unrelated":{"keep":42}}"#,
    )
    .unwrap();
    let mut owner = Owner::load(Some(path.clone())).unwrap();
    owner.select("nord");
    assert_eq!(owner.state.selected, "nord");
    assert!(owner.state.error.is_none());
    let raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(raw["theme"]["automaticContrast"], false);
    assert_eq!(raw["unrelated"]["keep"], 42);
    assert_eq!(
        Owner::load(Some(path.clone())).unwrap().state.selected,
        "nord"
    );
    owner.select("light");
    let before = fs::read(&path).unwrap();
    owner.system(System::Light);
    owner.system(System::Dark);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(Owner::load(Some(path)).unwrap().state.selected, "light");
    assert_eq!(fs::read_dir(&scratch.0).unwrap().count(), 1);
}
#[test]
fn failed_save_and_unknown_selection_retain_applied_theme_without_raw_errors() {
    let scratch = Scratch::new();
    let path = scratch.config();
    let mut owner = Owner::load(Some(path.clone())).unwrap();
    owner.select("dark");
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    owner.select("nord");
    assert_eq!(owner.state.selected, "dark");
    assert_eq!(
        owner.state.error.as_deref(),
        Some("Could not save theme — try again")
    );
    owner.select("unknown");
    assert_eq!(owner.state.selected, "dark");
    assert_eq!(
        owner.state.error.as_deref(),
        Some("Unknown theme — choose an available theme")
    );
}
#[test]
fn malformed_or_oversized_config_is_not_destroyed_by_a_save() {
    let scratch = Scratch::new();
    let path = scratch.config();
    for bytes in [
        b"[1,2]".to_vec(),
        b"broken".to_vec(),
        vec![b' '; LIMIT as usize + 1],
    ] {
        fs::write(&path, &bytes).unwrap();
        let mut owner = Owner::load(Some(path.clone())).unwrap();
        owner.select("nord");
        assert_eq!(owner.state.selected, "system");
        assert!(owner.state.error.is_some());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}
#[test]
fn the_default_system_theme_is_linen_in_light_and_linen_dark_in_dark() {
    let mut owner = Owner::load(None).unwrap();
    assert_eq!(owner.publication().selected, "system");
    let presets: Vec<(String, Colors, Colors)> = owner
        .presets
        .iter()
        .map(|p| (p.id.clone(), p.light.clone(), p.dark.clone()))
        .collect();
    let preset = |id: &str| {
        let (_, light, dark) = presets.iter().find(|p| p.0 == id).unwrap();
        (light.clone(), dark.clone())
    };
    let (linen, linen_dark) = (preset("linen").0, preset("linen-dark").1);
    let accent = linen.accent;
    assert_eq!(owner.publication().theme.background, linen_dark.background);
    owner.system(System::Light);
    let light = owner.publication().theme;
    assert_eq!(light.background, linen.background);
    assert_eq!(light.surface, linen.surface);
    // One accent: needs input (ANSI yellow) wears it.
    assert_eq!(light.palette[3], accent);
    owner.system(System::Dark);
    assert_eq!(owner.publication().theme.surface, linen_dark.surface);
    // Light and Dark stay the neutral built-ins.
    assert_ne!(preset("light").0.background, linen.background);
    assert_ne!(preset("dark").1.background, linen_dark.background);
}
#[test]
fn only_linen_names_its_own_card_border() {
    let mut owner = Owner::load(None).unwrap();
    let border = |owner: &Owner| {
        let theme = owner.publication().native();
        let palette = crate::tmux_snapshot::design::palette(&theme);
        crate::tmux_snapshot::pane_cards::render::card_border(&theme, &palette)
    };
    // System is Linen Dark in dark mode and Linen in light mode.
    assert_eq!(border(&owner), gpui::rgb(0x3a362f).into());
    owner.system(System::Light);
    assert_eq!(border(&owner), gpui::rgb(0xe1dbcf).into());
    for preset in &owner.presets {
        let linen = preset.id.starts_with("linen") || preset.id == "system";
        for colors in [&preset.dark, &preset.light] {
            assert_eq!(colors.card_border.is_some(), linen, "{}", preset.id);
            if !linen {
                let mut theme = owner.publication().native();
                theme.card_border = colors.card_border;
                let palette = crate::tmux_snapshot::design::palette(&theme);
                assert_eq!(
                    crate::tmux_snapshot::pane_cards::render::card_border(&theme, &palette),
                    palette.border,
                    "{} keeps Bezel's border",
                    preset.id
                );
            }
        }
    }
}
#[test]
fn linen_paints_its_own_chrome_inks_and_others_keep_bezels() {
    let mut owner = Owner::load(None).unwrap();
    let hsla = |value: u32| -> gpui::Hsla { gpui::rgb(value).into() };
    // System is Linen Dark in dark mode and Linen in light mode (#746 mockup
    // values: hairline, outline, faint, opaque text).
    for (system, hairline, outline, faint, text) in [
        (System::Dark, 0x36322c, 0x423d36, 0x7d7569, 0xe9e3d8),
        (System::Light, 0xe3ddd2, 0xd6cfc2, 0x8f8679, 0x2b2722),
    ] {
        owner.system(system);
        let palette = crate::tmux_snapshot::design::palette(&owner.publication().native());
        assert_eq!(palette.border_faint, hsla(hairline));
        assert_eq!(palette.border, hsla(outline));
        assert_eq!(palette.text_faint, hsla(faint));
        assert_eq!(palette.text, hsla(text));
    }
    for preset in &owner.presets {
        let linen = preset.id.starts_with("linen") || preset.id == "system";
        for colors in [&preset.dark, &preset.light] {
            assert_eq!(colors.chrome.is_some(), linen, "{}", preset.id);
        }
    }
    // Without chrome inks a theme keeps Bezel's translucent ones.
    let mut theme = owner.publication().native();
    theme.chrome = None;
    let palette = crate::tmux_snapshot::design::palette(&theme);
    assert!(palette.border.a < 1.);
    assert!(palette.text_faint.a < 1.);
}
