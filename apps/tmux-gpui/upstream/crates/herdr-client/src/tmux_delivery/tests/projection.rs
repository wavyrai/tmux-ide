use super::*;
#[test]
fn projection_vectors_verify_source_commitment_and_distinct_partial_root() {
    let vectors: Value = serde_json::from_str(include_str!("projection-vectors.json")).unwrap();
    let mut store = ProjectionStore::default();
    let mut previous: Option<Arc<Snapshot>> = None;
    for (index, v) in vectors["vectors"].as_array().unwrap().iter().enumerate() {
        let bytes: Vec<u8> = serde_json::from_value(v["bytes"].clone()).unwrap();
        assert_eq!(
            hash_representation(&bytes),
            v["representationHash"].as_str().unwrap()
        );
        let update = decode_projection(&bytes).unwrap();
        let changes = store
            .apply(
                update,
                v["canonicalStateHash"].as_str().unwrap(),
                v["projectionStateHash"].as_str().unwrap(),
            )
            .unwrap();
        if let Some(snapshot) = store.snapshot() {
            assert!(snapshot.history.materialized().is_none());
            assert!(snapshot.modes.alternate_screen);
            assert_eq!(
                hash_snapshot(snapshot),
                v["canonicalStateHash"].as_str().unwrap()
            );
            assert_eq!(
                hash_projection(snapshot).unwrap(),
                v["projectionStateHash"].as_str().unwrap()
            );
            assert!(
                Store::default()
                    .apply(
                        Update::Seed {
                            revision: 7,
                            snapshot: (**snapshot).clone()
                        },
                        &hash_snapshot(snapshot)
                    )
                    .is_err()
            );
            if index == 1 {
                assert_eq!(changes, vec![1]);
                assert!(Arc::ptr_eq(
                    &previous.as_ref().unwrap().grid[0],
                    &snapshot.grid[0]
                ));
            }
            previous = Some(snapshot.clone());
        } else {
            assert_eq!(index, 2);
        }
        for length in 0..bytes.len() {
            assert!(decode_projection(&bytes[..length]).is_err());
        }
        let mut trailing = bytes;
        trailing.push(0);
        assert!(decode_projection(&trailing).is_err());
    }
}
#[test]
fn projection_bad_commitment_never_replaces_retained_rows() {
    let vectors: Value = serde_json::from_str(include_str!("projection-vectors.json")).unwrap();
    let v = &vectors["vectors"][0];
    let bytes: Vec<u8> = serde_json::from_value(v["bytes"].clone()).unwrap();
    let mut store = ProjectionStore::default();
    assert!(
        store
            .apply(
                decode_projection(&bytes).unwrap(),
                "0000000000000000",
                v["projectionStateHash"].as_str().unwrap()
            )
            .is_err()
    );
    assert!(store.snapshot().is_none());
    let ProjectionUpdate::Seed { mut snapshot, .. } = decode_projection(&bytes).unwrap() else {
        panic!("seed")
    };
    snapshot.modes.alternate_screen = false;
    assert!(
        store
            .apply(
                ProjectionUpdate::Seed {
                    revision: 7,
                    snapshot
                },
                v["canonicalStateHash"].as_str().unwrap(),
                v["projectionStateHash"].as_str().unwrap()
            )
            .is_err()
    );
    assert!(store.snapshot().is_none());
}
#[test]
fn projection_resize_seed_replaces_grid_and_identical_revision_reseed_requires_both_roots() {
    let fixture: Value = serde_json::from_str(include_str!("projection-vectors.json")).unwrap();
    let bytes: Vec<u8> = serde_json::from_value(fixture["vectors"][0]["bytes"].clone()).unwrap();
    let mut store = ProjectionStore::default();
    let source = fixture["vectors"][0]["canonicalStateHash"]
        .as_str()
        .unwrap();
    let projection = fixture["vectors"][0]["projectionStateHash"]
        .as_str()
        .unwrap();
    store
        .apply(decode_projection(&bytes).unwrap(), source, projection)
        .unwrap();
    store
        .apply(decode_projection(&bytes).unwrap(), source, projection)
        .unwrap();
    assert!(
        store
            .apply(
                decode_projection(&bytes).unwrap(),
                source,
                "0000000000000000"
            )
            .is_err()
    );
    let mut resized = (**store.snapshot().unwrap()).clone();
    resized.rows = 3;
    resized.grid.push(resized.grid[0].clone());
    let source = hash_snapshot(&resized);
    let projection = hash_projection(&resized).unwrap();
    store
        .apply(
            ProjectionUpdate::Seed {
                revision: 8,
                snapshot: resized,
            },
            &source,
            &projection,
        )
        .unwrap();
    assert_eq!(store.snapshot().unwrap().rows, 3);
    assert!(
        store
            .apply(
                decode_projection(&bytes).unwrap(),
                source.as_str(),
                projection.as_str()
            )
            .is_err()
    );
}
