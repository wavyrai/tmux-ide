#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../../../fixtures/snapshot.json")).unwrap()
}
fn compact(mut value: Value) -> Value {
    fn packed(v: &Value) -> u32 {
        match v["kind"].as_str().unwrap() {
            "default" => 0,
            "indexed" => 0x01000000 | v["index"].as_u64().unwrap() as u32,
            _ => 0x02000000 | v["value"].as_u64().unwrap() as u32,
        }
    }
    for field in ["grid", "history"] {
        for row in value[field].as_array_mut().unwrap() {
            let runs: Vec<Value> = row["cells"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    json!([
                        1,
                        c["grapheme"],
                        c["width"],
                        packed(&c["foreground"]),
                        packed(&c["background"]),
                        c["attributes"]
                    ])
                })
                .collect();
            *row = json!([row["wrapped"], runs]);
        }
    }
    value["encoding"] = json!("rle-v1");
    value
}
fn decode(value: &Value) -> Result<(FrameData, Option<PointerModes>), Error> {
    frame(&serde_json::to_vec(value).unwrap())
}
#[test]
fn compact_matches_legacy_painter_and_pointer_modes() {
    let mut original = fixture();
    original["modes"]["alternateScreen"] = json!(true);
    original["modes"]["mouseProtocol"] = json!("any");
    original["modes"]["mouseEncoding"] = json!("sgr");
    original["grid"][0]["cells"][0]["attributes"] = json!(255);
    original["grid"][0]["cells"][1]["grapheme"] = json!("\u{10eeee}");
    let (expected, modes) =
        frame_with_pointer_modes(&serde_json::to_vec(&original).unwrap()).unwrap();
    let (actual, actual_modes) = decode(&compact(original.clone())).unwrap();
    assert_eq!(format!("{expected:?}"), format!("{actual:?}"));
    assert_eq!(modes, actual_modes);
    assert!(decode(&original).is_ok());
    assert!(super::super::frame(&serde_json::to_vec(&compact(original)).unwrap()).is_err());
}
#[test]
fn rejects_malformed_runs_and_metadata() {
    for (index, invalid) in [
        (0, json!(0)),
        (0, json!(61)),
        (0, json!(4294967295u64)),
        (1, json!("\n")),
        (1, json!("a".repeat(257))),
        (2, json!(0)),
        (2, json!(2)),
        (3, json!(0x01000100)),
        (4, json!(0x03000000)),
        (5, json!(256)),
    ] {
        let mut v = compact(fixture());
        v["grid"][0][1][0][index] = invalid;
        assert!(decode(&v).is_err(), "index {index}");
    }
    let mut v = compact(fixture());
    v["unexpected"] = json!(1);
    assert!(decode(&v).is_err());
    let mut v = compact(fixture());
    v["modes"]["unexpected"] = json!(1);
    assert!(decode(&v).is_err());
    let mut v = compact(fixture());
    v["grid"][0] = fixture()["grid"][0].clone();
    assert!(decode(&v).is_err());
    let mut v = compact(fixture());
    v.as_object_mut().unwrap().remove("encoding");
    assert!(decode(&v).is_err());
}
#[test]
fn rejects_expansion_bombs_before_expansion() {
    let mut v = compact(fixture());
    v["history"] = json!(vec![v["grid"][0].clone(); 5000]);
    assert!(decode(&v).is_err());
    let mut v = compact(fixture());
    let row = json!([false, [[60, "a".repeat(256), 1, 0, 0, 0]]]);
    v["grid"] = json!(vec![row.clone(); 20]);
    v["history"] = json!(vec![row; 550]);
    assert!(decode(&v).is_err());
}

#[test]
fn repeated_runs_and_history_preserve_valid_wide_pairs() {
    let mut v = compact(fixture());
    let row = json!([
        true,
        [
            [58, "x", 1, 0x010000ff, 0x02ffffff, 255],
            [1, "界", 2, 0, 0, 0],
            [1, "", 0, 0, 0, 0]
        ]
    ]);
    v["grid"][0] = row.clone();
    v["history"] = json!([row]);
    let (frame, _) = decode(&v).unwrap();
    assert_eq!(frame.cells[57].symbol, "x");
    assert_eq!(frame.cells[57].fg, 0x010000ff);
    assert_eq!(frame.cells[57].bg, 0x02ffffff);
    assert_eq!(frame.cells[57].modifier, 463);
    assert_eq!(frame.cells[58].symbol, "界");
    assert!(frame.cells[59].skip);
    v["history"][0][1][2][1] = json!("orphan");
    assert!(decode(&v).is_err());
}

#[test]
fn rejects_wrong_tuple_shapes_encoding_and_visible_cursor() {
    for encoding in [json!(null), json!("legacy"), json!("rle-v2")] {
        let mut v = compact(fixture());
        v["encoding"] = encoding;
        assert!(decode(&v).is_err());
    }
    let mut v = compact(fixture());
    v["grid"][0][1][0].as_array_mut().unwrap().push(json!(1));
    assert!(decode(&v).is_err());
    let mut v = compact(fixture());
    v["grid"][0][0] = json!(0);
    assert!(decode(&v).is_err());
    let mut v = compact(fixture());
    v["cursor"]["hidden"] = json!(false);
    v["cursor"]["x"] = json!(60);
    assert!(decode(&v).is_err());
}
