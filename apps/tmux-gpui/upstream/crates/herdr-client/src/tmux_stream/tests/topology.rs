//! Capability 119, "topology in place" (#723): another tmux client split or
//! closed a pane, and the stream stays open. The reader follows the pane set
//! with each `topology` frame and still refuses every frame for a pane the
//! stream does not carry.
use serde_json::{Value, json};

use super::super::wire::{self, Live};
use super::super::*;
use super::transport::options;

fn two_panes() -> ConnectOptions {
    let mut options = options(12345);
    options.descriptor.panes = vec!["pane.a".into(), "pane.b".into()];
    options
}
fn ready(in_place: Option<bool>) -> String {
    let mut frame = json!({"type":"ready","protocolVersion":2,
        "requestId":"b987f903-e864-43dd-8591-8d0a464ca6e8",
        "daemonInstanceId":"e01ce8ee-74d8-40d0-9a59-a096050a6ade",
        "connectionClientId":"native.test","panes":["pane.a","pane.b"],
        "effectiveViewerMode":"interactive","inputLifetime":true});
    if let Some(in_place) = in_place {
        frame["topologyInPlace"] = in_place.into();
    }
    frame.to_string()
}
/// A reader past the ready frame of a stream that said `in_place`.
fn opened(in_place: Option<bool>) -> (ConnectOptions, Live) {
    let options = two_panes();
    let mut live = Live::new(&options);
    assert!(matches!(
        wire::parse_live(&ready(in_place), &options, &mut live, false).unwrap(),
        Event::Ready(_)
    ));
    (options, live)
}
fn topology(epoch: u64, panes: &[&str], removed: &[&str], added: &[&str]) -> Value {
    json!({"type":"topology","topologyEpoch":epoch,"panes":panes,"removed":removed,"added":added})
}
fn delivery_ready(pane: &str) -> String {
    json!({"type":"terminal-delivery-ready","pane":pane,"negotiation":{"accepted":true}})
        .to_string()
}
fn binary_chunk(pane: &str) -> Vec<u8> {
    let header =
        json!({"pane":pane,"transactionId":"cc840bc1-d8af-4764-a586-c95befc44701","index":0})
            .to_string();
    let mut bytes = b"TDC1".to_vec();
    bytes.extend(u32::try_from(header.len()).unwrap().to_be_bytes());
    bytes.extend(header.as_bytes());
    bytes.push(1);
    bytes
}

#[test]
fn the_ready_frame_may_say_that_the_stream_follows_pane_changes() {
    for in_place in [None, Some(true)] {
        let Event::Ready(ready) = wire::parse(&ready(in_place), &two_panes(), false).unwrap()
        else {
            panic!("not a ready frame");
        };
        assert_eq!(ready.topology_in_place, in_place);
    }
    // Like the other capability flags, an explicit "no" is not a daemon this
    // client knows.
    assert!(matches!(
        wire::parse(&ready(Some(false)), &two_panes(), false),
        Err(Error::Identity)
    ));
}

#[test]
fn a_topology_frame_moves_the_set_that_later_frames_are_checked_against() {
    let (options, mut live) = opened(Some(true));
    // pane.b closed, pane.c was split in.
    let frame = topology(7, &["pane.a", "pane.c"], &["pane.b"], &["pane.c"]);
    let Event::Topology { change, raw } =
        wire::parse_live(&frame.to_string(), &options, &mut live, true).unwrap()
    else {
        panic!("not a topology event");
    };
    assert_eq!(change.topology_epoch, 7);
    assert_eq!(change.panes, ["pane.a", "pane.c"]);
    assert_eq!(change.removed, ["pane.b"]);
    assert_eq!(change.added, ["pane.c"]);
    assert_eq!(serde_json::from_str::<Value>(raw.get()).unwrap(), frame);
    // The added pane's delivery is accepted, text and binary.
    assert!(wire::parse_live(&delivery_ready("pane.c"), &options, &mut live, true).is_ok());
    assert!(wire::parse_binary_live(&binary_chunk("pane.c"), &live).is_ok());
    assert!(wire::parse_live(&delivery_ready("pane.a"), &options, &mut live, true).is_ok());
    // The removed pane's is refused, as a pane never issued always was.
    for frame in [delivery_ready("pane.b"), delivery_ready("pane.z")] {
        assert!(matches!(
            wire::parse_live(&frame, &options, &mut live, true),
            Err(Error::Identity)
        ));
    }
    assert!(wire::parse_binary_live(&binary_chunk("pane.b"), &live).is_err());
    // A later frame builds on the new set.
    let next = topology(8, &["pane.c"], &["pane.a"], &[]);
    assert!(wire::parse_live(&next.to_string(), &options, &mut live, true).is_ok());
    assert!(wire::parse_live(&delivery_ready("pane.a"), &options, &mut live, true).is_err());
}

/// A daemon that did not say `topologyInPlace` must not send the frame, and a
/// stream without it keeps exactly the issued panes.
#[test]
fn a_stream_that_did_not_agree_to_it_refuses_the_frame() {
    let (options, mut live) = opened(None);
    let frame = topology(1, &["pane.a", "pane.c"], &["pane.b"], &["pane.c"]);
    assert!(matches!(
        wire::parse_live(&frame.to_string(), &options, &mut live, true),
        Err(Error::Identity)
    ));
    assert!(wire::parse_live(&delivery_ready("pane.b"), &options, &mut live, true).is_ok());
    assert!(wire::parse_live(&delivery_ready("pane.c"), &options, &mut live, true).is_err());
}

/// Step 1 of the contract: the frame must agree with the set this side
/// holds. Anything else ends the stream, and the caller leases a new one.
#[test]
fn a_frame_that_disagrees_with_this_sides_set_ends_the_stream() {
    // Two panes are held: 23 more make 25, one over the bound.
    let many: Vec<String> = (0..23).map(|n| format!("pane.n{n}")).collect();
    let many_refs: Vec<&str> = many.iter().map(String::as_str).collect();
    let mut over = many_refs.clone();
    over.push("pane.a");
    over.push("pane.b");
    let cases: Vec<(&str, Value)> = vec![
        (
            "removes a pane we do not have",
            topology(1, &["pane.a", "pane.b"], &["pane.z"], &[]),
        ),
        (
            "adds a pane we already have",
            topology(1, &["pane.a", "pane.b"], &[], &["pane.b"]),
        ),
        (
            "panes lacks one we keep",
            topology(1, &["pane.a"], &[], &[]),
        ),
        (
            "panes names one nobody added",
            topology(1, &["pane.a", "pane.b", "pane.c"], &[], &[]),
        ),
        (
            "panes still names the removed one",
            topology(1, &["pane.a", "pane.b"], &["pane.b"], &[]),
        ),
        (
            "panes lacks the added one",
            topology(1, &["pane.a", "pane.b"], &[], &["pane.c"]),
        ),
        ("no pane left", topology(1, &[], &["pane.a", "pane.b"], &[])),
        ("25 panes", topology(1, &over, &[], &many_refs)),
        (
            "a pane named twice",
            topology(
                1,
                &["pane.a", "pane.b", "pane.c", "pane.c"],
                &[],
                &["pane.c"],
            ),
        ),
        (
            "an added pane named twice",
            topology(
                1,
                &["pane.a", "pane.b", "pane.c"],
                &[],
                &["pane.c", "pane.c"],
            ),
        ),
        (
            "a pane added twice and named twice",
            topology(
                1,
                &["pane.a", "pane.b", "pane.c", "pane.c"],
                &[],
                &["pane.c", "pane.c"],
            ),
        ),
        (
            "a pane removed twice",
            topology(1, &["pane.a"], &["pane.b", "pane.b"], &[]),
        ),
        (
            "an invalid pane id",
            topology(1, &["pane.a", "pane.b", "../x"], &[], &["../x"]),
        ),
    ];
    for (why, frame) in cases {
        let (options, mut live) = opened(Some(true));
        assert!(
            matches!(
                wire::parse_live(&frame.to_string(), &options, &mut live, true),
                Err(Error::Identity)
            ),
            "{why}"
        );
        // Nothing of a refused frame is taken.
        assert!(wire::parse_live(&delivery_ready("pane.b"), &options, &mut live, true).is_ok());
        assert!(wire::parse_live(&delivery_ready("pane.c"), &options, &mut live, true).is_err());
    }
    // 24 panes are the most a stream carries, and they are taken.
    let (options, mut live) = opened(Some(true));
    assert_eq!(over.len(), 25);
    let full = topology(1, &over[1..], &[], &many_refs[1..]);
    assert!(wire::parse_live(&full.to_string(), &options, &mut live, true).is_ok());
    assert!(wire::parse_live(&delivery_ready("pane.n22"), &options, &mut live, true).is_ok());
    // An unknown field or a missing one is not this frame.
    let (options, mut live) = opened(Some(true));
    let mut extra = topology(1, &["pane.a"], &["pane.b"], &[]);
    extra["more"] = true.into();
    assert!(matches!(
        wire::parse_live(&extra.to_string(), &options, &mut live, true),
        Err(Error::Json(_))
    ));
    let missing =
        json!({"type":"topology","topologyEpoch":1,"panes":["pane.a"],"removed":["pane.b"]});
    assert!(wire::parse_live(&missing.to_string(), &options, &mut live, true).is_err());
}

#[test]
fn the_epoch_of_each_frame_is_greater_than_the_last() {
    let (options, mut live) = opened(Some(true));
    let first = topology(5, &["pane.a"], &["pane.b"], &[]);
    assert!(wire::parse_live(&first.to_string(), &options, &mut live, true).is_ok());
    for epoch in [5, 4, 0] {
        let again = topology(epoch, &["pane.a", "pane.c"], &[], &["pane.c"]);
        assert!(
            matches!(
                wire::parse_live(&again.to_string(), &options, &mut live, true),
                Err(Error::Identity)
            ),
            "epoch {epoch}"
        );
    }
    let next = topology(6, &["pane.a", "pane.c"], &[], &["pane.c"]);
    assert!(wire::parse_live(&next.to_string(), &options, &mut live, true).is_ok());
}
