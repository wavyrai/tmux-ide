use super::*;

#[test]
fn viewport_projection_changes_do_not_require_image_store_mutations() {
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    graphics.bind("pane", &committed(vector)).unwrap();
    let mut value = vector["state"].clone();
    value["placements"] = json!([]);
    state(&mut graphics, "pane", &value, now);
    // The daemon's revision belongs to KittyImageStore. Moving the viewport
    // changes clipped placements without mutating that store or its revision.
    value["placements"] = json!([{
        "digest": value["images"][0]["digest"],
        "row": 0, "column": 0, "rows": 1, "columns": 1,
        "sourceRow": 1, "sourceColumn": 0, "totalRows": 2, "totalColumns": 1
    }]);
    assert!(state(&mut graphics, "pane", &value, now).state_changed);
    assert!(!state(&mut graphics, "pane", &value, now).state_changed);
    assert_eq!(
        graphics.panes["pane"].state.as_ref().unwrap().placements[0].source_row,
        1
    );
    value["placements"] = json!([]);
    assert!(state(&mut graphics, "pane", &value, now).state_changed);
    assert!(
        graphics.panes["pane"]
            .state
            .as_ref()
            .unwrap()
            .placements
            .is_empty()
    );
}

#[test]
fn unchanged_revision_still_rejects_registry_and_capability_changes() {
    for field in ["images", "localFiles"] {
        let vector = &vectors()[0];
        let now = Instant::now();
        let mut graphics = graphics();
        graphics.bind("pane", &committed(vector)).unwrap();
        let original = vector["state"].clone();
        state(&mut graphics, "pane", &original, now);
        let mut changed = original.clone();
        if field == "images" {
            changed["images"][0]["imageId"] = json!(900);
        } else {
            changed["localFiles"] = json!(true);
        }
        let message =
            to_raw_value(&json!({"type":"terminal-graphics","pane":"pane","state":changed}))
                .unwrap();
        assert!(matches!(
            graphics.accept_control(&message, now),
            Err(Error::Ordering)
        ));
        assert_eq!(
            graphics.panes["pane"].state.as_ref().unwrap(),
            &serde_json::from_value::<State>(original).unwrap()
        );
    }
}
