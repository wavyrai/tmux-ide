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
