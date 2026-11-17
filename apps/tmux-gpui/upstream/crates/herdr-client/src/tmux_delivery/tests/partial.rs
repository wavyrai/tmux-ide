//! Capability 122 at the store: what the receiver's own checks would also
//! catch is still refused here.
use super::*;
use base64::Engine;

fn seeded() -> (Store, String, DeferredHistory) {
    let all: Value = serde_json::from_str(include_str!("partial-history-vectors.json")).unwrap();
    let seed = &all["semantic-compact-v1"][0];
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(seed["wire"].as_str().unwrap())
        .unwrap();
    let hash = seed["canonicalStateHash"].as_str().unwrap().to_owned();
    let unloaded = DeferredHistory {
        rows: 300,
        digest: seed["historyUnloaded"]["digest"].as_str().unwrap().into(),
    };
    let mut store = Store::default();
    store
        .apply_with(
            decode_compact(&bytes).unwrap(),
            &hash,
            Some(unloaded.clone()),
        )
        .unwrap();
    (store, hash, unloaded)
}
fn loaded(store: &Store) -> Vec<Arc<Row>> {
    store
        .snapshot()
        .unwrap()
        .history
        .materialized()
        .unwrap()
        .to_vec()
}

/// A patch that moves loaded rows back into the unloaded part keeps the
/// whole history, and so the hash, the same. The commitment must never grow.
#[test]
fn a_patch_cannot_grow_the_unloaded_rows_even_with_a_matching_hash() {
    let (mut store, hash, unloaded) = seeded();
    let rows = loaded(&store);
    let grown = DeferredHistory {
        rows: 310,
        digest: hash::concat_rows_hash(&unloaded.digest, &rows[..10]).unwrap(),
    };
    let patch = Patch {
        dimensions: None,
        rows: Vec::new(),
        history: None,
        history_delta: Some((10, Vec::new())),
        cursor: None,
        modes: None,
        placements: None,
        bootstrap: None,
    };
    let update = Update::Patch {
        base_revision: 0,
        revision: 1,
        patch,
    };
    assert!(store.apply_with(update, &hash, Some(grown)).is_err());
    assert_eq!(store.revision(), Some(0));
}

/// A history frame belongs to the committed revision and hash.
#[test]
fn a_history_frame_must_name_the_committed_revision_and_hash() {
    let (store, hash, unloaded) = seeded();
    let rows = loaded(&store);
    drop(store);
    // Not a real chunk, but these are checked before the rows are.
    for (revision, expected) in [(1, hash.as_str()), (0, "0123456789abcdef")] {
        let (mut store, _, _) = seeded();
        let update = Update::History {
            revision,
            rows: rows[..1].to_vec(),
        };
        let result = store.apply_with(update, expected, Some(unloaded.clone()));
        assert!(
            matches!(result, Err(Error::Revision)),
            "{revision} {expected}"
        );
    }
}
