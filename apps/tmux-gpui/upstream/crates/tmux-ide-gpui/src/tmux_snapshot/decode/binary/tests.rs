#![allow(clippy::unwrap_used)]
use super::super::compact::WireRow;
use super::*;
use serde_json::{Value, json};
fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../../../bridge/binary-vectors.json"
    ))
    .unwrap()
}
fn hex(s: &str) -> Vec<u8> {
    s.as_bytes()
        .chunks_exact(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect()
}
fn row(row: WireRow) -> Value {
    match row {
        WireRow::Compact((wrapped, runs)) => json!([
            wrapped,
            runs.into_iter()
                .map(|r| json!([r.0, r.1, r.2, r.3, r.4, r.5]))
                .collect::<Vec<_>>()
        ]),
        _ => panic!("unexpected legacy row"),
    }
}
#[test]
fn shared_cell_vectors_preserve_exact_rows_and_metadata() {
    for v in vectors()["cells"].as_array().unwrap() {
        let decoded = cells::decode(&hex(v["hex"].as_str().unwrap())).unwrap();
        let mut metadata = decoded.metadata;
        if decoded.full {
            metadata["grid"] = json!(
                decoded
                    .changed_rows
                    .into_iter()
                    .map(|(_, r)| row(r))
                    .collect::<Vec<_>>()
            );
        } else {
            metadata["changedRows"] = json!(
                decoded
                    .changed_rows
                    .into_iter()
                    .map(|(i, r)| json!([i, row(r)]))
                    .collect::<Vec<_>>()
            );
        }
        metadata["history"] = json!(decoded.history.into_iter().map(row).collect::<Vec<_>>());
        assert_eq!(metadata, v["frame"]);
    }
}
#[test]
fn frames_survive_every_fragment_and_backpressure_stops_before_next_header() {
    let vectors = vectors();
    let mut all = Vec::new();
    let mut expected = Vec::new();
    for section in ["publications", "images", "json"] {
        for v in vectors[section].as_array().unwrap() {
            let bytes = hex(v["hex"].as_str().unwrap());
            expected.push(bytes[12..].to_vec());
            all.extend(bytes);
        }
    }
    for size in [1, 2, 3, 7, 12, 31, 1024] {
        let mut parser = Parser::default();
        let mut actual = Vec::new();
        for part in all.chunks(size) {
            let p = parser
                .push(part, |_, payload| {
                    actual.push(payload.to_vec());
                    Ok(true)
                })
                .unwrap();
            assert_eq!(p.consumed, part.len());
        }
        parser.finish().unwrap();
        assert_eq!(actual, expected);
    }
    let mut parser = Parser::default();
    let progress = parser.push(&all, |_, _| Ok(false)).unwrap();
    assert!(progress.blocked);
    assert_eq!(progress.consumed, 12 + expected[0].len());
    let mut remaining = 0;
    parser
        .push(&all[progress.consumed..], |_, _| {
            remaining += 1;
            Ok(true)
        })
        .unwrap();
    assert_eq!(remaining, expected.len() - 1);
    parser.finish().unwrap();
}
#[test]
fn malformed_headers_and_truncated_cells_are_bounded_errors() {
    let v = vectors();
    let bytes = hex(v["cells"][0]["hex"].as_str().unwrap());
    for end in 0..bytes.len() {
        assert!(cells::decode(&bytes[..end]).is_err());
    }
    let mut trailing = bytes;
    trailing.push(0);
    assert!(cells::decode(&trailing).is_err());
    for field in [0, 4, 5, 6, 7, 8] {
        let mut header = *b"TIGF\x01\x01\x00\x00\x00\x00\x00\x01";
        header[field] = 255;
        let mut parser = Parser::default();
        assert!(parser.push(&header, |_, _| Ok(true)).is_err());
        assert!(parser.push(b"", |_, _| Ok(true)).is_err());
    }
    let mut parser = Parser::default();
    parser.push(b"TIGF", |_, _| Ok(true)).unwrap();
    assert!(parser.finish().is_err());
}

#[test]
fn zero_length_frames_retire_every_type_before_delivery() {
    for kind in 1..=3 {
        let mut header = *b"TIGF\x01\x01\x00\x00\x00\x00\x00\x00";
        header[5] = kind;
        let mut parser = Parser::default();
        assert!(
            parser
                .push(&header, |_, _| panic!("empty frame delivered"))
                .is_err()
        );
        assert!(parser.push(&[], |_, _| Ok(true)).is_err());
    }
}
