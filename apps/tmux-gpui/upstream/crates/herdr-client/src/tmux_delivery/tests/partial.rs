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

/// #435 review: a chain of chunks can end in a nonzero empty commitment that
/// still matches the canonical hash with wrong rows (P is odd, so any rows
/// have a matching "next" digest). An empty commitment must be the digest of
/// no rows; with that pin each chunk check is an induction proof.
#[test]
fn a_forged_chunk_chain_ending_in_a_nonzero_empty_commitment_is_refused() {
    let (mut store, hash, unloaded) = seeded();
    // 300 wrong rows for the 300 unloaded ones.
    let wrong = vec![loaded(&store)[0].clone(); 300];
    // next = (old − H(wrong)) · P^−300, so next·P^300 + H(wrong) == old.
    const P: u64 = 0x100000001b3;
    let mut inverse = P;
    for _ in 0..6 {
        inverse = inverse.wrapping_mul(2u64.wrapping_sub(P.wrapping_mul(inverse)));
    }
    let old = u64::from_str_radix(&unloaded.digest, 16).unwrap();
    let rows = u64::from_str_radix(
        &hash::concat_rows_hash("0000000000000000", &wrong).unwrap(),
        16,
    )
    .unwrap();
    let next = old
        .wrapping_sub(rows)
        .wrapping_mul(inverse.wrapping_pow(300));
    let forged = DeferredHistory {
        rows: 0,
        digest: format!("{next:016x}"),
    };
    // The forgery verifies by hash alone.
    assert_eq!(
        hash::concat_rows_hash(&forged.digest, &wrong).unwrap(),
        unloaded.digest
    );
    let update = Update::History {
        revision: 0,
        rows: wrong,
    };
    assert!(store.apply_with(update, &hash, Some(forged)).is_err());
    assert_eq!(store.snapshot().unwrap().history.unloaded_rows(), 300);
}

/// The same pin on a seed and a patch: nothing unloaded is the empty digest.
#[test]
fn an_empty_commitment_must_be_the_digest_of_no_rows() {
    let partial = |digest: &str| {
        let mut s = Store::default();
        let (seeded, hash, _) = seeded();
        let mut snapshot = Snapshot::clone(seeded.snapshot().unwrap());
        let History::Partial(held) = snapshot.history.clone() else {
            panic!("partial")
        };
        snapshot.history = History::Complete(held.loaded);
        let result = s.apply_with(
            Update::Seed {
                revision: 0,
                snapshot,
            },
            &hash,
            Some(DeferredHistory {
                rows: 0,
                digest: digest.into(),
            }),
        );
        matches!(result, Err(Error::Invalid(_)))
    };
    assert!(partial("0123456789abcdef"));
    // The empty digest is admitted by the bound check (the hash then decides).
    assert!(!partial("0000000000000000"));
}
