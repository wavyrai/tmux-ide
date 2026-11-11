#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::protocol::{CellData, FrameData};
fn fixture(lines: &[&str], wrapped: Vec<bool>) -> (FrameData, copy::Region) {
    let width = lines.iter().map(|line| line.chars().count()).max().unwrap() as u16;
    let cells = lines
        .iter()
        .flat_map(|line| {
            line.chars()
                .chain(std::iter::repeat(' '))
                .take(usize::from(width))
        })
        .map(|c| CellData {
            symbol: c.to_string(),
            fg: 0,
            bg: 0,
            modifier: 0,
            skip: false,
            hyperlink: None,
        })
        .collect();
    (
        FrameData {
            width,
            height: lines.len() as u16,
            cells,
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        copy::Region {
            id: "pane".into(),
            left: 0,
            top: 0,
            width,
            height: lines.len() as u16,
            wrapped,
        },
    )
}
#[test]
fn web_links_reuse_validation_and_punctuation() {
    for (text, expected) in [
        (
            "https://example.com/a(b). done",
            Some("https://example.com/a(b)"),
        ),
        (
            "http://localhost:3000/ done",
            Some("http://localhost:3000/"),
        ),
        ("file:///tmp/a done", None),
        ("javascript:alert(1) done", None),
        ("mailto:a@b.test done", None),
    ] {
        let (frame, region) = fixture(&[text], vec![false]);
        assert_eq!(
            resolve(&frame, &region, 5, 0)
                .map(|link| link.url)
                .as_deref(),
            expected
        );
    }
}
#[test]
fn canonical_wraps_join_only_within_complete_pane_line() {
    let (frame, mut region) = fixture(&["https://exam", "ple.com/   "], vec![false, true]);
    assert_eq!(
        resolve(&frame, &region, 3, 1)
            .map(|link| link.url)
            .as_deref(),
        Some("https://example.com/")
    );
    region.wrapped[1] = false;
    assert!(resolve(&frame, &region, 3, 1).is_none());
    region.wrapped[0] = true;
    assert!(resolve(&frame, &region, 3, 0).is_none());
    let (frame, region) = fixture(&["https://example.com"], vec![false]);
    assert!(
        resolve(&frame, &region, 3, 0).is_none(),
        "clipped right edge is ambiguous"
    );
}
#[test]
fn opening_requires_deliberate_unmixed_primary_modifier() {
    let mut event = MouseDownEvent::default();
    assert!(!gesture(&event));
    event.modifiers.platform = true;
    assert!(gesture(&event));
    event.modifiers.shift = true;
    assert!(!gesture(&event));
    event.modifiers.shift = false;
    event.modifiers.alt = true;
    assert!(!gesture(&event));
}

#[test]
fn native_wrapped_links_borrow_rows_and_preserve_fail_closed_edges() {
    use crate::terminal_painter::NativeFrame;
    use std::sync::Arc;
    let (flat, mut region) = fixture(&["https://exam", "ple.com/   "], vec![false, true]);
    let native = NativeFrame {
        width: flat.width,
        height: flat.height,
        cursor: None,
        rows: flat
            .cells
            .chunks(usize::from(flat.width))
            .map(|row| Arc::from(row.to_vec()))
            .collect(),
    };
    let before = Arc::clone(&native.rows[0]);
    assert_eq!(
        resolve(&native, &region, 3, 1)
            .map(|link| link.url)
            .as_deref(),
        Some("https://example.com/")
    );
    assert!(Arc::ptr_eq(&before, &native.rows[0]));
    region.wrapped[0] = true;
    assert!(resolve(&native, &region, 3, 1).is_none());
}

/// Card 1: Shift-click (nothing else held) is the second way to open; Cmd or
/// Ctrl alone is the first and shows the cue.
#[test]
fn shift_click_and_the_cue_modifier_are_unmixed() {
    let mut event = MouseDownEvent::default();
    assert!(!shift_gesture(&event));
    event.modifiers.shift = true;
    assert!(shift_gesture(&event));
    event.modifiers.platform = true;
    assert!(!shift_gesture(&event));
    event.modifiers = Modifiers::default();
    event.modifiers.shift = true;
    event.modifiers.alt = true;
    assert!(!shift_gesture(&event));
    event.modifiers = Modifiers::default();
    event.button = MouseButton::Right;
    event.modifiers.shift = true;
    assert!(!shift_gesture(&event));
    for (platform, control, shift, alt, want) in [
        (true, false, false, false, true),
        (false, true, false, false, true),
        (true, false, true, false, false),
        (true, false, false, true, false),
        (false, false, false, false, false),
    ] {
        let modifiers = Modifiers {
            platform,
            control,
            shift,
            alt,
            function: false,
        };
        assert_eq!(modifier(modifiers), want, "{modifiers:?}");
    }
}

/// Card 3: what counts as a computer's own loopback address.
#[test]
fn loopback_addresses_are_recognised_and_nothing_else() {
    for url in [
        "http://localhost:3000/",
        "http://LOCALHOST/",
        "http://localhost./",
        "http://app.localhost:5173/x",
        "http://127.0.0.1:8080/",
        "http://127.1.2.3/",
        "http://[::1]:5173/",
        "http://0.0.0.0:8000/",
        "http://[::]/",
        "http://[::ffff:127.0.0.1]/",
    ] {
        assert!(loopback(url), "{url}");
    }
    for url in [
        "https://example.com/",
        "http://10.0.0.5:3000/",
        "http://192.168.1.2/",
        "http://localhost.example.com/",
        "http://mylocalhost/",
        "http://[2001:db8::1]/",
        "not a url",
    ] {
        assert!(!loopback(url), "{url}");
    }
    let machine = browser::RemoteMachine {
        label: "spark".into(),
        ssh_target: "spark".into(),
    };
    assert!(refusal("https://example.com/", &machine).is_none());
    let note = refusal("https://localhost/", &machine).unwrap();
    assert!(note.contains("ssh -L 443:localhost:443 spark"), "{note}");
}

/// Card 2: the underline reads against the terminal background at the
/// theme's mark contrast, in every catalog theme, light and dark, at both
/// contrast settings.
#[test]
fn the_link_underline_reads_in_every_catalog_theme() {
    use crate::contrast::{Contrast, ratio};
    let presets: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../appearance/catalog.json")).unwrap();
    let mut checked = 0;
    for preset in &presets {
        for system in ["dark", "light"] {
            let appearance: crate::tmux_snapshot::appearance::Appearance =
                serde_json::from_value(serde_json::json!({
                    "selected": preset["id"], "system": system, "error": null,
                    "options": [{"id": preset["id"], "name": "x"}],
                    "theme": preset[system]
                }))
                .unwrap();
            for contrast in [Contrast::Standard, Contrast::High] {
                let mut theme = appearance.native();
                theme.contrast = contrast;
                let ink = gpui::Rgba::from(hover::link_ink(&theme));
                let packed = u32::from(ink) >> 8;
                let got = ratio(packed, theme.background);
                assert!(
                    got >= contrast.mark_ratio() - 0.01,
                    "{} {system} {contrast:?}: {got:.2}",
                    preset["id"]
                );
                checked += 1;
            }
        }
    }
    assert!(checked >= 8);
}
