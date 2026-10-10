#![allow(clippy::unwrap_used)]
use super::{Error, decode};
use herdr_client::protocol::FrameData;
use serde_json::{Value, json};
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/snapshot.json")).unwrap()
}
fn convert(value: &Value) -> Result<FrameData, Error> {
    decode::frame(&serde_json::to_vec(value).unwrap())
}
#[test]
fn converts_contract_shape_and_color_encodings() {
    let f = convert(&fixture()).unwrap();
    assert_eq!((f.width, f.height), (60, 20));
    assert_eq!(f.cells.len(), 1200);
    assert_eq!(f.cells[180].fg, 0x02ff8844);
    assert_eq!(f.cells[240].fg, 0x01000000);
    assert_eq!(f.cells[181].modifier, 8);
    assert_eq!(f.cells[182].modifier, 64);
    assert_eq!(f.cursor.as_ref().unwrap().shape, 6);
    assert!(f.cells.iter().any(|c| c.symbol == "é"));
    let wide = f.cells.iter().position(|c| c.symbol == "界").unwrap();
    assert!(f.cells[wide + 1].skip);
}
#[test]
fn translates_style_bits_without_confusing_blink_and_inverse() {
    let mut v = fixture();
    v["grid"][0]["cells"][0]["attributes"] = json!(255);
    assert_eq!(convert(&v).unwrap().cells[0].modifier, 15 | 64 | 128 | 256);
}
#[test]
fn rejects_bad_geometry_before_painting() {
    for (field, value) in [("cols", json!(0)), ("cols", json!(61)), ("rows", json!(21))] {
        let mut v = fixture();
        v[field] = value;
        assert!(matches!(convert(&v), Err(Error::Invalid(_))));
    }
}
#[test]
fn rejects_orphan_continuation_and_truncated_wide_cell() {
    for width in [0, 2, 3] {
        let mut v = fixture();
        v["grid"][0]["cells"][0]["width"] = json!(width);
        assert!(matches!(convert(&v), Err(Error::Invalid(_))));
    }
}
#[test]
fn rejects_out_of_bounds_cursor_and_unsupported_graphics() {
    let mut v = fixture();
    v["cursor"]["x"] = json!(60);
    assert!(matches!(convert(&v), Err(Error::Invalid(_))));
    let mut v = fixture();
    v["placements"] = json!([{"id":"image"}]);
    assert!(matches!(convert(&v), Err(Error::Invalid(_))));
}
#[test]
fn rejects_invalid_color_controls_and_unknown_fields() {
    let mut v = fixture();
    v["grid"][0]["cells"][0]["foreground"] = json!({"kind":"rgb","value":16777216});
    assert!(matches!(convert(&v), Err(Error::Invalid(_))));
    let mut v = fixture();
    v["grid"][0]["cells"][0]["grapheme"] = json!("\u{1b}[31m");
    assert!(matches!(convert(&v), Err(Error::Invalid(_))));
    let mut v = fixture();
    v["unexpected"] = json!(true);
    assert!(matches!(convert(&v), Err(Error::Json(_))));
}

#[test]
fn bounds_per_cell_shaping_work() {
    let mut v = fixture();
    v["grid"][0]["cells"][0]["grapheme"] = json!("x".repeat(257));
    assert!(matches!(convert(&v), Err(Error::Invalid(_))));
}
