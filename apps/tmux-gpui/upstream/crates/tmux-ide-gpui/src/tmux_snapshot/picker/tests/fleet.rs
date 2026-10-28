use super::*;

#[test]
fn fleet_search_uses_tokens_and_rejects_retired_rows() -> Result<()> {
    let value: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../../../fixtures/browser-fleet.json"
    ))?;
    let mut state = browser::State {
        fleet: Some(serde_json::from_value(value["fleet"].clone())?),
        ..Default::default()
    };
    let rows = rows(&state, "Local Workspace");
    assert_eq!(rows.len(), 1);
    assert!(matches!(rows[0].target, Target::FleetSession { .. }));
    assert!(current(&state, &rows[0].target));
    state.fleet.as_mut().unwrap().groups[0].sessions[0].selection = None;
    assert!(!current(&state, &rows[0].target));
    assert!(super::super::rows(&state, "Workspace").is_empty());
    Ok(())
}

#[gpui::test]
fn fleet_picker_keeps_search_focus_across_home_catalog_publications(cx: &mut TestAppContext) {
    let wire = include_str!("../../../../../../../fixtures/browser-fleet-startup.jsonl");
    let publication: serde_json::Value =
        serde_json::from_str(wire.lines().last().unwrap()).unwrap();
    let state = browser::State {
        request: 7,
        fleet: Some(serde_json::from_value(publication["fleet"].clone()).unwrap()),
        home_agents: Some(serde_json::from_value(publication["homeAgents"].clone()).unwrap()),
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Live,
        ..Default::default()
    };
    let expected = state.fleet.as_ref().unwrap().groups[0].sessions[1]
        .selection
        .clone()
        .unwrap();
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state = state.clone();
        view.frame = None;
        view
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f6");
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_some(), "F6 must open picker before typing")
    });
    cx.simulate_input("Two");
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_some(), "typing must keep picker open")
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.apply_browser_state(Some(state.clone()), cx);
        });
        window.draw(cx).clear(cx);
        view.read_with(cx, |view, cx| {
            let picker = view.picker.as_ref().unwrap();
            assert!(picker.search.read(cx).focus.is_focused(window));
            assert_eq!(picker.search.read(cx).text(), "Two");
            assert_eq!(picker.rows.len(), 1);
        });
    });
    assert!(
        receiver.try_recv().is_err(),
        "search input must not reach the terminal"
    );
    cx.simulate_keystrokes("enter");
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({
            "type": "fleet-session", "request": 8, "selection": expected
        })
    );
}
