use super::*;

fn fleet() -> browser::fleet::Fleet {
    serde_json::from_value(serde_json::json!({
        "groups": [{"id":"local", "label":"This Mac", "state":"ready", "conflict":false,
            "sessions":[], "omittedSessions":0, "servers":[{"id":"server-local", "label":"Default",
            "state":"online", "generation":"generation-a", "selection":"opaque-local-server"}]}],
        "omittedGroups":0
    }))
    .unwrap()
}

#[gpui::test]
fn local_creation_waits_for_exact_server_ack_and_never_uses_remote(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(fleet());
        view.browser_state.selected_server = Some(browser::fleet::SelectedServer {
            machine_id: "remote".into(),
            machine_label: "Remote".into(),
            server_id: "server-remote".into(),
            generation: "remote-generation".into(),
            label: "Default".into(),
        });
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_local_session(0, window, cx);
            let dialog = view.new_session.as_ref().unwrap();
            dialog
                .input
                .update(cx, |input, cx| input.set_text_selected("local-project", cx));
            view.submit_new_session(window, cx);
        })
    });
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::FleetServer { request:1, selection } if selection == "opaque-local-server")
    );
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.request = 1;
            view.browser_state.home_phase = browser::HomePhase::Live;
            view.browser_state.create_session = Some(browser::CreateSession {
                phase: browser::CreatePhase::Idle,
                revision: 1,
                error: None,
            });
            view.browser_state.selected_server = Some(browser::fleet::SelectedServer {
                machine_id: "local".into(),
                machine_label: "This Mac".into(),
                server_id: "server-local".into(),
                generation: "replacement-generation".into(),
                label: "Default".into(),
            });
            view.submit_new_session(window, cx);
            assert!(view.new_session.is_some());
            view.browser_state
                .selected_server
                .as_mut()
                .unwrap()
                .generation = "generation-a".into();
            view.submit_new_session(window, cx);
        })
    });
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::CreateSession { request:1, name } if name == "local-project")
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn local_creation_refuses_unavailable_and_stale_authority(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(fleet());
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_local_session(99, window, cx);
            assert!(view.new_session.is_none());
            view.browser_state.fleet.as_mut().unwrap().groups[0].conflict = true;
            view.open_local_session(0, window, cx);
            assert!(view.new_session.is_none());
            assert!(!view.local_session_available());
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn first_local_session_uses_exact_capability_once_and_revokes_dialog(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.local_session_create = Some(browser::local_session::Capability {
            action: "11111111-1111-4111-8111-111111111111".into(),
        });
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert!(view.local_session_available());
            view.open_local_session(99, window, cx);
            assert!(view.new_session.is_none());
            view.open_local_session(0, window, cx);
            assert!(view.new_session.is_some());
            view.browser_state.local_session_create = None;
            view.submit_new_session(window, cx);
            assert!(view.new_session.is_none());
            view.browser_state.local_session_create = Some(browser::local_session::Capability {
                action: "22222222-2222-4222-8222-222222222222".into(),
            });
            view.open_new_session(0, window, cx);
            view.new_session
                .as_ref()
                .unwrap()
                .input
                .update(cx, |input, cx| input.set_text_selected("first-local", cx));
            view.submit_new_session(window, cx);
            view.open_local_session(0, window, cx);
            assert!(view.new_session.is_none());
        })
    });
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::CreateLocalSession{request:0,action,name} if action=="22222222-2222-4222-8222-222222222222" && name=="first-local")
    );
    assert!(receiver.try_recv().is_err());
}
