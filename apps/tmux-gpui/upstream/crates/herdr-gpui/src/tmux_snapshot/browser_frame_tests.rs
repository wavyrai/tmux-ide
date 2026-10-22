#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
fn publication(sequence: u64, seq: u64, delta: bool) -> Value {
    let mut snapshot: Value =
        serde_json::from_str(include_str!("../../../../../fixtures/snapshot.json")).unwrap();
    snapshot["encoding"] = json!(if delta { "rle-delta-v1" } else { "rle-v1" });
    snapshot["epoch"] = json!("epoch");
    snapshot["seq"] = json!(seq);
    snapshot["history"] = json!([]);
    if delta {
        snapshot.as_object_mut().unwrap().remove("grid");
        snapshot["baseSeq"] = json!(seq - 1);
        snapshot["changedRows"] = json!([]);
    } else {
        snapshot["grid"] = json!(vec![json!([false, [[60, "a", 1, 0, 0, 0]]]); 20]);
    }
    json!({"version":1,"inputReady":true,"connection":"a","sequence":sequence,"request":4,
        "sessions":[{"id":"s","label":"Session"}],"panes":[{"id":"p","label":"Pane"}],
        "selectedSession":"s","selectedPane":"p","status":"Ready","snapshot":snapshot})
}
fn accept(r: &mut Reader, v: Value) -> Result<State, Error> {
    r.accept(&serde_json::to_vec(&v).unwrap())
}
#[test]
fn missing_baseline_recovers_without_retiring_or_granting_input() {
    let mut r = Reader {
        delta: true,
        ..Reader::default()
    };
    let state = accept(&mut r, publication(1, 2, true)).unwrap();
    assert!(!state.input_ready);
    assert!(state.frame.is_none());
    assert!(state.selected_pane.is_none());
    assert!(matches!(
        r.resync.take(),
        Some(Command::FrameResync {
            request: 4,
            base_seq: 0,
            ..
        })
    ));
    accept(&mut r, publication(2, 3, true)).unwrap();
    assert!(r.resync.is_none());
    let state = accept(&mut r, publication(3, 4, false)).unwrap();
    assert!(state.input_ready);
    assert_eq!(state.selected_pane.as_deref(), Some("p"));
    assert_eq!(state.request, 4);
    assert!(
        accept(&mut r, publication(4, 5, true))
            .unwrap()
            .frame
            .is_some()
    );
}
#[test]
fn outer_validation_failure_leaves_delta_base_atomic() {
    let mut r = Reader {
        delta: true,
        ..Reader::default()
    };
    accept(&mut r, publication(1, 1, false)).unwrap();
    let mut bad = publication(2, 2, true);
    bad["regions"] = json!([{"id":"p","left":0,"top":0,"width":61,"height":1}]);
    assert!(accept(&mut r, bad).is_err());
    assert!(accept(&mut r, publication(2, 2, true)).unwrap().input_ready);
    let mut departed = publication(3, 1, false);
    departed["request"] = json!(3);
    assert!(accept(&mut r, departed).is_err());
    assert!(accept(&mut r, publication(3, 3, true)).unwrap().input_ready);
}

#[test]
fn baseline_gap_still_validates_outer_geometry_and_epoch_changes_resync() {
    let mut r = Reader {
        delta: true,
        ..Reader::default()
    };
    let mut bad = publication(1, 2, true);
    bad["regions"] = json!([{"id":"p","left":0,"top":0,"width":61,"height":1}]);
    assert!(accept(&mut r, bad).is_err());
    assert!(r.resync.is_none());
    accept(&mut r, publication(1, 2, true)).unwrap();
    r.resync.take();
    let mut next = publication(2, 2, true);
    next["snapshot"]["epoch"] = json!("new-epoch");
    accept(&mut r, next).unwrap();
    assert!(matches!(r.resync.take(),Some(Command::FrameResync{epoch,..}) if epoch=="new-epoch"));
}
