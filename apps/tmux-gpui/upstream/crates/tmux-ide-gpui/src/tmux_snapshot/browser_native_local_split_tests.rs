#![allow(clippy::unwrap_used)]
use super::*;
use std::time::{Duration, Instant};

fn route() -> Route {
    Route {
        id: uuid::Uuid::new_v4().to_string(),
        request: 1,
        target: Target {
            scope: ServerScope {
                server_id: format!("tmux-server.{}", "a".repeat(32)),
                generation: uuid::Uuid::new_v4().to_string(),
            },
            live: format!("live-session.{}", "a".repeat(20)),
        },
        workspace: "test".into(),
    }
}
fn request(reader: &mut Reader, route: &Route, sequence: u64) -> Option<SplitResponse> {
    reader
        .request(
            Some(route),
            route.id.clone(),
            route.request,
            sequence,
            WindowLink {
                live_session_id: route.target.live.clone(),
                link_id: format!("window-link.{}", "a".repeat(32)),
                expected_semantic_window_id: "window".into(),
                link_revision: 1,
            },
        )
        .unwrap()
}
fn reader() -> Reader {
    // A private missing record produces a completed failed read without any daemon access.
    Reader::new(
        std::env::temp_dir()
            .join(uuid::Uuid::new_v4().to_string())
            .join("daemon.json"),
    )
    .unwrap()
}
#[test]
fn overlapping_geometry_reads_complete_newest_sequence_instead_of_rejecting_it() {
    let mut reader = reader();
    let route = route();
    assert!(request(&mut reader, &route, 1).is_none());
    assert!(request(&mut reader, &route, 2).is_none());
    assert!(request(&mut reader, &route, 3).is_none());
    assert!(request(&mut reader, &route, 2).is_none());
    assert!(request(&mut reader, &route, 3).is_none());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut completed = Vec::new();
    while reader.busy() {
        if let Some(reply) = reader.poll(Some(&route)).unwrap() {
            completed.push(reply.sequence);
        }
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert_eq!(completed, vec![1, 3]);
    assert!(reader.queued.is_none());
    assert!(reader.poll(Some(&route)).unwrap().is_none());
}
#[test]
fn route_change_and_cancel_do_not_dispatch_queued_read() {
    for cancel in [false, true] {
        let mut reader = reader();
        let route = route();
        assert!(request(&mut reader, &route, 1).is_none());
        assert!(request(&mut reader, &route, 2).is_none());
        if cancel {
            reader.cancel();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while reader.busy() {
            assert!(reader.poll(None).unwrap().is_none());
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(reader.queued.is_none());
    }
}
