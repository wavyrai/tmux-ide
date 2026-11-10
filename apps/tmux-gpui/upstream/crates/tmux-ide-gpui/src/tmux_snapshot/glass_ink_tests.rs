use super::*;
use core::prelude::v1::test;

/// G6: on Glass::Regular, over a white and over a black desktop, a menu's or
/// tooltip's text and muted read at 4.5:1 in every catalog theme that frosts.
#[test]
fn menu_text_and_muted_read_on_regular_glass_over_any_desktop() {
    let mut failures = Vec::new();
    for (name, theme) in crate::tmux_snapshot::ink::tests::catalog_themes() {
        let bezel = crate::tmux_snapshot::design::palette(&theme);
        if !bezel.glass {
            continue;
        }
        let inked = on_regular_glass(&bezel);
        for (desktop, plate) in ["white", "black"].iter().zip(regular_glass_plates(&bezel)) {
            for (role, ink) in [("text", inked.text), ("muted", inked.text_muted)] {
                let r = crate::contrast::ratio(pack(ink), plate);
                if r < 4.5 {
                    failures.push(format!("{name}: {role} over {desktop} is {r:.2}:1"));
                }
            }
            let faint = crate::contrast::ratio(pack(inked.text_faint), plate);
            if faint < 3. {
                failures.push(format!("{name}: faint over {desktop} is {faint:.2}:1"));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn an_opaque_window_keeps_its_inks() {
    let mut bezel = crate::tmux_snapshot::design::palette(&crate::config::Theme::default());
    bezel.glass = false;
    let same = on_regular_glass(&bezel);
    assert_eq!(same.text_muted, bezel.text_muted);
}
