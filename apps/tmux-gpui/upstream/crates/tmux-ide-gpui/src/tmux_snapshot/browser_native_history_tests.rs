#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
fn reply() -> serde_json::Value {
    json!({"type":"native-history-result","version":1,"id":"b987f903-e864-43dd-8591-8d0a464ca6e8","request":3,"operationId":1,"status":"ok","body":"{}"})
}
#[test]
fn reply_envelope_requires_exact_bounded_identity_and_status() {
    let baseline = reply();
    assert!(Response::parse(&serde_json::to_vec(&baseline).unwrap()).is_ok());
    for (field, value) in [
        ("id", json!("bad")),
        ("request", json!(9007199254740992_u64)),
        ("version", json!(2)),
        ("status", json!("unknown")),
        ("body", json!(null)),
        ("extra", json!(true)),
    ] {
        let mut bad = baseline.clone();
        bad[field] = value;
        assert!(
            Response::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "{field}"
        );
    }
    let mut failed = baseline;
    failed["status"] = json!("failed");
    assert!(Response::parse(&serde_json::to_vec(&failed).unwrap()).is_err());
    failed.as_object_mut().unwrap().remove("body");
    assert!(Response::parse(&serde_json::to_vec(&failed).unwrap()).is_ok());
}
#[test]
fn navigation_before_first_frame_preserves_pending_anchor() {
    let cache: Cache = Default::default();
    let key = (
        "server".into(),
        "generation".into(),
        "workspace".into(),
        "session".into(),
        "%1".into(),
    );
    cache.borrow_mut().insert(key.clone(), "opaque".into());
    let history = History::new(
        Some(("server".into(), "generation".into())),
        "workspace".into(),
        "session".into(),
        "%1".into(),
        cache.clone(),
    );
    history.save(&NativePresentation::new("connection", "workspace"));
    assert_eq!(cache.borrow().get(&key).map(String::as_str), Some("opaque"));
}

use herdr_client::{
    tmux_delivery::{Update, decode_compact},
    tmux_history::Scroll,
    tmux_native_session::{CommittedIdentity, CommittedPane},
    tmux_topology::{CopyRegion, PresentedWindow, Region, WindowPaint},
};
use std::sync::Arc;
const SERVER: &str = "tmux-server.0123456789abcdef0123456789abcdef";
const GENERATION: &str = "12345678-1234-4234-8234-123456789abc";
const SESSION: &str = "live-session.0123456789abcdef0123";
const TOKEN: &str = "22345678-1234-4234-8234-123456789abc";
const OTHER_TOKEN: &str = "32345678-1234-4234-8234-123456789abc";
const CONNECTION: &str = "b987f903-e864-43dd-8591-8d0a464ca6e8";

fn historical_presentation() -> NativePresentation {
    let value = json!({"v":1,"k":"terminal-semantic-compact","f":"s","r":0,"s":[2,1,[[0,[[2,"a",1,0,0,0]]]],[],[0,0,0,"block",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]});
    let Update::Seed { mut snapshot, .. } =
        decode_compact(&serde_json::to_vec(&value).unwrap()).unwrap()
    else {
        panic!("seed")
    };
    snapshot.history = vec![snapshot.grid[0].clone()].into();
    let window = PresentedWindow {
        coherent: true,
        paint: Arc::new(WindowPaint {
            window: "window".into(),
            selected_pane: "pane".into(),
            cols: 2,
            rows: 1,
            copy_region: CopyRegion {
                pane: "pane".into(),
                left: 0,
                top: 0,
                width: 2,
                height: 1,
                wrapped: vec![false],
            },
            modes: snapshot.modes.clone(),
            cursor: snapshot.cursor.clone(),
            mode_keys: None,
            zoomed: false,
            regions: vec![Region {
                pane: "pane".into(),
                left: 0,
                top: 0,
                width: 2,
                height: 1,
                content_top: 0,
                content_rows: 1,
                source: Arc::new(CommittedPane {
                    snapshot: Some(Arc::new(snapshot)),
                    identity: Arc::new(CommittedIdentity {
                        generation: GENERATION.into(),
                        incarnation: "one".into(),
                        delivery_nonce: "nonce".into(),
                        canonical_revision: 1,
                        canonical_state_hash: "0000000000000001".into(),
                    }),
                }),
            }],
        }),
    };
    let mut presentation = NativePresentation::new(CONNECTION, "workspace");
    presentation
        .apply(
            &mut super::super::browser::State {
                selected_session: Some(SESSION.into()),
                ..Default::default()
            },
            &window,
            true,
            true,
            1,
            0,
        )
        .unwrap();
    presentation.scroll(Scroll::Home);
    presentation
}
fn history() -> History {
    History::new(
        Some((SERVER.into(), GENERATION.into())),
        "workspace".into(),
        SESSION.into(),
        "pane".into(),
        Default::default(),
    )
}
fn issue(history: &mut History, presentation: &mut NativePresentation, now: u64) -> u64 {
    let command = history
        .request(presentation, CONNECTION, 3, SESSION, now)
        .unwrap()
        .unwrap();
    let Command::NativeHistory {
        operation_id, body, ..
    } = command
    else {
        panic!("history command")
    };
    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["operation"]["kind"], "capture");
    assert_eq!(body["proof"]["semanticPaneId"], "pane");
    operation_id
}
fn captured(operation: u64, token: &str) -> Response {
    let body = json!({"version":1,"server":{"serverId":SERVER,"generation":GENERATION},
        "result":{"status":"captured","token":token}})
    .to_string();
    let value = json!({"type":"native-history-result","version":1,"id":CONNECTION,
        "request":3,"operationId":operation,"status":"ok","body":body});
    Response::parse(&serde_json::to_vec(&value).unwrap()).unwrap()
}
#[test]
fn completed_capture_releases_navigation_before_deadline_and_saves_token() {
    let mut presentation = historical_presentation();
    let mut history = history();
    let operation = issue(&mut history, &mut presentation, 100);
    assert!(history.drain(&mut presentation, 101));
    assert!(
        history
            .response(&mut presentation, captured(operation, TOKEN), 102)
            .unwrap()
    );
    assert!(!history.drain(&mut presentation, 103));
    assert_eq!(presentation.history_token(), Some(TOKEN));
    assert_eq!(
        history
            .cache
            .borrow()
            .get(history.key.as_ref().unwrap())
            .map(String::as_str),
        Some(TOKEN)
    );
    assert!(
        history
            .request(&mut presentation, CONNECTION, 3, SESSION, 104)
            .unwrap()
            .is_none()
    );
}
#[test]
fn capture_timeout_releases_navigation_at_three_seconds_without_replay() {
    let mut presentation = historical_presentation();
    let mut history = history();
    let operation = issue(&mut history, &mut presentation, 100);
    assert!(history.drain(&mut presentation, 3099));
    assert!(!history.drain(&mut presentation, 3100));
    assert!(!history.drain(&mut presentation, 3101));
    assert!(
        history
            .request(&mut presentation, CONNECTION, 3, SESSION, 3102)
            .unwrap()
            .is_none()
    );
    assert!(
        !history
            .response(&mut presentation, captured(operation, TOKEN), 3103)
            .unwrap()
    );
    assert!(presentation.history_token().is_none());
    assert!(history.cache.borrow().is_empty());
}
#[test]
fn superseded_capture_response_cannot_release_new_navigation_wait_or_replace_token() {
    let mut presentation = historical_presentation();
    let mut history = history();
    let old = issue(&mut history, &mut presentation, 100);
    presentation.scroll(Scroll::End);
    presentation.scroll(Scroll::Home);
    let new = issue(&mut history, &mut presentation, 200);
    assert!(new > old);
    assert!(
        !history
            .response(&mut presentation, captured(old, OTHER_TOKEN), 201)
            .unwrap()
    );
    assert!(history.drain(&mut presentation, 3100));
    assert!(presentation.history_token().is_none());
    assert!(
        history
            .response(&mut presentation, captured(new, TOKEN), 3101)
            .unwrap()
    );
    assert!(!history.drain(&mut presentation, 3102));
    assert_eq!(presentation.history_token(), Some(TOKEN));
    assert!(
        !history
            .response(&mut presentation, captured(old, OTHER_TOKEN), 3103)
            .unwrap()
    );
    assert_eq!(presentation.history_token(), Some(TOKEN));
}
