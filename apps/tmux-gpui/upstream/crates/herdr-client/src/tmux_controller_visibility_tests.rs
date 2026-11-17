#![allow(clippy::unwrap_used)]
//! PM, 17 Nov: panes of windows that are not on screen are marked `hidden`, so
//! the daemon sends them nothing until their window is shown again.
use super::super::tests::fixture;
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
    let mut frames = Vec::new();
    while let Ok(frame) = observed.recv_timeout(Duration::from_millis(300)) {
        // The fixture's peer waits for one answer per frame before it reads on.
        response
            .send(json!({"type":"authority-snapshot","snapshot":super::super::tests::authority()}))
            .unwrap();
        if frame["type"] == "terminal-delivery-visibility" {
            assert_eq!(frame["workspaceName"], "workspace");
            assert_eq!(frame["deliveryNonce"], super::super::tests::TOKEN);
            frames.push((
                frame["pane"].as_str().unwrap().to_owned(),
                frame["visibility"].as_str().unwrap().to_owned(),
            ));
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
