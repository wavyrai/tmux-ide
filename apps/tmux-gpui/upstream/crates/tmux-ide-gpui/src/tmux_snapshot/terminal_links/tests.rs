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
        assert_eq!(resolve(&frame, &region, 5, 0).as_deref(), expected);
    }
}
#[test]
fn canonical_wraps_join_only_within_complete_pane_line() {
    let (frame, mut region) = fixture(&["https://exam", "ple.com/   "], vec![false, true]);
    assert_eq!(
        resolve(&frame, &region, 3, 1).as_deref(),
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
        resolve(&native, &region, 3, 1).as_deref(),
        Some("https://example.com/")
    );
    assert!(Arc::ptr_eq(&before, &native.rows[0]));
    region.wrapped[0] = true;
    assert!(resolve(&native, &region, 3, 1).is_none());
}
