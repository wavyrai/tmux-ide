//! #684: the left list picks what the table shows, by pointer and keyboard;
//! the agent list keeps its wheel; loading, preference errors and disabled
//! preference buttons render as Bezel parts.
use super::*;
use crate::tmux_snapshot::home::preferences::Status;
use fleet_nav::View;

const FAVORITE: &str = "68400000-0000-4000-8000-000000000001";

fn fleet_fixture() -> browser::fleet::Fleet {
    serde_json::from_slice(include_bytes!(
        "../../../../../../../fixtures/home-fleet.json"
    ))
    .unwrap()
}

fn shown_machines(cx: &mut VisualTestContext) -> Vec<usize> {
    cx.update(|window, cx| window.draw(cx).clear(cx));
    [
        "fleet-machine-0",
        "fleet-machine-1",
        "fleet-machine-2",
        "fleet-machine-3",
    ]
    .into_iter()
    .enumerate()
    .filter(|(_, key)| cx.debug_bounds(key).is_some())
    .map(|(i, _)| i)
    .collect()
}

fn fleet_view(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> View {
    view.read_with(cx, |v, _| v.home_fleet_view())
}

#[gpui::test]
fn list_selection_follows_pointer_and_keys_and_survives_a_vanished_machine(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(fleet_fixture());
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    cx.simulate_resize(size(px(1400.), px(1400.)));
    receiver.try_iter().for_each(drop);
    assert_eq!(shown_machines(cx), [0, 1, 2, 3]);
    assert_eq!(fleet_view(&view, cx), View::All);

    // Pointer: a machine entry shows that machine alone and takes focus.
    let entry = cx.debug_bounds("home-nav-machine-1").unwrap();
    cx.simulate_click(entry.center(), Modifiers::default());
    assert_eq!(fleet_view(&view, cx), View::Machine("qa-offline".into()));
    assert_eq!(shown_machines(cx), [1]);

    // Keys while the list has focus: arrows, and End stops at the last entry.
    cx.simulate_keystrokes("down");
    assert_eq!(fleet_view(&view, cx), View::Machine("qa-connecting".into()));
    assert_eq!(shown_machines(cx), [2]);
    cx.simulate_keystrokes("end down");
    assert_eq!(fleet_view(&view, cx), View::Machine("qa-conflict".into()));
    cx.simulate_keystrokes("home");
    assert_eq!(fleet_view(&view, cx), View::All);

    // Off the list, the arrows are not the list's; `[` and `]` still are.
    cx.update(|window, cx| view.update(cx, |v, cx| v.terminal_focus.focus(window, cx)));
    cx.simulate_keystrokes("down");
    assert_eq!(fleet_view(&view, cx), View::All);
    cx.simulate_keystrokes("]");
    assert_eq!(fleet_view(&view, cx), View::Favourites);
    assert_eq!(shown_machines(cx), Vec::<usize>::new());
    assert!(cx.debug_bounds("home-fleet-empty").is_some());
    cx.simulate_keystrokes("] ]");
    assert_eq!(fleet_view(&view, cx), View::Machine("qa-offline".into()));

    // The selection outlives a republished fleet that still has the machine…
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet = Some(fleet_fixture());
            cx.notify();
        })
    });
    assert_eq!(shown_machines(cx), [1]);
    // …and falls back to All sessions when the machine leaves.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet.as_mut().unwrap().groups.remove(1);
            cx.notify();
        })
    });
    assert_eq!(fleet_view(&view, cx), View::All);
    assert_eq!(shown_machines(cx), [0, 1, 2]);
    cx.simulate_keystrokes("]");
    assert_eq!(fleet_view(&view, cx), View::Favourites);
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn the_table_takes_the_keyboard_and_its_keys_act_on_the_cursor_row(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        let mut fleet = fleet_fixture();
        fleet.preferences = Some(
            serde_json::from_value(serde_json::json!({"revision":4,"phase":"ready","error":null}))
                .unwrap(),
        );
        fleet.groups[0].sessions[1].favorite_action = Some(FAVORITE.into());
        view.browser_state.fleet = Some(fleet);
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    cx.simulate_resize(size(px(1400.), px(1400.)));
    receiver.try_iter().for_each(drop);
    let (ids, second, server) = {
        let fleet = fleet_fixture();
        let local = &fleet.groups[0];
        let server = local
            .servers
            .iter()
            .find(|s| Some(&s.id) == local.sessions[1].server_id.as_ref())
            .unwrap();
        (
            [local.sessions[0].id.clone(), local.sessions[1].id.clone()],
            local.sessions[1].selection.clone().unwrap(),
            server.selection.clone().unwrap(),
        )
    };
    let cursor = |cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| {
            v.home_filter.as_ref().unwrap().table_cursor.clone()
        })
    };
    let hint = |cx: &mut VisualTestContext, row: usize| {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let key = ["fleet-session-enter-0-0", "fleet-session-enter-0-1"][row];
        cx.debug_bounds(key).is_some()
    };

    // A click picks the machine and gives the list focus; no hint yet.
    let entry = cx.debug_bounds("home-nav-machine-0").unwrap();
    cx.simulate_click(entry.center(), Modifiers::default());
    assert!(!hint(cx, 0));
    // Enter, like →, moves into the table, onto its first row, with the ↵
    // hint there.
    cx.simulate_keystrokes("enter");
    assert_eq!(cursor(cx), Some(("qa-local".into(), ids[0].clone())));
    assert!(hint(cx, 0) && !hint(cx, 1));
    // The arrows now move the table's cursor, not the list.
    cx.simulate_keystrokes("down down");
    assert_eq!(cursor(cx), Some(("qa-local".into(), ids[1].clone())));
    assert_eq!(fleet_view(&view, cx), View::Machine("qa-local".into()));
    assert!(hint(cx, 1) && !hint(cx, 0));
    assert!(receiver.try_recv().is_err());
    // F stars the cursor's session; D sends new sessions to its server.
    cx.simulate_keystrokes("f");
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"fleet-preference","request":7,"revision":4,
            "action":FAVORITE,"enabled":true})
    );
    cx.simulate_keystrokes("d");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetServer { selection, .. } if selection == server
    ));
    assert!(receiver.try_recv().is_err());
    // Selecting a server blurs the window and fences the request; once the
    // publication catches up and the table has the keyboard again, Enter
    // opens the cursor's session by its current token.
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = v.browser_request;
            v.home_filter
                .as_ref()
                .unwrap()
                .fleet_table
                .clone()
                .focus(window, cx);
        })
    });
    cx.simulate_keystrokes("enter");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetSession { selection, .. } if selection == second
    ));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn left_and_escape_hand_the_keyboard_back_to_the_list(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(fleet_fixture());
        // An agent behind the list, which a leaked Enter would open.
        view.browser_state.home_agents = Some(agents("live", 1));
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    cx.simulate_resize(size(px(1400.), px(1400.)));
    receiver.try_iter().for_each(drop);
    let entry = cx.debug_bounds("home-nav-all").unwrap();
    cx.simulate_click(entry.center(), Modifiers::default());
    for back in ["left", "escape"] {
        cx.simulate_keystrokes("right");
        cx.simulate_keystrokes(back);
        // Back on the list, ↓ moves the list again.
        cx.simulate_keystrokes("down");
        assert_eq!(fleet_view(&view, cx), View::Favourites, "after {back}");
        cx.simulate_keystrokes("up");
    }
    // `[` and `]` still change the list from the table.
    cx.simulate_keystrokes("right ]");
    assert_eq!(fleet_view(&view, cx), View::Favourites);
    cx.simulate_keystrokes("[");
    assert_eq!(fleet_view(&view, cx), View::All);
    cx.simulate_keystrokes("left");
    // An empty table does not take the keyboard: → and Enter on Favourites
    // stay on the list, and Enter reaches nothing behind it.
    cx.simulate_keystrokes("down right enter down");
    assert_eq!(fleet_view(&view, cx), View::Machine("qa-local".into()));
    assert!(receiver.try_recv().is_err());
    // Esc on the list hands the keyboard back.
    cx.simulate_keystrokes("escape");
    let (list, terminal) = cx.update(|window, cx| {
        view.read_with(cx, |v, _| {
            (
                v.home_filter.as_ref().unwrap().fleet_nav.is_focused(window),
                v.terminal_focus.is_focused(window),
            )
        })
    });
    assert!(!list && terminal);
    cx.simulate_keystrokes("down");
    assert_eq!(fleet_view(&view, cx), View::Machine("qa-local".into()));
}

#[gpui::test]
fn the_palette_keeps_its_keys_from_the_list_behind_it(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(fleet_fixture());
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    cx.simulate_resize(size(px(1400.), px(1400.)));
    receiver.try_iter().for_each(drop);
    // Control: without the palette, `]` moves the list.
    cx.simulate_keystrokes("]");
    assert_eq!(fleet_view(&view, cx), View::Favourites);
    cx.simulate_keystrokes("[");
    cx.update(|window, cx| view.update(cx, |v, cx| v.open_picker(window, cx)));
    assert!(view.read_with(cx, |v, _| v.picker.is_some()));
    cx.simulate_keystrokes("] ] [");
    assert_eq!(fleet_view(&view, cx), View::All);
}

#[gpui::test]
fn a_lone_server_folds_into_its_machine_and_two_servers_get_rows(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(fleet_fixture());
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    cx.simulate_resize(size(px(1400.), px(1400.)));
    receiver.try_iter().for_each(drop);
    let painted = |cx: &mut VisualTestContext, key: &'static str| {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.debug_bounds(key)
    };
    let update = |cx: &mut VisualTestContext, f: &dyn Fn(&mut SnapshotView)| {
        cx.update(|_, cx| {
            view.update(cx, |v, cx| {
                f(v);
                cx.notify();
            })
        })
    };

    // Two servers: a row each, each with its own "use for new sessions".
    assert!(painted(cx, "fleet-server-0-0").is_some());
    assert!(painted(cx, "fleet-server-0-1").is_some());
    assert!(painted(cx, "fleet-use-server-0-1").is_some());
    // The default among several is marked, and loses its button.
    update(cx, &|v| {
        v.browser_state.selected_server = Some(ink::server_on(v, 0, 0))
    });
    assert!(painted(cx, "fleet-server-default-0-0").is_some());
    assert!(painted(cx, "fleet-use-server-0-0").is_none());
    assert!(painted(cx, "fleet-use-server-0-1").is_some());
    // The table's marker replaces Home's "New sessions on …" line.
    assert!(painted(cx, "new-session-target").is_none());
    // Column labels once over the table, not per machine.
    assert!(painted(cx, "fleet-columns").is_some());

    // One server: no server row; its control sits in the machine header.
    update(cx, &|v| {
        v.browser_state.fleet.as_mut().unwrap().groups[0]
            .servers
            .truncate(1);
        v.browser_state.selected_server = None;
    });
    assert!(painted(cx, "fleet-server-0-0").is_none());
    assert!(painted(cx, "fleet-server-0-1").is_none());
    let header = painted(cx, "fleet-machine-header-0").unwrap();
    let use_server = painted(cx, "fleet-use-server-0-0").unwrap();
    assert!(header.contains(&use_server.center()));
    // It says what it does, as "Default" does once chosen: not a lone ✓.
    assert!(
        use_server.size.width > px(80.),
        "an icon-only control: {use_server:?}"
    );
    // Its sessions still show, and the button picks the lone server.
    assert!(painted(cx, "fleet-session-0-0").is_some());
    let token = view.read_with(cx, |v, _| {
        v.browser_state.fleet.as_ref().unwrap().groups[0].servers[0]
            .selection
            .clone()
            .unwrap()
    });
    cx.simulate_click(use_server.center(), Modifiers::default());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetServer { selection, .. } if selection == token
    ));
    assert!(receiver.try_recv().is_err());

    // The only place new sessions can go needs no marker.
    update(cx, &|v| {
        v.browser_state.fleet.as_mut().unwrap().groups.truncate(1);
        v.browser_state.selected_server = Some(ink::server_on(v, 0, 0));
    });
    assert!(painted(cx, "fleet-server-default-0-0").is_none());
    assert!(painted(cx, "fleet-use-server-0-0").is_none());
    update(cx, &|v| {
        v.home_filter.as_mut().unwrap().fleet_view = View::Machine("qa-local".into())
    });
    // Option A (#705): the column labels head every view.
    assert!(painted(cx, "fleet-columns").is_some());
    // Without a fleet table, the line is how Home names the default.
    update(cx, &|v| v.browser_state.fleet = None);
    assert!(painted(cx, "new-session-target").is_some());
}

fn agents(phase: &str, rows: usize) -> browser::home_agents::Roster {
    let rows: Vec<_> = (0..rows)
        .map(|i| {
            serde_json::json!({"key": format!("agent-{i}"), "sessionId": "session-a",
                "paneId": format!("pane-{i}"), "name": format!("Agent {i}"),
                "sessionLabel": "Session Alpha", "status": "WORKING",
                "attention": false, "available": true})
        })
        .collect();
    serde_json::from_value(
        serde_json::json!({"revision": 4, "phase": phase, "rows": rows,
        "observedSessions": 1, "totalSessions": 1, "truncatedSessions": 0,
        "truncatedRows": 0, "note": null}),
    )
    .unwrap()
}

#[gpui::test]
fn discovering_agents_shows_bezels_loader_only_while_loading(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.home_agents = Some(agents("loading", 0));
        view
    });
    cx.simulate_resize(size(px(1400.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let loader = cx.debug_bounds("home-agents-loader").unwrap();
    let status = cx.debug_bounds("home-agents-status").unwrap();
    assert!(loader.size.width > px(0.) && status.contains(&loader.center()));
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.home_agents = Some(agents("live", 1))
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("home-agents-loader").is_none());
    receiver.try_iter().for_each(drop);
}

const ACTION: &str = "11111111-1111-4111-8111-111111111111";

fn preference_fleet(phase: &str, error: Option<&str>) -> browser::fleet::Fleet {
    let mut fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../../../fixtures/browser-fleet.json"
    ))
    .unwrap();
    fixture["fleet"]["preferences"] =
        serde_json::json!({"revision": 4, "phase": phase, "error": error});
    fixture["fleet"]["groups"][0]["collapseAction"] = ACTION.into();
    // A second machine: a lone machine has no collapse to offer (#705).
    let second = serde_json::json!({"id":"second","label":"Second","state":"ready",
        "conflict":false,"omittedSessions":0,"sessions":[]});
    fixture["fleet"]["groups"]
        .as_array_mut()
        .unwrap()
        .push(second);
    serde_json::from_value(fixture["fleet"].clone()).unwrap()
}

#[gpui::test]
fn preference_errors_render_as_error_rows_and_progress_as_text(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(1400.), px(900.)));
    for (phase, error, status, shown, hidden) in [
        (
            "failed",
            Some("Disk full"),
            Some(Status::Error("Disk full")),
            "fleet-preference-error",
            "fleet-preference-status",
        ),
        (
            "saving",
            None,
            Some(Status::Progress("Saving fleet preferences…")),
            "fleet-preference-status",
            "fleet-preference-error",
        ),
    ] {
        cx.update(|window, cx| {
            view.update(cx, |v, cx| {
                v.browser_state.fleet = Some(preference_fleet(phase, error));
                v.prepare_home_filter(cx);
                assert_eq!(v.fleet_preference_status(), status);
            });
            window.draw(cx).clear(cx);
        });
        assert!(cx.debug_bounds(shown).is_some(), "{phase}: {shown} missing");
        assert!(cx.debug_bounds(hidden).is_none(), "{phase}: {hidden} shown");
    }
    cx.update(|_, cx| {
        view.update(cx, |v, _| {
            v.home_filter.as_mut().unwrap().preference_error = true;
            assert_eq!(
                v.fleet_preference_status(),
                Some(Status::Error("Preference not queued — try again"))
            );
        })
    });
    receiver.try_iter().for_each(drop);
}

#[gpui::test]
fn a_preference_button_is_disabled_until_preferences_are_ready(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.fleet = Some(preference_fleet("saving", None));
        view
    });
    cx.simulate_resize(size(px(1400.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    assert!(cx.debug_bounds("fleet-collapse-0-enabled").is_none());
    let disabled = cx.debug_bounds("fleet-collapse-0-disabled").unwrap();
    cx.simulate_click(disabled.center(), Modifiers::default());
    assert!(receiver.try_recv().is_err(), "a disabled button queued");
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.fleet = Some(preference_fleet("ready", None));
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("fleet-collapse-0-disabled").is_none());
    let enabled = cx.debug_bounds("fleet-collapse-0-enabled").unwrap();
    cx.simulate_click(enabled.center(), Modifiers::default());
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"fleet-preference","request":7,"revision":4,"action":ACTION,"enabled":true})
    );
}
