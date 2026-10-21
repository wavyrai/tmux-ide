#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
fn full(seq: u64) -> Value {
    let mut v: Value =
        serde_json::from_str(include_str!("../../../../../../../fixtures/snapshot.json")).unwrap();
    v["encoding"] = json!("rle-v1");
    v["epoch"] = json!("epoch-a");
    v["seq"] = json!(seq);
    v["cols"] = json!(4);
    v["rows"] = json!(2);
    v["grid"] = json!([
        [false, [[4, "a", 1, 0, 0, 0]]],
        [true, [[4, "b", 1, 0, 0, 0]]]
    ]);
    v["history"] = json!([]);
    v["cursor"]["x"] = json!(0);
    v["cursor"]["y"] = json!(0);
    v
}
fn patch(seq: u64) -> Value {
    let mut v = full(seq);
    v["encoding"] = json!("rle-delta-v1");
    v["baseSeq"] = json!(seq - 1);
    v.as_object_mut().unwrap().remove("grid");
    v["changedRows"] = json!([[1, [false, [[4, "c", 1, 0, 0, 255]]]]]);
    v
}
fn prepare(store: &Store, v: &Value) -> Result<Outcome, Error> {
    store.prepare(&serde_json::to_vec(v).unwrap())
}
fn ready(store: &Store, v: &Value) -> Prepared {
    match prepare(store, v).unwrap() {
        Outcome::Ready(p) => p,
        _ => panic!("unexpected resync"),
    }
}
#[test]
fn applies_changed_rows_and_complete_metadata_after_commit() {
    let mut store = Store::default();
    store.commit(ready(&store, &full(1)));
    let mut v = patch(2);
    v["cursor"]["x"] = json!(3);
    let next = ready(&store, &v);
    assert_eq!(next.frame.cells[0].symbol, "a");
    assert_eq!(next.frame.cells[4].symbol, "c");
    assert_eq!(next.frame.cells[4].modifier, 463);
    assert_eq!(next.frame.cursor.as_ref().unwrap().x, 3);
    store.commit(next);
    assert!(matches!(
        prepare(&store, &patch(3)).unwrap(),
        Outcome::Ready(_)
    ));
}
#[test]
fn outer_rejection_does_not_commit_prepared_candidate() {
    let mut store = Store::default();
    store.commit(ready(&store, &full(1)));
    let _discarded = ready(&store, &patch(2));
    assert!(matches!(
        prepare(&store, &patch(3)).unwrap(),
        Outcome::Resync { base_seq: 1, .. }
    ));
    store.commit(ready(&store, &patch(2)));
    assert!(matches!(
        prepare(&store, &patch(3)).unwrap(),
        Outcome::Ready(_)
    ));
}
#[test]
fn gap_missing_reset_and_stale_full_request_resync() {
    let mut store = Store::default();
    assert!(matches!(
        prepare(&store, &patch(2)).unwrap(),
        Outcome::Resync { base_seq: 0, .. }
    ));
    store.commit(ready(&store, &full(1)));
    assert!(matches!(
        prepare(&store, &full(1)).unwrap(),
        Outcome::Resync { base_seq: 1, .. }
    ));
    assert!(matches!(
        prepare(&store, &patch(3)).unwrap(),
        Outcome::Resync { base_seq: 1, .. }
    ));
    store.reset();
    assert!(matches!(
        prepare(&store, &patch(2)).unwrap(),
        Outcome::Resync { base_seq: 0, .. }
    ));
    store.commit(ready(&store, &full(9)));
    assert!(matches!(
        prepare(&store, &patch(10)).unwrap(),
        Outcome::Ready(_)
    ));
}
#[test]
fn malformed_patch_never_changes_baseline() {
    let mut store = Store::default();
    store.commit(ready(&store, &full(1)));
    for changes in [
        json!([
            [1, [false, [[4, "c", 1, 0, 0, 0]]]],
            [1, [false, [[4, "d", 1, 0, 0, 0]]]]
        ]),
        json!([[2, [false, [[4, "c", 1, 0, 0, 0]]]]]),
        json!([[0, [false, [[4, "x", 2, 0, 0, 0]]]]]),
    ] {
        let mut v = patch(2);
        v["changedRows"] = changes;
        assert!(prepare(&store, &v).is_err());
    }
    let mut v = patch(2);
    v["modes"]["alternateScreen"] = json!(true);
    assert!(prepare(&store, &v).is_err());
    assert!(matches!(
        prepare(&store, &patch(2)).unwrap(),
        Outcome::Ready(_)
    ));
}
#[test]
fn new_epoch_full_replaces_baseline_and_rejects_invalid_identity() {
    let mut store = Store::default();
    store.commit(ready(&store, &full(9)));
    let mut v = full(1);
    v["epoch"] = json!("epoch-b");
    store.commit(ready(&store, &v));
    assert!(matches!(
        prepare(&store, &patch(2)).unwrap(),
        Outcome::Resync { base_seq: 0, .. }
    ));
    for epoch in [
        json!(""),
        json!("bad epoch"),
        json!("界"),
        json!("a".repeat(129)),
    ] {
        v["epoch"] = epoch;
        assert!(prepare(&store, &v).is_err());
    }
}

#[test]
fn null_fields_and_malformed_stale_full_remain_fatal() {
    let mut store = Store::default();
    store.commit(ready(&store, &full(1)));
    for field in ["baseSeq", "changedRows"] {
        let mut v = full(2);
        v[field] = json!(null);
        assert!(prepare(&store, &v).is_err());
    }
    let mut v = patch(2);
    v["grid"] = json!(null);
    assert!(prepare(&store, &v).is_err());
    let mut v = full(1);
    v["grid"][0][1][0][2] = json!(0);
    assert!(prepare(&store, &v).is_err());
}

#[test]
fn malformed_payload_is_fatal_even_without_matching_base() {
    for has_base in [false, true] {
        let mut store = Store::default();
        if has_base {
            store.commit(ready(&store, &full(1)));
        }
        for (field, value) in [
            ("changedRows", json!([[1, [false, [[0, "c", 1, 0, 0, 0]]]]])),
            ("changedRows", json!([[1, [false, [[5, "c", 1, 0, 0, 0]]]]])),
            ("history", json!([[false, [[4, "x", 0, 0, 0, 0]]]])),
            (
                "cursor",
                json!({"x":4,"y":0,"hidden":false,"style":"block","blink":false}),
            ),
        ] {
            let mut v = patch(3);
            v[field] = value;
            assert!(prepare(&store, &v).is_err());
        }
    }
}
