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
/// The window is up and marked as one that is being updated.
fn updating(update: &Update) -> bool {
    update
        .window
        .as_ref()
        .is_some_and(|window| !window.coherent)
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
    assert!(updating(&update), "the held window reads as current");
    assert!(!c.actionable, "input was taken between frame and layout");
    assert!(!c.current.contains_key("right"));
    // The snapshot of the frame's epoch: one pane, and input is back.
    c.session.push_control(snapshot(4, &["left"], "left"));
    let update = c.poll(2).unwrap();
    assert_eq!(regions(&update), ["left"]);
    assert!(!updating(&update));
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
    assert!(updating(&update), "the held window reads as current");
    assert!(!c.actionable);
    // The seed commits.
    let seed = c.current.get("left").cloned().unwrap();
    c.session.push_commit("third", seed);
    let update = c.poll(50).unwrap();
    assert_eq!(regions(&update), ["left", "right", "third"]);
    assert!(c.actionable);
    assert_eq!(c.selected(), "left");
}

/// A window that cannot follow a frame is not kept up for ever, and the
/// terminal is not left blank either: after two seconds the stream ends as a
/// pane-set change, which the app answers with a new lease.
#[test]
fn a_window_that_cannot_follow_a_frame_within_two_seconds_ends_the_stream() {
    let (mut c, _observed, _response, _peer) = in_place();
    c.session
        .push_control(topology(4, &["left", "right", "third"], &[], &["third"]));
    c.session
        .push_control(snapshot(4, &["left", "right", "third"], "left"));
    assert_eq!(regions(&c.poll(1_000).unwrap()), ["left", "right"]);
    assert_eq!(regions(&c.poll(2_999).unwrap()), ["left", "right"]);
    assert!(matches!(
        c.poll(3_000),
        Err(Error::Topology(tmux_topology::Error::Unissued))
    ));
    // The seed in time: all three panes, and the clock is off.
    let (mut c, _observed, _response, _peer) = in_place();
    c.session
        .push_control(topology(4, &["left", "right", "third"], &[], &["third"]));
    c.session
        .push_control(snapshot(4, &["left", "right", "third"], "left"));
    c.poll(1_000).unwrap();
    let seed = c.current.get("left").cloned().unwrap();
    c.session.push_commit("third", seed);
    assert_eq!(regions(&c.poll(2_999).unwrap()), ["left", "right", "third"]);
    assert!(c.actionable);
    c.poll(60_000).unwrap();
    // The layout snapshot of the frame's epoch is owed within the same time.
    let (mut c, _observed, _response, _peer) = in_place();
    c.session
        .push_control(topology(4, &["left"], &["right"], &[]));
    assert_eq!(regions(&c.poll(1_000).unwrap()), ["left", "right"]);
    assert_eq!(regions(&c.poll(2_999).unwrap()), ["left", "right"]);
    assert!(matches!(
        c.poll(3_000),
        Err(Error::Topology(tmux_topology::Error::Unissued))
    ));
}

/// tmux gives the room of a closed pane to its neighbour. The layout says so
/// before the neighbour's cells arrive at the new size: the window as it was
/// stays up for that moment.
#[test]
fn the_window_stays_up_while_the_remaining_pane_is_resized() {
    let (mut c, _observed, _response, _peer) = in_place();
    c.session
        .push_control(topology(4, &["left"], &["right"], &[]));
    let mut wide = snapshot(4, &["left"], "left");
    wide["layouts"][0]["cols"] = json!(9);
    wide["layouts"][0]["panes"][0]["width"] = json!(9);
    c.session.push_control(wide);
    let update = c.poll(1).unwrap();
    assert_eq!(regions(&update), ["left", "right"], "the window blanked");
    assert!(updating(&update), "the held window reads as current");
    assert!(!c.actionable);
    // The pane's cells at a size the layout names.
    c.session.push_control(snapshot(5, &["left"], "left"));
    let update = c.poll(40).unwrap();
    assert_eq!(regions(&update), ["left"]);
    assert!(c.actionable);
    c.poll(60_000).unwrap();
}

/// A pane with no cells: the daemon took them back with a tombstone, as it
/// does when the pane's source ended or starts again.
fn without_cells(c: &Controller, pane: &str) -> Arc<CommittedPane> {
    let live = c.current.get(pane).cloned().unwrap();
    Arc::new(CommittedPane {
        snapshot: None,
        identity: Arc::clone(&live.identity),
    })
}

/// The daemon takes a closing pane's cells back a moment before the frame
/// that removes the pane (seen live: 7 to 70 ms). The window stays up in
/// between, without input.
#[test]
fn a_pane_that_lost_its_cells_stays_painted_until_its_frame() {
    let (mut c, _observed, _response, _peer) = in_place();
    c.session.push_commit("right", without_cells(&c, "right"));
    let update = c.poll(1_000).unwrap();
    assert_eq!(regions(&update), ["left", "right"], "the window blanked");
    assert!(updating(&update), "the held window reads as current");
    assert!(!c.actionable, "input went to a window with a closed pane");
    c.session
        .push_control(topology(4, &["left"], &["right"], &[]));
    c.session.push_control(snapshot(4, &["left"], "left"));
    let update = c.poll(1_030).unwrap();
    assert_eq!(regions(&update), ["left"]);
    assert!(c.actionable);
    c.poll(60_000).unwrap();
    // A stream without the capability drops the window as before.
    let (mut c, _observed, _response, _peer) = fixture();
    c.session.push_commit("right", without_cells(&c, "right"));
    assert!(regions(&c.poll(1_000).unwrap()).is_empty());
}

/// No frame and no new cells: the old window is not shown for ever. After
/// two seconds it goes, as on a stream without the capability, and the
/// stream stays (a seed may still come; the app's stall check has the rest).
#[test]
fn a_pane_without_cells_holds_the_window_for_two_seconds_at_most() {
    let (mut c, _observed, _response, _peer) = in_place();
    let cells = c.current.get("right").cloned().unwrap();
    c.session.push_commit("right", without_cells(&c, "right"));
    assert_eq!(regions(&c.poll(1_000).unwrap()), ["left", "right"]);
    assert_eq!(regions(&c.poll(2_999).unwrap()), ["left", "right"]);
    assert!(regions(&c.poll(3_000).unwrap()).is_empty());
    // The clock does not start again on an empty window.
    assert!(regions(&c.poll(3_500).unwrap()).is_empty());
    assert!(regions(&c.poll(9_000).unwrap()).is_empty());
    // The seed, late.
    c.session.push_commit("right", cells);
    let update = c.poll(9_010).unwrap();
    assert_eq!(regions(&update), ["left", "right"]);
    assert!(!updating(&update));
    assert!(c.actionable);
    // The next loss gets its own two seconds.
    c.session.push_commit("right", without_cells(&c, "right"));
    assert_eq!(regions(&c.poll(20_000).unwrap()), ["left", "right"]);
    assert_eq!(regions(&c.poll(21_999).unwrap()), ["left", "right"]);
    assert!(regions(&c.poll(22_000).unwrap()).is_empty());
}

/// Seen live: the selected pane lost its cells, then a frame added a pane,
/// and no seed came for the selected pane. Two seconds after the frame the
/// stream ends as a pane-set change, although the window was already down.
#[test]
fn a_frame_whose_window_never_comes_ends_the_stream_from_an_empty_window_too() {
    let (mut c, _observed, _response, _peer) = fixture();
    c.in_place.enabled = true;
    c.session.push_commit("left", without_cells(&c, "left"));
    c.poll(1_000).unwrap();
    c.poll(3_100).unwrap();
    assert!(regions(&c.poll(3_200).unwrap()).is_empty());
    c.session
        .push_control(topology(4, &["left", "right", "third"], &[], &["third"]));
    c.session
        .push_control(snapshot(4, &["left", "right", "third"], "left"));
    c.poll(4_000).unwrap();
    c.poll(5_999).unwrap();
    assert!(matches!(
        c.poll(6_000),
        Err(Error::Topology(tmux_topology::Error::Unissued))
    ));
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
