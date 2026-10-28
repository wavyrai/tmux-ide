#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{browser, copy, hit_regions, selection};
use herdr_client::protocol::CellData;
fn native(text: &str) -> Arc<NativeFrame> {
    Arc::new(NativeFrame {
        width: 2,
        height: 1,
        cursor: None,
        rows: vec![Arc::from(
            text.chars()
                .map(|c| CellData {
                    symbol: c.to_string(),
                    fg: 0,
                    bg: 0,
                    modifier: 0,
                    skip: false,
                    hyperlink: None,
                })
                .collect::<Vec<_>>(),
        )],
    })
}
#[test]
fn native_paint_identity_requires_exact_presentation_arc() {
    let a = native("AB");
    let same: DisplayFrame = Arc::clone(&a).into();
    let first: DisplayFrame = Arc::clone(&a).into();
    let next: DisplayFrame = native("AB").into();
    assert!(first.same(&same));
    assert!(!first.same(&next));
    assert!(hit_regions::is_painted(Some(&first), Some(&same)));
    assert!(!hit_regions::is_painted(Some(&first), Some(&next)));
    let legacy: DisplayFrame = Arc::new(FrameData {
        cells: a.rows[0].to_vec(),
        width: 2,
        height: 1,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    })
    .into();
    assert!(!first.same(&legacy));
}
#[test]
fn native_selection_retains_its_rows_when_live_output_changes() {
    let original = native("AB");
    let mut state = browser::State {
        frame: Some(Arc::clone(&original).into()),
        selected_pane: Some("pane".into()),
        copy_region: Some(copy::Region {
            id: "pane".into(),
            left: 0,
            top: 0,
            width: 2,
            height: 1,
            wrapped: vec![false],
        }),
        ..Default::default()
    };
    let mut capture = selection::Capture::begin(&state, 0., 0.).unwrap();
    capture.update(2., 0.).unwrap();
    assert_eq!(capture.text().unwrap(), "AB");
    assert!(std::ptr::eq(
        capture.frame.view().row(0).unwrap().as_ptr(),
        original.rows[0].as_ptr()
    ));
    state.frame = Some(native("CD").into());
    assert!(capture.compatible(&state));
    assert_eq!(capture.text().unwrap(), "AB");
    assert!(!capture.frame.same(state.frame.as_ref().unwrap()));
}
