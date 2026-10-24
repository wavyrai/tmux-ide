#![allow(clippy::unwrap_used)]
use super::*;
use crate::{
    tmux_delivery::{Store, decode_compact},
    tmux_native_session::{CommittedIdentity, CommittedPane},
};
use serde_json::{Value, json, value::to_raw_value};
use std::sync::Arc;
const GENERATION: &str = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";

fn frames() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!("tests/fixtures.json")).unwrap()["frames"]
        .as_array()
        .unwrap()
        .clone()
}
fn topology(frame: &Value) -> Topology {
    let mut topology =
        Topology::new(GENERATION.into(), vec!["left".into(), "right".into()]).unwrap();
    topology
        .apply_control(&to_raw_value(frame).unwrap())
        .unwrap();
    topology
}
fn sources(width: usize) -> BTreeMap<String, Arc<CommittedPane>> {
    let vectors: Vec<Value> =
        serde_json::from_str(include_str!("../tmux_delivery/tests/vectors.json")).unwrap();
    let mut store = Store::default();
    store
        .apply(
            decode_compact(vectors[0]["wire"].as_str().unwrap().as_bytes()).unwrap(),
            vectors[0]["canonicalHash"].as_str().unwrap(),
        )
        .unwrap();
    let mut snapshot = (**store.snapshot().unwrap()).clone();
    // Geometry variants share immutable rows from a valid TS fixture. Use a compact
    // seed to create actual width-matched rows, rather than fabricating row internals.
    let seed = json!({"k":"terminal-semantic-compact","v":1,"f":"s","r":1,"s":[width,2,
        [[0,[[width," ",1,0,0,0]]],[1,[[width," ",1,0,0,0]]]],[],[0,0,false,"block",false],
        [false,false,false,false,"none","default",false,false,false,false],[],"complete"]});
    // The existing vector contains the exact compact metadata shape; replace only dimensions/grid.
    let mut wire: Value = serde_json::from_str(vectors[0]["wire"].as_str().unwrap()).unwrap();
    wire["s"][0] = json!(width);
    wire["s"][1] = json!(2);
    wire["s"][2] = seed["s"][2].clone();
    wire["s"][3] = json!([]);
    wire["s"][4][0] = json!(0);
    wire["s"][4][1] = json!(0);
    wire["s"][6] = json!([]);
    if let crate::tmux_delivery::Update::Seed {
        snapshot: decoded, ..
    } = decode_compact(wire.to_string().as_bytes()).unwrap()
    {
        snapshot = decoded;
    }
    ["left", "right"]
        .into_iter()
        .map(|pane| {
            (
                pane.into(),
                Arc::new(CommittedPane {
                    snapshot: Some(Arc::new(snapshot.clone())),
                    identity: Arc::new(CommittedIdentity {
                        generation: GENERATION.into(),
                        incarnation: format!("{pane}:1"),
                        delivery_nonce: "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c".into(),
                        canonical_revision: 1,
                        canonical_state_hash: "0000000000000000".into(),
                    }),
                }),
            )
        })
        .collect()
}

#[test]
fn actual_typescript_layout_fixtures_parse_and_links_remain_authoritative() {
    for frame in frames() {
        let state = topology(&frame);
        assert_eq!(state.preferred_pane(), Some("right"));
    }
    let state = topology(&frames()[4]);
    assert_eq!(state.epoch(), Some(1));
    assert_eq!(
        state.links().unwrap().links[0].semantic_window_id,
        "window-a"
    );
}

#[test]
fn resize_skew_retains_only_same_scope_pixels_then_promotes_matching_sources() {
    for order in ["layout", "sources", "sibling"] {
        let mut state = topology(&frames()[0]);
        let mut presentation = Presentation::new("right".into()).unwrap();
        let source = sources(2);
        let first = presentation.update(&state, &source, true).unwrap().unwrap();
        assert!(first.coherent);
        assert_eq!(first.paint.cols, 5);
        let mut next_sources = source;
        if order == "layout" {
            state
                .apply_control(&to_raw_value(&frames()[1]).unwrap())
                .unwrap();
        } else if order == "sources" {
            next_sources = sources(3);
        } else {
            next_sources.insert("left".into(), sources(3).remove("left").unwrap());
        }
        let retained = presentation
            .update(&state, &next_sources, true)
            .unwrap()
            .unwrap();
        assert!(!retained.coherent);
        assert!(Arc::ptr_eq(&first.paint, &retained.paint));
        state
            .apply_control(&to_raw_value(&frames()[1]).unwrap())
            .unwrap();
        let final_frame = presentation
            .update(&state, &sources(3), true)
            .unwrap()
            .unwrap();
        assert!(final_frame.coherent);
        assert_eq!(final_frame.paint.cols, 7);
        assert_eq!(final_frame.paint.copy_region.left, 4);
    }
}

#[test]
fn status_rows_copy_modes_and_wrap_metadata_match_native_regions() {
    for (index, top) in [(2, 1), (3, 0)] {
        let state = topology(&frames()[index]);
        let source = sources(2);
        let mut presentation = Presentation::new("right".into()).unwrap();
        let frame = presentation.update(&state, &source, true).unwrap().unwrap();
        assert_eq!(frame.paint.copy_region.top, top);
        assert_eq!(frame.paint.copy_region.height, 2);
        assert_eq!(
            frame.paint.copy_region.wrapped,
            source["right"]
                .snapshot
                .as_ref()
                .unwrap()
                .grid
                .iter()
                .map(|row| row.wrapped())
                .collect::<Vec<_>>()
        );
        assert_eq!(frame.paint.mode_keys, Some(ModeKeys::Vi));
        assert_eq!(frame.paint.cursor.y, top);
        assert!(Arc::ptr_eq(
            &frame.paint.regions[1].source,
            &source["right"]
        ));
    }
}

#[test]
fn pane_switch_missing_tombstone_and_new_incarnation_never_reuse_stale_pixels() {
    let state = topology(&frames()[0]);
    let source = sources(2);
    let mut original = Presentation::new("right".into()).unwrap();
    original.update(&state, &source, true).unwrap();
    let mut switched = Presentation::new("left".into()).unwrap();
    assert!(
        switched
            .update(&state, &sources(3), true)
            .unwrap()
            .is_none()
    );
    let mut tombstone = source.clone();
    tombstone.insert(
        "right".into(),
        Arc::new(CommittedPane {
            snapshot: None,
            identity: Arc::clone(&source["right"].identity),
        }),
    );
    assert!(original.update(&state, &tombstone, true).unwrap().is_none());
    assert!(
        original
            .update(&state, &sources(3), true)
            .unwrap()
            .is_none()
    );
    original.update(&state, &source, true).unwrap();
    let mut changed = sources(3);
    let old = &changed["right"];
    changed.insert(
        "right".into(),
        Arc::new(CommittedPane {
            snapshot: old.snapshot.clone(),
            identity: Arc::new(CommittedIdentity {
                generation: GENERATION.into(),
                incarnation: "right:2".into(),
                delivery_nonce: old.identity.delivery_nonce.clone(),
                canonical_revision: 2,
                canonical_state_hash: old.identity.canonical_state_hash.clone(),
            }),
        }),
    );
    assert!(original.update(&state, &changed, true).unwrap().is_none());
}

#[test]
fn stale_generation_and_invalid_geometry_clear_cache() {
    let state = topology(&frames()[0]);
    let mut source = sources(2);
    let old = &source["right"];
    source.insert(
        "right".into(),
        Arc::new(CommittedPane {
            snapshot: old.snapshot.clone(),
            identity: Arc::new(CommittedIdentity {
                generation: "another-generation".into(),
                incarnation: old.identity.incarnation.clone(),
                delivery_nonce: old.identity.delivery_nonce.clone(),
                canonical_revision: 1,
                canonical_state_hash: old.identity.canonical_state_hash.clone(),
            }),
        }),
    );
    let mut presentation = Presentation::new("right".into()).unwrap();
    assert!(matches!(
        presentation.update(&state, &source, true),
        Err(Error::Identity)
    ));
    let mut frame = frames()[0].clone();
    frame["panes"][1]["left"] = json!(1);
    assert!(matches!(
        presentation.update(&topology(&frame), &sources(2), true),
        Err(Error::Bounds)
    ));
}

#[test]
fn malformed_topology_and_revisions_retire_without_partial_replacement() {
    for mutation in [
        "epoch",
        "link-revision",
        "link-identity",
        "duplicate-pane",
        "current",
        "extra",
    ] {
        let mut state = topology(&frames()[4]);
        let mut next = frames()[4].clone();
        next["topologyEpoch"] = json!(2);
        match mutation {
            "epoch" => next["topologyEpoch"] = json!(1),
            "link-revision" => next["windowLinks"]["linkRevision"] = json!(0),
            "link-identity" => next["windowLinks"]["links"][0]["displayIndex"] = json!(1),
            "duplicate-pane" => next["layouts"][0]["panes"][1]["pane"] = json!("left"),
            "current" => next["layouts"][0]["currentWindow"] = json!(false),
            _ => next["unknown"] = json!(true),
        }
        assert!(
            state.apply_control(&to_raw_value(&next).unwrap()).is_err(),
            "{mutation}"
        );
        assert!(state.layouts().is_empty());
        assert!(state.links().is_none());
    }
}

#[test]
fn advisory_membership_change_waits_for_atomic_authority_without_disconnect() {
    let mut state = topology(&frames()[4]);
    let mut presentation = Presentation::new("right".into()).unwrap();
    assert!(
        presentation
            .update(&state, &sources(2), true)
            .unwrap()
            .unwrap()
            .coherent
    );
    let mut advisory = frames()[0].clone();
    advisory["panes"].as_array_mut().unwrap().remove(0);
    state
        .apply_control(&to_raw_value(&advisory).unwrap())
        .unwrap();
    assert!(state.awaiting_authority());
    assert_eq!(state.layouts()["window-a"].panes.len(), 2);
    assert!(
        !presentation
            .update(&state, &sources(2), true)
            .unwrap()
            .unwrap()
            .coherent
    );
    let mut next = frames()[4].clone();
    next["topologyEpoch"] = json!(2);
    next["layouts"] = json!([advisory]);
    state.apply_control(&to_raw_value(&next).unwrap()).unwrap();
    assert!(!state.awaiting_authority());
    let final_frame = presentation
        .update(&state, &sources(2), true)
        .unwrap()
        .unwrap();
    assert!(final_frame.coherent);
    assert_eq!(final_frame.paint.regions.len(), 1);
    // A late old advisory cannot resurrect the removed pane or change link authority.
    state
        .apply_control(&to_raw_value(&frames()[0]).unwrap())
        .unwrap();
    assert_eq!(state.layouts()["window-a"].panes.len(), 1);
    assert_eq!(state.epoch(), Some(2));
    assert!(state.awaiting_authority());
}

#[test]
fn actual_daemon_split_close_layouts_validate_under_fresh_capability_scopes() {
    let fixture: Value = serde_json::from_str(include_str!("tests/live-layouts.json")).unwrap();
    for capture in fixture["frames"].as_array().unwrap() {
        let frame = &capture["frame"];
        let panes = frame["layouts"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|layout| layout["panes"].as_array().unwrap())
            .map(|pane| pane["pane"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(panes.len() as u64, capture["issuedPanes"].as_u64().unwrap());
        let mut state = Topology::new(GENERATION.into(), panes).unwrap();
        state.apply_control(&to_raw_value(frame).unwrap()).unwrap();
        assert!(state.preferred_pane().is_some());
        assert!(state.links().is_some());
    }
}
