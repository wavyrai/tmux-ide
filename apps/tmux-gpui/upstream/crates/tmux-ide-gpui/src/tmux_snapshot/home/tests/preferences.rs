use super::*;
const ACTION: &str = "11111111-1111-4111-8111-111111111111";
fn preference_fleet() -> browser::fleet::Fleet {
    let mut fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../../../fixtures/browser-fleet.json"
    ))
    .unwrap();
    fixture["fleet"]["preferences"] =
        serde_json::json!({"revision":4,"phase":"ready","error":null});
    fixture["fleet"]["groups"][0]["collapseAction"] = ACTION.into();
    serde_json::from_value(fixture["fleet"].clone()).unwrap()
}
#[gpui::test]
fn preferences_queue_once_without_optimistic_flip_or_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| view.update(cx, |v, cx| {
        v.browser_state.request = 7;
        v.browser_state.fleet = Some(preference_fleet());
        v.prepare_home_filter(cx);
        v.change_fleet_preference(6, 4, ACTION, true, cx);
        v.change_fleet_preference(7, 3, ACTION, true, cx);
        v.change_fleet_preference(7, 4, "forged", true, cx);
        v.change_fleet_preference(7, 4, ACTION, false, cx);
        assert!(receiver.try_recv().is_err());
        v.change_fleet_preference(7, 4, ACTION, true, cx);
        let command = receiver.try_recv().unwrap();
        assert_eq!(serde_json::to_value(command).unwrap(), serde_json::json!({"type":"fleet-preference","request":7,"revision":4,"action":ACTION,"enabled":true}));
        assert!(!v.browser_state.fleet.as_ref().unwrap().groups[0].collapsed);
        assert_eq!(v.browser_request, 7);
        v.change_fleet_preference(7, 4, ACTION, true, cx);
        assert!(receiver.try_recv().is_err());
    }));
}
#[gpui::test]
fn preferences_refuse_composition_background_and_removed_action(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.fleet = Some(preference_fleet());
            v.prepare_home_filter(cx);
            v.marked = "é".into();
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            v.marked.clear();
            v.presence = Presence::new(false);
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            v.presence = Presence::new(true); // Still unacknowledged.
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            v.browser_state.fleet.as_mut().unwrap().groups[0].collapse_action = None;
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            assert!(receiver.try_recv().is_err());
        })
    });
}
#[test]
fn collapse_keeps_favorites_and_active_by_published_identity() {
    let mut fleet = preference_fleet();
    let group = &mut fleet.groups[0];
    group.collapsed = true;
    let mut row = group.sessions[0].clone();
    assert!(!group.shows(&row));
    row.favorite = true;
    assert!(group.shows(&row));
    row.favorite = false;
    row.active = true;
    assert!(group.shows(&row));
    row.active = false;
    group.collapsed = false;
    assert!(group.shows(&row));
}

#[gpui::test]
fn preference_pointer_isolated_at_normal_and_narrow_width(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut v = make_view(window, cx, sender);
        v.browser_state.request = 7;
        v.browser_state.fleet = Some(preference_fleet());
        v.frame = None;
        v.browser_state.frame = None;
        v.browser_state.input_ready = false;
        v.browser_state.selected_session = None;
        v.browser_state.selected_pane = None;
        v.browser_state.panes.clear();
        v.browser_state.regions.clear();
        v
    });
    receiver.try_iter().for_each(drop);
    for width in [1000., 620.] {
        cx.simulate_resize(size(px(width), px(800.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let home = cx.debug_bounds("tmux-home").unwrap();
        let button = cx.debug_bounds("fleet-collapse-0").unwrap();
        assert!(button.left() >= home.left() && button.right() <= home.right());
    }
    let button = cx.debug_bounds("fleet-collapse-0").unwrap();
    cx.simulate_click(button.center(), Modifiers::default());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetPreference {
            request: 7,
            revision: 4,
            enabled: true,
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |v, _| assert_eq!(v.browser_request, 7));
}

#[gpui::test]
fn preference_modal_removal_and_full_queue_are_independent_controls(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.fleet = Some(preference_fleet());
            v.prepare_home_filter(cx);
            assert!(v.presence.ready());
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            assert!(v.home_filter.as_ref().unwrap().preference_error);
            assert!(v.home_filter.as_ref().unwrap().preference_queued.is_none());
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Presence { .. }
            ));
            v.open_picker(window, cx);
            assert!(v.picker.is_some());
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            assert!(receiver.try_recv().is_err());
            v.picker = None;
            v.browser_state.fleet.as_mut().unwrap().groups[0].collapse_action = None;
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            assert!(receiver.try_recv().is_err());
            v.browser_state.fleet = Some(preference_fleet());
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::FleetPreference { .. }
            ));
        })
    });
}

#[gpui::test]
fn preference_new_epoch_and_acknowledged_foreground_retire_old_queue(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.fleet = Some(preference_fleet());
            v.prepare_home_filter(cx);
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::FleetPreference { .. }
            ));
            let next = "22222222-2222-4222-8222-222222222222";
            let fleet = v.browser_state.fleet.as_mut().unwrap();
            fleet.preferences.as_mut().unwrap().revision = 5;
            fleet.groups[0].collapse_action = None;
            fleet.groups[0].sessions[0].favorite_action = Some(next.into());
            v.change_fleet_preference(7, 4, ACTION, true, cx);
            assert!(receiver.try_recv().is_err());
            v.change_fleet_preference(7, 5, next, true, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::FleetPreference { revision: 5, .. }
            ));
            v.presence.set_active(false);
            v.presence.set_active(true);
            v.presence.flush(v.browser_commands.as_ref().unwrap());
            assert!(
                receiver
                    .try_iter()
                    .all(|c| matches!(c, browser::Command::Presence { .. }))
            );
            v.change_fleet_preference(7, 5, next, true, cx);
            assert!(receiver.try_recv().is_err());
            v.presence.acknowledge(3);
            v.browser_state.presence_revision = 3;
            assert!(v.presence.ready());
            v.change_fleet_preference(7, 5, next, true, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::FleetPreference { revision: 5, .. }
            ));
            assert!(!v.browser_state.fleet.as_ref().unwrap().groups[0].sessions[0].favorite);
        })
    });
}

#[test]
fn preference_svg_icons_are_embedded_and_listed() {
    let icons = crate::icons::Icons;
    for path in [
        "icons/fleet-star.svg",
        "icons/fleet-star-filled.svg",
        "icons/chevron-right.svg",
        "icons/chevron-down.svg",
    ] {
        assert!(icons.load(path).unwrap().is_some());
        assert!(
            icons
                .list("icons/")
                .unwrap()
                .iter()
                .any(|p| p.as_ref() == path)
        );
    }
}
