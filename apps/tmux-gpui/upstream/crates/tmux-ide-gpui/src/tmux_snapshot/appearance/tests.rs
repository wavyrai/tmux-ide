#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
pub(crate) fn fixture() -> Appearance {
    serde_json::from_value(serde_json::json!({
        "selected":"dark", "system":"dark", "error":null,
        "options":[{"id":"dark","name":"Dark"},{"id":"light","name":"Light"}],
        "theme":{"canvas":1,"background":2,"foreground":3,"cursor":4,"surface":5,"active":6,"muted":7,"accent":8,"palette":vec![9u32;256]}
    })).unwrap()
}
#[test]
fn validates_full_palette_and_choice() {
    let a = fixture();
    assert!(a.valid());
    let mut bad = a.clone();
    bad.theme.palette.pop();
    assert!(!bad.valid());
    let mut bad = a.clone();
    bad.theme.palette[0] = 0x1000000;
    assert!(!bad.valid());
    let mut bad = a.clone();
    bad.selected = "missing".into();
    assert!(!bad.valid());
    let mut bad = a.clone();
    bad.options.push(bad.options[0].clone());
    assert!(!bad.valid());
    let mut bad = a.clone();
    bad.error = Some("bad\x1b[0m".into());
    assert!(!bad.valid());
    let mut bad = a;
    bad.options[0].name = "x".repeat(129);
    assert!(!bad.valid());
}
#[test]
fn default_indexed_and_rgb_keep_distinct_semantics() {
    let a = fixture();
    let theme = a.native();
    assert_eq!(theme.background, 2);
    assert_eq!(crate::terminal::color(0, theme.background, &theme), 2);
    assert_eq!(
        crate::terminal::color(0x01000008, theme.foreground, &theme),
        9
    );
    assert_eq!(
        crate::terminal::color(0x02123456, theme.foreground, &theme),
        0x123456
    );
}
