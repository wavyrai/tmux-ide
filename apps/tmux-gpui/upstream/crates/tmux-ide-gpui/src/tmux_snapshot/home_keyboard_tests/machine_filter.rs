use super::*;

#[test]
fn machine_filter_wire_is_explicit_null_for_all() {
    assert_eq!(
        serde_json::to_value(browser::Command::HomeAgentFilter {
            request: 7,
            roster_revision: 9,
            machine_id: None
        })
        .unwrap(),
        serde_json::json!({"type":"home-agent-filter","request":7,"rosterRevision":9,"machineId":null})
    );
}
