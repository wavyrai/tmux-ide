use super::*;
use crate::tmux_snapshot::home::machine_filter::Capability;
fn prepare(view: &mut SnapshotView, cx: &mut Context<SnapshotView>) {
    view.browser_state.request = 7;
    view.browser_state.surface = browser::Surface::Home;
    view.browser_state.fleet=Some(serde_json::from_value(serde_json::json!({"groups":[
        {"id":"local","label":"Same label","state":"ready","conflict":false,"omittedSessions":0,"sessions":[]},
        {"id":"remote","label":"Same label","state":"ready","conflict":false,"omittedSessions":0,"sessions":[]}
    ],"omittedGroups":0})).unwrap());
    view.browser_state.home_agents=Some(serde_json::from_value(serde_json::json!({"revision":9,"phase":"live","rows":[],"observedSessions":0,"totalSessions":0,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap());
    view.browser_state.home_agent_filter = Some(Capability {
        revision: 9,
        machine_id: None,
    });
    view.prepare_home_filter(cx);
}
#[gpui::test]
fn exact_machine_cycle_waits_for_ack_and_preserves_query(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut v = make_view(window, cx, sender);
        prepare(&mut v, cx);
        v
    });
    receiver.try_iter().for_each(drop);
    view.update(cx, |v, cx| {
        v.home_filter
            .as_ref()
            .unwrap()
            .search
            .update(cx, |s, cx| s.set_text_selected("retained query", cx));
        v.cycle_home_machine(7, 8, cx);
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("f");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::HomeAgentFilter{request:7,roster_revision:9,machine_id:Some(id)} if id=="local")
    );
    cx.simulate_keystrokes("f");
    assert!(receiver.try_recv().is_err());
    view.update(cx, |v, cx| {
        assert!(
            v.browser_state
                .home_agent_filter
                .as_ref()
                .unwrap()
                .machine_id
                .is_none()
        );
        assert_eq!(
            v.home_filter.as_ref().unwrap().search.read(cx).text(),
            "retained query"
        );
        v.browser_state.home_agents.as_mut().unwrap().revision = 10;
        v.browser_state.home_agent_filter = Some(Capability {
            revision: 10,
            machine_id: Some("local".into()),
        });
        v.cycle_home_machine(7, 10, cx);
    });
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::HomeAgentFilter{machine_id:Some(id),..} if id=="remote")
    );
    view.update(cx, |v, cx| {
        v.browser_state.home_agents.as_mut().unwrap().revision = 11;
        v.browser_state.home_agent_filter = Some(Capability {
            revision: 11,
            machine_id: Some("remote".into()),
        });
        v.browser_state.fleet.as_mut().unwrap().groups.pop();
        v.cycle_home_machine(7, 11, cx);
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("/");
    cx.simulate_input("f");
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn full_machine_filter_queue_is_not_an_ack(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut v = make_view(window, cx, sender);
        prepare(&mut v, cx);
        v
    });
    view.update(cx, |v, cx| {
        v.cycle_home_machine(7, 9, cx);
        assert!(v.home_filter.as_ref().unwrap().machine_error);
        assert!(v.home_filter.as_ref().unwrap().machine_queued.is_none());
    });
    receiver.try_iter().for_each(drop);
    view.update(cx, |v, cx| v.cycle_home_machine(7, 9, cx));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::HomeAgentFilter { .. }
    ));
}
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

#[gpui::test]
fn machine_filter_preserves_composition_and_refuses_background_modal(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut v = make_view(window, cx, sender);
        prepare(&mut v, cx);
        v
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let search = v.home_filter.as_ref().unwrap().search.clone();
            search.read(cx).focus.clone().focus(window, cx);
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", Some(1..1), window, cx)
            });
            assert!(!v.home_filter_key(
                &crate::tmux_snapshot::fit_test_support::key_down("f"),
                window,
                cx
            ));
            assert!(search.read(cx).is_composing());
            v.presence.set_active(false);
            v.cycle_home_machine(7, 9, cx);
            v.presence.set_active(true);
            v.cycle_home_machine(7, 9, cx);
            assert!(receiver.try_recv().is_err());
            v.presence.flush(v.browser_commands.as_ref().unwrap());
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Presence {
                    active: false,
                    revision: 2
                }
            ));
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Presence {
                    active: true,
                    revision: 3
                }
            ));
            v.presence.acknowledge(3);
            assert!(v.presence.ready());
            v.open_picker(window, cx);
            assert!(v.picker.is_some());
            v.cycle_home_machine(7, 9, cx);
            assert!(v.home_filter.as_ref().unwrap().machine_queued.is_none());
        });
    });
    assert!(receiver.try_recv().is_err());
}
