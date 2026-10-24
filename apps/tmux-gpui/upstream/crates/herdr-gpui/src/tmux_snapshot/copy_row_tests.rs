use super::*;
use crate::terminal_painter::NativeFrame;
use herdr_client::protocol::CellData;
use std::sync::Arc;

fn cell(symbol: &str, skip: bool) -> CellData {
    CellData {
        symbol: symbol.into(),
        skip,
        fg: 0,
        bg: 0,
        modifier: 0,
        hyperlink: None,
    }
}
#[test]
fn row_backed_selection_preserves_graphemes_wraps_and_pane_boundaries() -> anyhow::Result<()> {
    let first: Arc<[CellData]> = vec![
        cell("X", false),
        cell("界", false),
        cell("", true),
        cell("e\u{301}", false),
        cell("Y", false),
    ]
    .into();
    let second: Arc<[CellData]> = vec![
        cell("X", false),
        cell("a", false),
        cell("b", false),
        cell(" ", false),
        cell("Y", false),
    ]
    .into();
    let frame = NativeFrame {
        width: 5,
        height: 2,
        cursor: None,
        rows: vec![first.clone(), second.clone()],
    };
    let region = Region {
        id: "pane".into(),
        left: 1,
        top: 0,
        width: 3,
        height: 2,
        wrapped: vec![false, true],
    };
    assert_eq!(region.text_view((&frame).into())?, "界e\u{301}ab");
    assert_eq!(
        region.text_between_view((&frame).into(), (0, 1), (1, 1))?,
        "界e\u{301}a"
    );
    assert!(Arc::ptr_eq(&first, &frame.rows[0]));
    assert!(Arc::ptr_eq(&second, &frame.rows[1]));
    let truncated = NativeFrame {
        width: 5,
        height: 2,
        cursor: None,
        rows: vec![first],
    };
    assert!(region.text_view((&truncated).into()).is_err());
    Ok(())
}
