use super::*;

fn catalog(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let mut view = make_view(window, cx, sender);
    let fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../../../fixtures/browser-fleet.json"
    ))
    .unwrap();
    view.browser_state.fleet = Some(serde_json::from_value(fixture["fleet"].clone()).unwrap());
    view.frame = None;
    view.painted_frame = None;
    view.input_geometry = None;
    view.input_cell_width = None;
    view.browser_state.frame = None;
    view.browser_state.input_ready = false;
    view.browser_state.selected_session = None;
    view.browser_state.selected_pane = None;
    view.browser_state.panes.clear();
    view.browser_state.regions.clear();
    view
}
fn token(view: &SnapshotView) -> String {
    view.browser_state.fleet.as_ref().unwrap().groups[0].sessions[0]
        .selection
        .clone()
        .unwrap()
}
fn unchanged(view: &SnapshotView, receiver: &mpsc::Receiver<browser::Command>) {
    assert!(
        receiver.try_recv().is_err(),
        "refused click must not queue navigation or input"
    );
    assert_eq!(view.browser_request, 7);
    assert!(view.pending_session_open.is_none());
    assert_eq!(view.browser_state.surface, browser::Surface::Home);
    assert!(view.browser_state.selected_session.is_none());
    assert!(view.frame.is_none());
    assert!(!view.browser_state.input_ready);
}
fn opened(view: &SnapshotView, receiver: &mpsc::Receiver<browser::Command>, expected: &str) {
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::FleetSession { request: 8, selection } if selection == expected)
    );
    assert!(receiver.try_recv().is_err());
    assert_eq!(view.browser_request, 8);
    assert_eq!(
        view.pending_session_open,
        Some(crate::tmux_snapshot::session_open::Intent::exact(
            8,
            "$1".into()
        ))
    );
    assert_eq!(view.browser_state.surface, browser::Surface::Workspace);
    assert!(view.frame.is_none());
    assert!(!view.browser_state.input_ready);
}

#[gpui::test]
fn inactive_fleet_session_handler_refuses_without_consuming_intent(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| catalog(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let token = token(view);
            assert_eq!(view.browser_state.request, 7);
            view.presence.set_active(false);
            assert!(!view.presence.active());
            view.open_fleet_session(7, &token, window, cx);
            unchanged(view, &receiver);
        })
    });
}

#[gpui::test]
fn preack_fleet_session_requires_a_new_explicit_click_after_ack(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| catalog(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let token = token(view);
            view.presence = Presence::new(true);
            view.presence.flush(view.browser_commands.as_ref().unwrap());
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Presence {
                    active: true,
                    revision: 1
                }
            ));
            assert!(view.presence.active());
            assert!(!view.presence.ready());
            view.open_fleet_session(7, &token, window, cx);
            unchanged(view, &receiver);
            view.presence.acknowledge(1);
            assert!(view.presence.ready());
            // The ACK itself cannot replay the refused click.
            unchanged(view, &receiver);
            view.open_fleet_session(7, &token, window, cx);
            opened(view, &receiver, &token);
        })
    });
}

#[gpui::test]
fn ready_fleet_session_rejects_a_stale_publication(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| catalog(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let token = token(view);
            assert!(view.presence.ready());
            view.browser_state.request = 6;
            view.open_fleet_session(7, &token, window, cx);
            unchanged(view, &receiver);
            view.browser_state.request = 7;
            view.open_fleet_session(6, &token, window, cx);
            unchanged(view, &receiver);
            view.open_fleet_session(7, &token, window, cx);
            opened(view, &receiver, &token);
        })
    });
}

#[gpui::test]
fn ready_fleet_session_rejects_replaced_token_with_same_label(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| catalog(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let old = token(view);
            let new = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
            let session = &mut view.browser_state.fleet.as_mut().unwrap().groups[0].sessions[0];
            let label = session.name.clone();
            session.selection = Some(new.into());
            assert_eq!(session.name, label);
            view.open_fleet_session(7, &old, window, cx);
            unchanged(view, &receiver);
            view.open_fleet_session(7, new, window, cx);
            opened(view, &receiver, new);
        })
    });
}

#[gpui::test]
fn fleet_session_pointer_refuses_inactive_and_preack_then_opens_when_ready(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = catalog(window, cx, sender);
        view.presence = Presence::new(false);
        view
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(900.), px(800.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let row = cx.debug_bounds("fleet-session-0-0").unwrap();
    let point = point(row.right() - px(16.), row.center().y);
    cx.simulate_click(point, Modifiers::default());
    view.read_with(cx, |view, _| unchanged(view, &receiver));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.presence = Presence::new(true);
            view.presence.flush(view.browser_commands.as_ref().unwrap());
            cx.notify();
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Presence {
            active: true,
            revision: 1
        }
    ));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_click(point, Modifiers::default());
    view.read_with(cx, |view, _| unchanged(view, &receiver));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.presence.acknowledge(1);
            cx.notify();
        })
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_click(point, Modifiers::default());
    view.read_with(cx, |view, _| opened(view, &receiver, &token(view)));
}
