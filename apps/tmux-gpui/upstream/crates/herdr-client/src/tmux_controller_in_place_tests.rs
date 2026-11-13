#![allow(clippy::unwrap_used)]
//! Capability 119 at the controller: a pane change followed in place.
use super::super::tests::fixture;
use super::*;
use serde_json::{Value, json};

/// The fixture's stream, as if its ready frame had said `topologyInPlace`.
fn in_place() -> (
    Controller,
    std::sync::mpsc::Receiver<Value>,
    std::sync::mpsc::Sender<Value>,
    std::thread::JoinHandle<()>,
) {
    let (mut controller, observed, response, peer) = fixture();
    controller.in_place.enabled = true;
    (controller, observed, response, peer)
}
fn topology(epoch: u64, panes: &[&str], removed: &[&str], added: &[&str]) -> Value {
    json!({"type":"topology","topologyEpoch":epoch,"panes":panes,"removed":removed,"added":added})
}
/// A layout snapshot of one window with `panes` side by side, `active` active.
fn snapshot(epoch: u64, panes: &[&str], active: &str) -> Value {
    let layout: Vec<Value> = (panes.iter().enumerate())
        .map(|(index, pane)| json!({"pane":pane,"left":index * 5,"top":0,"width":4,"height":2,"active":*pane == active}))
        .collect();
    json!({"type":"layout-snapshot","topologyEpoch":epoch,"layouts":[{"type":"layout",
        "semanticWindowId":"window.one","windowName":"Window","currentWindow":true,
        "cols":panes.len() * 5 - 1,"rows":2,"zoomed":false,"paneBorderStatus":"off","modeKeys":null,"panes":layout}],
        "windowLinks":{"liveSessionId":"live-session.aaaaaaaaaaaaaaaaaaaa","linkRevision":1,
        "activeLinkId":"window-link.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "links":[{"linkId":"window-link.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","semanticWindowId":"window.one","displayIndex":0}]}})
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

/// Another client closed the pane that is not selected. Between the frame
/// and its layout snapshot the old layout still names it: that must not end
/// the stream, and what was painted stays up without input.
#[test]
fn a_pane_closed_elsewhere_leaves_the_stream_open_and_the_window_follows() {
    let (mut c, _observed, _response, _peer) = in_place();
    c.session
        .push_control(topology(4, &["left"], &["right"], &[]));
    let update = c.poll(1).unwrap();
    assert_eq!(
        regions(&update),
        ["left", "right"],
        "the old window was dropped"
    );
    assert!(!c.actionable, "input was taken between frame and layout");
    assert!(!c.current.contains_key("right"));
    // The snapshot of the frame's epoch: one pane, and input is back.
    c.session.push_control(snapshot(4, &["left"], "left"));
    let update = c.poll(2).unwrap();
    assert_eq!(regions(&update), ["left"]);
    assert!(c.actionable);
    assert_eq!(c.selected(), "left");
}

#[test]
fn a_closed_selected_pane_hands_the_selection_to_the_pane_tmux_made_active() {
    let (mut c, _observed, _response, _peer) = in_place();
    assert_eq!(c.selected(), "left");
    c.session
        .push_control(topology(4, &["right"], &["left"], &[]));
    c.poll(1).unwrap();
    assert!(!c.actionable);
    // An older snapshot is not the answer to this frame.
    c.session
        .push_control(snapshot(3, &["left", "right"], "left"));
    c.poll(1).unwrap();
    assert!(!c.actionable);
    c.session.push_control(snapshot(4, &["right"], "right"));
    let update = c.poll(2).unwrap();
    assert_eq!(c.selected(), "right");
    assert_eq!(regions(&update), ["right"]);
    assert!(c.actionable);
}

/// Another client split a pane in. The old window stays up until the new
/// pane's seed commits; then the window has three panes and takes input.
#[test]
fn a_pane_split_in_elsewhere_paints_with_its_seed_and_never_blanks_the_window() {
    let (mut c, _observed, _response, _peer) = in_place();
    c.session
        .push_control(topology(4, &["left", "right", "third"], &[], &["third"]));
    c.session
        .push_control(snapshot(4, &["left", "right", "third"], "left"));
    let update = c.poll(1).unwrap();
    assert_eq!(regions(&update), ["left", "right"], "the window blanked");
    assert!(!c.actionable);
    // The seed commits.
    let seed = c.current.get("left").cloned().unwrap();
    c.session.push_commit("third", seed);
    let update = c.poll(50).unwrap();
    assert_eq!(regions(&update), ["left", "right", "third"]);
    assert!(c.actionable);
    assert_eq!(c.selected(), "left");
}

/// A seed that never comes does not keep a stale window up for ever.
#[test]
fn the_old_window_is_held_for_two_seconds_at_most() {
    let (mut c, _observed, _response, _peer) = in_place();
    c.session
        .push_control(topology(4, &["left", "right", "third"], &[], &["third"]));
    c.session
        .push_control(snapshot(4, &["left", "right", "third"], "left"));
    assert_eq!(regions(&c.poll(1_000).unwrap()), ["left", "right"]);
    assert_eq!(regions(&c.poll(2_999).unwrap()), ["left", "right"]);
    assert!(regions(&c.poll(3_000).unwrap()).is_empty());
    assert!(!c.actionable);
    // The seed, late: the window comes back with all three panes.
    let seed = c.current.get("left").cloned().unwrap();
    c.session.push_commit("third", seed);
    assert_eq!(regions(&c.poll(3_500).unwrap()), ["left", "right", "third"]);
    assert!(c.actionable);
}

/// The 2 s rule: with `topologyInPlace`, a pane whose source closed is
/// removed by a frame. If none comes the stream is stale and is replaced.
#[test]
fn a_closed_pane_that_no_frame_removes_within_two_seconds_ends_the_stream() {
    let (mut c, _observed, _response, _peer) = in_place();
    c.session.mark_panes(&[], &["right"]);
    c.poll(1_000).unwrap();
    c.poll(2_999).unwrap();
    assert!(matches!(
        c.poll(3_000),
        Err(Error::Topology(tmux_topology::Error::Unissued))
    ));
    // The frame in time settles it.
    let (mut c, _observed, _response, _peer) = in_place();
    c.session.mark_panes(&[], &["right"]);
    c.poll(1_000).unwrap();
    c.session.mark_panes(&[], &[]);
    c.session
        .push_control(topology(4, &["left"], &["right"], &[]));
    c.session.push_control(snapshot(4, &["left"], "left"));
    c.poll(1_500).unwrap();
    c.poll(60_000).unwrap();
    // A stream without the capability keeps today's behaviour: the pane
    // stays marked until the daemon closes the stream.
    let (mut c, _observed, _response, _peer) = fixture();
    c.session.mark_panes(&[], &["right"]);
    c.poll(1_000).unwrap();
    c.poll(60_000).unwrap();
}

#[test]
fn a_frame_on_a_stream_that_did_not_agree_to_it_ends_the_stream() {
    let (mut c, _observed, _response, _peer) = fixture();
    c.session
        .push_control(topology(4, &["left"], &["right"], &[]));
    assert!(c.poll(1).is_err());
}
