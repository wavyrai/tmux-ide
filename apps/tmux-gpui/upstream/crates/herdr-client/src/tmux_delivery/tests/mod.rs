#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use serde_json::{Value, json};
use std::sync::Arc;
fn vectors() -> Vec<Value> {
    serde_json::from_str(include_str!("vectors.json")).unwrap()
}
fn seed() -> (Store, Vec<Value>) {
    let v = vectors();
    let mut s = Store::default();
    s.apply(
        decode_compact(v[0]["wire"].as_str().unwrap().as_bytes()).unwrap(),
        v[0]["canonicalHash"].as_str().unwrap(),
    )
    .unwrap();
    (s, v)
}
#[test]
fn production_ts_vectors_match_and_retain_unchanged_rows() {
    let v = vectors();
    let mut s = Store::default();
    let mut old = None;
    for (i, v) in v.iter().enumerate() {
        let bytes = v["wire"].as_str().unwrap().as_bytes();
        assert_eq!(
            hash_representation(bytes),
            v["representationHash"].as_str().unwrap()
        );
        let result = s
            .apply(
                decode_compact(bytes).unwrap(),
                v["canonicalHash"].as_str().unwrap(),
            )
            .unwrap();
        assert_eq!(result.revision, (i + 1) as u64);
        if i == 0 {
            old = s.snapshot().cloned();
            assert_eq!(result.changed_rows, vec![0, 1]);
        }
        if i == 1 {
            let old = old.take().unwrap();
            let now = s.snapshot().unwrap();
            assert!(Arc::ptr_eq(&old.grid[0], &now.grid[0]));
            assert!(!Arc::ptr_eq(&old.grid[1], &now.grid[1]));
            assert_eq!(result.changed_rows, vec![1]);
            old_snapshot_assert(&old);
        }
        if i == 2 {
            assert!(result.changed_rows.is_empty());
        }
        if i == 4 {
            assert!(result.tombstone);
            assert!(s.snapshot().is_none());
        }
    }
}
fn old_snapshot_assert(s: &Snapshot) {
    assert_eq!(&*s.grid[1].cells()[0].grapheme, " ");
}
#[test]
fn hash_and_sequence_rejection_are_atomic() {
    let (mut s, v) = seed();
    let before = s.snapshot().cloned().unwrap();
    let bytes = v[1]["wire"].as_str().unwrap().as_bytes();
    assert!(matches!(
        s.apply(decode_compact(bytes).unwrap(), "bad"),
        Err(Error::Hash)
    ));
    assert!(Arc::ptr_eq(&before, s.snapshot().unwrap()));
    assert_eq!(s.revision(), Some(1));
    let mut bad: Value = serde_json::from_slice(bytes).unwrap();
    bad["b"] = json!(0);
    assert!(matches!(
        s.apply(
            decode_compact(&serde_json::to_vec(&bad).unwrap()).unwrap(),
            "bad"
        ),
        Err(Error::Revision)
    ));
    assert!(Arc::ptr_eq(&before, s.snapshot().unwrap()));
}
#[test]
fn malformed_schema_and_bounds_rejected() {
    let v = vectors();
    let original: Value = serde_json::from_str(v[0]["wire"].as_str().unwrap()).unwrap();
    let mut cases = Vec::new();
    let mut x = original.clone();
    x["extra"] = json!(1);
    cases.push(x);
    let mut x = original.clone();
    x["s"][0] = json!(4097);
    cases.push(x);
    let mut x = original.clone();
    x["s"][2][0][1][0][2] = json!(0);
    cases.push(x);
    let mut x = original.clone();
    x["s"][2][0][1][0][3] = json!([1, 256]);
    cases.push(x);
    let mut x = original.clone();
    x["s"][4][0] = json!(4);
    cases.push(x);
    let mut x = original.clone();
    x["s"][5][0] = json!(true);
    cases.push(x);
    let mut x = original.clone();
    x["s"][6][0][4] = json!(5);
    cases.push(x);
    let mut x = original.clone();
    x["s"][2][0][1][0][1] = json!("a".repeat(4097));
    cases.push(x);
    let mut x = original.clone();
    x["r"] = json!(9_007_199_254_740_992u64);
    cases.push(x);
    let mut x = original;
    x["s"][2] = json!([]);
    cases.push(x);
    for x in cases {
        assert!(
            decode_compact(&serde_json::to_vec(&x).unwrap()).is_err(),
            "{x}"
        );
    }
    assert!(decode_compact(&[255]).is_err());
    assert!(decode_compact(&vec![b' '; 16 * 1024 * 1024 + 1]).is_err());
}
#[test]
fn invalid_patch_is_atomic() {
    let (mut s, v) = seed();
    let before = s.snapshot().cloned().unwrap();
    let original: Value = serde_json::from_str(v[1]["wire"].as_str().unwrap()).unwrap();
    for mutation in 0..4 {
        let mut x = original.clone();
        match mutation {
            0 => {
                let row = x["p"][1][0].clone();
                x["p"][1].as_array_mut().unwrap().push(row);
            }
            1 => x["p"][3][0] = json!(2),
            2 => x["p"][4][0] = json!(4),
            _ => x["p"][1][0][0] = json!(2),
        }
        let update = decode_compact(&serde_json::to_vec(&x).unwrap()).unwrap();
        assert!(matches!(s.apply(update, "bad"), Err(Error::Invalid(_))));
        assert!(Arc::ptr_eq(&before, s.snapshot().unwrap()));
    }
}
#[test]
fn stale_seed_and_post_tombstone_patch_rejected() {
    let (mut s, v) = seed();
    assert!(matches!(
        s.apply(
            decode_compact(v[0]["wire"].as_str().unwrap().as_bytes()).unwrap(),
            v[0]["canonicalHash"].as_str().unwrap()
        ),
        Err(Error::Revision)
    ));
    let tomb = Update::Tombstone {
        base_revision: 1,
        revision: 2,
        reason: "pane-closed".into(),
    };
    s.apply(tomb, &hash_tombstone("pane-closed")).unwrap();
    let mut x: Value = serde_json::from_str(v[1]["wire"].as_str().unwrap()).unwrap();
    x["b"] = json!(2);
    x["r"] = json!(3);
    assert!(matches!(
        s.apply(
            decode_compact(&serde_json::to_vec(&x).unwrap()).unwrap(),
            "bad"
        ),
        Err(Error::Revision)
    ));
}
#[test]
fn expansion_ratio_bound_is_enforced() {
    let v = vectors();
    let mut wire: Value = serde_json::from_str(v[0]["wire"].as_str().unwrap()).unwrap();
    wire["s"][0] = json!(4096);
    wire["s"][1] = json!(300);
    wire["s"][2] = json!(vec![json!([0, [[4096, " ", 1, 0, 0, 0]]]); 300]);
    wire["s"][3] = json!([]);
    wire["s"][6] = json!([]);
    assert!(matches!(
        decode_compact(&serde_json::to_vec(&wire).unwrap()),
        Err(Error::Invalid("cell budget"))
    ));
}
#[test]
fn equivalent_json_integer_spelling_keeps_canonical_identity() {
    let v = vectors();
    let wire = v[0]["wire"]
        .as_str()
        .unwrap()
        .replace("\"v\":1", "\"v\":1.0")
        .replace("\"r\":1", "\"r\":1e0");
    let mut s = Store::default();
    s.apply(
        decode_compact(wire.as_bytes()).unwrap(),
        v[0]["canonicalHash"].as_str().unwrap(),
    )
    .unwrap();
}

mod binary;

mod projection;
