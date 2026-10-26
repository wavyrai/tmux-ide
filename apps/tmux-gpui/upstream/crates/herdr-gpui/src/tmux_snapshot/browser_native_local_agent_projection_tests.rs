#![allow(clippy::unwrap_used)]
use super::*;
fn row(key: String) -> home_agents::Row {
    home_agents::Row {
        key,
        session_id: "session".into(),
        pane_id: None,
        name: "Agent".into(),
        session_label: "Session".into(),
        machine_label: None,
        server_label: None,
        project_name: None,
        harness: None,
        team_name: None,
        status: home_agents::Status::Idle,
        attention: false,
        available: false,
    }
}
#[test]
fn bounded_projection_matches_full_sort_for_mixed_priorities_and_input_orders() {
    for reverse in [false, true] {
        let mut values: Vec<_> = (0..1000)
            .map(|i| ((i % 3) as u8, format!("key-{i:04}")))
            .collect();
        if reverse {
            values.reverse();
        }
        let mut expected = values.clone();
        expected.sort();
        expected.truncate(ROW_LIMIT);
        let mut rows = BoundedRows::default();
        for (rank, key) in values {
            rows.push(rank, key, row);
            assert!(rows.heap.len() <= ROW_LIMIT);
        }
        let (actual, omitted) = rows.finish();
        assert_eq!(omitted, 1000 - ROW_LIMIT);
        assert_eq!(
            actual.iter().map(|r| r.key.clone()).collect::<Vec<_>>(),
            expected.into_iter().map(|(_, key)| key).collect::<Vec<_>>()
        );
    }
}
#[test]
fn worse_candidates_do_not_construct_display_metadata() {
    let builds = std::cell::Cell::new(0);
    let mut rows = BoundedRows::default();
    for i in 0..32768 {
        rows.push(0, format!("key-{i:05}"), |key| {
            builds.set(builds.get() + 1);
            row(key)
        });
    }
    assert_eq!(builds.get(), ROW_LIMIT);
    assert_eq!(rows.heap.len(), ROW_LIMIT);
    assert_eq!(rows.finish().1, 32768 - ROW_LIMIT);
}
