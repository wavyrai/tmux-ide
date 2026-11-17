#![allow(clippy::unwrap_used)]
//! PM, 17 Nov: panes of windows that are not on screen are marked `hidden`, so
//! the daemon sends them nothing until their window is shown again.
use super::super::tests::fixture;
use super::*;
use serde_json::{Value, json};
use std::time::Duration;

/// `left` in window.one, `right` in window.two.
fn two_windows(epoch: u64) -> Value {
    let window = |id: &str, pane: &str, current: bool| {
        json!({"type":"layout","semanticWindowId":id,"windowName":id,"currentWindow":current,
            "cols":4,"rows":2,"zoomed":false,"paneBorderStatus":"off","modeKeys":null,
            "panes":[{"pane":pane,"left":0,"top":0,"width":4,"height":2,"active":true}]})
    };
    json!({"type":"layout-snapshot","topologyEpoch":epoch,
        "layouts":[window("window.one","left",true), window("window.two","right",false)],
        "windowLinks":{"liveSessionId":"live-session.aaaaaaaaaaaaaaaaaaaa","linkRevision":1,
        "activeLinkId":"window-link.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "links":[{"linkId":"window-link.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","semanticWindowId":"window.one","displayIndex":0},
                 {"linkId":"window-link.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","semanticWindowId":"window.two","displayIndex":1}]}})
}
/// The visibility frames the peer saw, by pane.
fn sent(
    observed: &std::sync::mpsc::Receiver<Value>,
    response: &std::sync::mpsc::Sender<Value>,
) -> Vec<(String, String)> {
    frames(observed, response)
        .into_iter()
        .map(|frame| {
            (
                frame["pane"].as_str().unwrap().to_owned(),
                frame["visibility"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}
fn frames(
    observed: &std::sync::mpsc::Receiver<Value>,
    response: &std::sync::mpsc::Sender<Value>,
) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(frame) = observed.recv_timeout(Duration::from_millis(300)) {
        // The fixture's peer waits for one answer per frame before it reads on.
        response
            .send(json!({"type":"authority-snapshot","snapshot":super::super::tests::authority()}))
            .unwrap();
        if frame["type"] == "terminal-delivery-visibility" {
            assert_eq!(frame["workspaceName"], "workspace");
            frames.push(frame);
        }
    }
    frames
}

#[test]
fn a_pane_in_a_window_not_on_screen_is_hidden_and_shown_again_with_its_window() {
    let (mut c, observed, response, _peer) = fixture();
    c.session.push_control(two_windows(1));
    c.poll(1).unwrap();
    assert_eq!(
        sent(&observed, &response),
        [("right".into(), "hidden".into())]
    );
    // Nothing changed: nothing more is sent.
    c.poll(2).unwrap();
    assert!(sent(&observed, &response).is_empty());
    // The other window is shown: its pane is visible again, the first hidden.
    c.selected = "right".into();
    c.poll(3).unwrap();
    let mut frames = sent(&observed, &response);
    frames.sort();
    assert_eq!(
        frames,
        [
            ("left".into(), "hidden".into()),
            ("right".into(), "visible".into())
        ]
    );
}

/// Panes side by side in the window on screen are all visible: nothing is sent.
#[test]
fn panes_of_the_window_on_screen_are_left_visible() {
    let (mut c, observed, response, _peer) = fixture();
    c.poll(1).unwrap();
    assert!(sent(&observed, &response).is_empty());
}

fn regions(update: &Update) -> Vec<String> {
    (update.window.as_ref())
        .map(|window| {
            window
                .paint
                .regions
                .iter()
                .map(|r| r.pane.clone())
                .collect()
        })
        .unwrap_or_default()
}
/// `pane`'s next committed state: a later revision, or a new delivery.
fn commit(c: &Controller, pane: &str, revision: u64, nonce: &str) {
    let old = c.current[pane].clone();
    c.session.push_commit(
        pane,
        Arc::new(CommittedPane {
            snapshot: old.snapshot.clone(),
            identity: Arc::new(tmux_native_session::CommittedIdentity {
                generation: old.identity.generation.clone(),
                incarnation: old.identity.incarnation.clone(),
                delivery_nonce: nonce.into(),
                canonical_revision: revision,
                canonical_state_hash: old.identity.canonical_state_hash.clone(),
            }),
        }),
    );
}
/// The window on screen moves to `pane`'s, as a landed selection does.
fn show(c: &mut Controller, pane: &str, epoch: u64) {
    c.selected = pane.into();
    c.presentation = Presentation::new(pane.into()).unwrap();
    c.session.push_control(two_windows(epoch));
}

/// Review of ae2ac5e8 (blocking 1): a window shown again never paints a hidden
/// pane's old state while its fresh state comes within the bound: the window
/// being left stays up until then.
#[test]
fn a_window_shown_again_waits_for_its_fresh_state_and_never_paints_the_old() {
    let (mut c, observed, response, _peer) = fixture();
    c.session.push_control(two_windows(1));
    c.poll(1).unwrap();
    assert_eq!(
        sent(&observed, &response),
        [("right".into(), "hidden".into())]
    );
    show(&mut c, "right", 2);
    let held = c.poll(10).unwrap();
    assert_eq!(
        regions(&held),
        ["left"],
        "the old state of right was painted"
    );
    assert!(!held.window.as_ref().unwrap().coherent);
    commit(&c, "right", 2, super::super::tests::TOKEN);
    let shown = c.poll(60).unwrap();
    assert_eq!(regions(&shown), ["right"]);
    assert_eq!(c.current["right"].identity.canonical_revision, 2);
}

/// No fresh state within the bound (nothing changed while hidden, or a slow
/// link): the window is shown with what there is, never left blank or held.
#[test]
fn a_window_shown_again_is_painted_after_the_bound_without_fresh_state() {
    let (mut c, observed, response, _peer) = fixture();
    c.session.push_control(two_windows(1));
    c.poll(1).unwrap();
    sent(&observed, &response);
    show(&mut c, "right", 2);
    assert_eq!(regions(&c.poll(10).unwrap()), ["left"]);
    assert_eq!(regions(&c.poll(10 + REVEAL_MS - 1).unwrap()), ["left"]);
    assert_eq!(regions(&c.poll(10 + REVEAL_MS).unwrap()), ["right"]);
}

/// Review of ae2ac5e8 (blocking 2): a new delivery for a hidden pane (reseed,
/// new incarnation) starts visible on the daemon, so it is hidden again.
#[test]
fn a_new_delivery_of_a_hidden_pane_is_hidden_again() {
    let (mut c, observed, response, _peer) = fixture();
    c.session.push_control(two_windows(1));
    c.poll(1).unwrap();
    assert_eq!(
        sent(&observed, &response),
        [("right".into(), "hidden".into())]
    );
    let renewed = "0f6c4cf1-7b9b-4d8e-9a39-2b1f7d6c0e11";
    commit(&c, "right", 1, renewed);
    c.poll(2).unwrap();
    let again = frames(&observed, &response);
    assert_eq!(again.len(), 1, "{again:?}");
    assert_eq!(again[0]["pane"], "right");
    assert_eq!(again[0]["visibility"], "hidden");
    assert_eq!(again[0]["deliveryNonce"], renewed);
}
