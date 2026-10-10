use super::*;
use serde_json::json;

fn home() -> serde_json::Value {
    json!({"version":1,"connection":"a","sequence":1,"request":0,
        "surface":"home","home":{"phase":"live"},"inputReady":false,
        "sessions":[{"id":"s","label":"Session"}],"panes":[],
        "selectedSession":null,"selectedPane":null,"status":"Choose a session","snapshot":null})
}

#[test]
fn home_phases_and_command_are_explicit() -> anyhow::Result<()> {
    for (wire, expected) in [
        ("loading", HomePhase::Loading),
        ("live", HomePhase::Live),
        ("unavailable", HomePhase::Unavailable),
    ] {
        let mut value = home();
        value["home"]["phase"] = json!(wire);
        let state = Reader::default().accept(&serde_json::to_vec(&value)?)?;
        assert_eq!(state.surface, Surface::Home);
        assert_eq!(state.home_phase, expected);
        assert!(!state.input_ready);
    }
    assert_eq!(
        serde_json::to_value(Command::Home { request: 4 })?,
        json!({"type":"home","request":4})
    );
    Ok(())
}

#[test]
fn legacy_publications_infer_surface_without_inventing_authority() -> anyhow::Result<()> {
    let mut value = home();
    value
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("expected publication object"))?
        .remove("surface");
    value
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("expected publication object"))?
        .remove("home");
    let state = Reader::default().accept(&serde_json::to_vec(&value)?)?;
    assert_eq!(state.surface, Surface::Home);
    assert_eq!(state.home_phase, HomePhase::Live);
    value["selectedSession"] = json!("s");
    let state = Reader::default().accept(&serde_json::to_vec(&value)?)?;
    assert_eq!(state.surface, Surface::Workspace);
    assert!(!state.input_ready);
    Ok(())
}

#[test]
fn home_rejects_terminal_state_and_unknown_wire_without_advancing_reader() -> anyhow::Result<()> {
    for (field, bad) in [
        ("inputReady", json!(true)),
        ("selectedSession", json!("s")),
        ("selectedPane", json!("p")),
        ("panes", json!([{"id":"p","label":"Pane"}])),
        ("snapshot", json!({})),
        ("copyRegion", json!({})),
        ("regions", json!([{}])),
        ("surface", json!("dashboard")),
        ("home", json!({"phase":"connected"})),
        ("home", json!({"phase":"live","trusted":true})),
    ] {
        let mut reader = Reader::default();
        let mut value = home();
        value[field] = bad;
        assert!(
            reader.accept(&serde_json::to_vec(&value)?).is_err(),
            "{field}"
        );
        reader.accept(&serde_json::to_vec(&home())?)?;
    }
    Ok(())
}

#[test]
fn resize_token_is_optional_bounded_and_never_grants_home_authority() -> anyhow::Result<()> {
    let mut value = home();
    value["resizeToken"] = json!("312b2c16-a13d-4411-82e5-1fdb58adab92");
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    value["surface"] = json!("workspace");
    value["selectedSession"] = json!("s");
    let state = Reader::default().accept(&serde_json::to_vec(&value)?)?;
    assert_eq!(
        state.resize_token.as_deref(),
        Some("312b2c16-a13d-4411-82e5-1fdb58adab92")
    );
    value["resizeToken"] = json!("not-a-token");
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(Command::ResizePane {
            request: 7,
            id: "pane".into(),
            token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
            axis: super::super::divider::Axis::Rows,
            cells: 17
        })?,
        json!({"type":"resize-pane","request":7,"id":"pane","token":"312b2c16-a13d-4411-82e5-1fdb58adab92","axis":"rows","cells":17})
    );
    Ok(())
}

#[test]
fn create_capability_is_optional_but_present_revision_is_required() -> anyhow::Result<()> {
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&home())?)?
            .create_session
            .is_none()
    );
    let mut value = home();
    value["createSession"] = json!({"phase":"idle","error":null,"revision":0});
    assert_eq!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)?
            .create_session
            .map(|state| state.revision),
        Some(0)
    );
    for bad in [
        json!({"phase":"idle","error":null}),
        json!({"phase":"idle","error":null,"revision":9007199254740992_u64}),
        json!({"phase":"unknown","error":null,"revision":0}),
    ] {
        value["createSession"] = bad;
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&value)?)
                .is_err()
        );
    }
    Ok(())
}

#[test]
fn session_pane_counts_are_optional_bounded_and_not_navigation_identity() -> anyhow::Result<()> {
    let mut value = home();
    let missing = Reader::default().accept(&serde_json::to_vec(&value)?)?;
    assert!(missing.sessions[0].pane_count_label().is_none());
    for (count, label) in [(0, "0 panes"), (1, "1 pane"), (12, "12 panes")] {
        value["sessions"][0]["paneCount"] = json!(count);
        let state = Reader::default().accept(&serde_json::to_vec(&value)?)?;
        assert_eq!(state.sessions[0].pane_count_label().as_deref(), Some(label));
        assert_eq!(state.sessions[0].id, missing.sessions[0].id);
    }
    for invalid in [
        json!(-1),
        json!(1.5),
        json!("3"),
        json!(9007199254740992_u64),
    ] {
        value["sessions"][0]["paneCount"] = invalid;
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&value)?)
                .is_err()
        );
    }
    Ok(())
}
