#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn bounded_roster_preserves_opaque_identity_and_rejects_unsafe_display() {
    let mut v = serde_json::json!({"revision":1,"phase":"partial","rows":[{"key":"session\u{0}agent","sessionId":"session","paneId":"pane","name":"same","sessionLabel":"same","status":"WORKING","attention":false,"available":true}],"observedSessions":1,"totalSessions":2,"truncatedSessions":0,"truncatedRows":0,"note":null});
    let r: Roster = serde_json::from_value(v.clone()).unwrap();
    assert!(r.valid());
    assert!(r.available("session\u{0}agent"));
    v["rows"][0]["name"] = "bad\nname".into();
    assert!(!serde_json::from_value::<Roster>(v.clone()).unwrap().valid());
    v["rows"][0]["name"] = "valid".into();
    v["revision"] = 0.into();
    assert!(!serde_json::from_value::<Roster>(v).unwrap().valid());
}
#[test]
fn optional_publication_and_navigation_wire_are_exact() -> anyhow::Result<()> {
    use super::super::{Command, Reader};
    let mut wire = serde_json::json!({"version":1,"connection":"a","sequence":1,"request":0,"surface":"home","home":{"phase":"live"},"inputReady":false,"sessions":[],"panes":[],"selectedSession":null,"selectedPane":null,"status":"Ready","snapshot":null});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&wire)?)?
            .home_agents
            .is_none()
    );
    wire["homeAgents"] = serde_json::json!({"revision":1,"phase":"live","rows":[],"observedSessions":0,"totalSessions":0,"truncatedSessions":0,"truncatedRows":0,"note":null});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&wire)?)?
            .home_agents
            .is_some()
    );
    wire["homeAgents"]["revision"] = 9_007_199_254_740_992_u64.into();
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&wire)?)
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(Command::OpenAgent {
            request: 1,
            from_request: 0,
            roster_revision: 2,
            key: "s\0a".into()
        })?,
        serde_json::json!({"type":"open-agent","request":1,"fromRequest":0,"rosterRevision":2,"key":"s\0a"})
    );
    Ok(())
}

#[test]
fn duplicate_keys_row_bound_and_unavailable_phase_never_admit_actions() {
    let row = serde_json::json!({"key":"key","sessionId":"s","paneId":"p","name":"n","sessionLabel":"s","status":"IDLE","attention":false,"available":true});
    let mut wire = serde_json::json!({"revision":1,"phase":"live","rows":[row.clone(),row.clone()],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null});
    assert!(
        !serde_json::from_value::<Roster>(wire.clone())
            .unwrap()
            .valid()
    );
    wire["rows"] = serde_json::Value::Array(
        (0..257)
            .map(|i| {
                let mut r = row.clone();
                r["key"] = i.to_string().into();
                r
            })
            .collect(),
    );
    assert!(
        !serde_json::from_value::<Roster>(wire.clone())
            .unwrap()
            .valid()
    );
    wire["rows"] = serde_json::json!([row]);
    wire["phase"] = "unavailable".into();
    let roster: Roster = serde_json::from_value(wire).unwrap();
    assert!(roster.valid());
    assert!(!roster.available("key"));
}
