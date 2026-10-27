use super::*;

fn stat(files: u64) -> DiffStat {
    DiffStat {
        files,
        ..DiffStat::default()
    }
}

#[test]
fn an_unreadable_host_fails_only_its_own_lanes() {
    let mut fan_out = launched();
    fan_out.stage = Stage::Compare;
    send(
        &fan_out,
        Event::Stats(vec![HostStats {
            lanes: vec![0, 1, 2],
            result: Ok(vec![Some(stat(1)), Some(stat(2)), Some(stat(3))]),
        }]),
    );
    fan_out.poll();
    send(
        &fan_out,
        Event::Stats(vec![
            HostStats {
                lanes: vec![0],
                result: Ok(vec![Some(stat(5))]),
            },
            HostStats {
                lanes: vec![1, 2],
                result: Err(Error::Script {
                    step: Step::Compare,
                    source: herdr_client::Error::ScriptTimeout,
                }),
            },
        ]),
    );
    fan_out.poll();
    assert_eq!(
        fan_out.lanes[0].stats,
        Some(stat(5)),
        "a reachable host updates"
    );
    assert_eq!(fan_out.lanes[0].unread, None);
    for lane in &fan_out.lanes[1..] {
        assert!(
            lane.unread
                .as_deref()
                .is_some_and(|error| error.starts_with("reading the changes failed")),
            "{:?}",
            lane.unread
        );
    }
    assert_eq!(
        fan_out.lanes[1].stats,
        Some(stat(2)),
        "earlier changes stay"
    );
    // The host answering again clears the failure.
    send(
        &fan_out,
        Event::Stats(vec![HostStats {
            lanes: vec![1, 2],
            result: Ok(vec![Some(stat(7)), None]),
        }]),
    );
    fan_out.poll();
    assert_eq!(fan_out.lanes[1].unread, None);
    assert_eq!(fan_out.lanes[1].stats, Some(stat(7)));
    assert_eq!(fan_out.lanes[2].stats, None, "a checkout that is gone");
}

#[test]
fn a_cancelled_read_changes_nothing() {
    let mut fan_out = launched();
    send(
        &fan_out,
        Event::Stats(vec![HostStats {
            lanes: vec![0],
            result: Err(Error::Cancelled),
        }]),
    );
    fan_out.poll();
    assert_eq!(fan_out.lanes[0].unread, None);
}
