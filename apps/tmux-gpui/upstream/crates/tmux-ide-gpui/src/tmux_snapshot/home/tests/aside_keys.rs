//! #359 review: a machine header's text actions are still controls, as the
//! Bezel button before them was: a tab stop each in the window's focus
//! order, Bezel's Activate (Enter and Space where Bezel's keys are bound)
//! presses them, a focus ring, and a disabled one ignores presses.
//!
//! The app binds neither Bezel's tab traversal nor its Activate keys, and
//! Home's own Tab cycles its action row, so the tests drive gpui's focus
//! order and the Activate action directly. Home's keyboard routes are D on
//! a table row (that row's server for new sessions) and the F5 palette
//! (Disconnect), which their own tests cover.
use super::*;

fn fleet_home(
    cx: &mut TestAppContext,
) -> (
    Entity<SnapshotView>,
    &mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
            ))
            .unwrap(),
        );
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    cx.simulate_resize(size(px(1400.), px(1400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    (view, cx, receiver)
}

/// Steps the window's focus order until `selector` holds keyboard focus;
/// false if it never does.
fn tab_to(cx: &mut VisualTestContext, selector: &str) -> bool {
    // debug_bounds takes a 'static selector.
    let marker: &'static str = Box::leak(format!("{selector}:focused").into_boxed_str());
    for _ in 0..80 {
        cx.update(|window, cx| {
            window.focus_next(cx);
            window.draw(cx).clear(cx);
        });
        if cx.debug_bounds(marker).is_some() {
            return true;
        }
    }
    false
}

#[gpui::test]
fn header_text_actions_take_focus_and_activate_from_the_keyboard(cx: &mut TestAppContext) {
    let (view, cx, receiver) = fleet_home(cx);
    assert!(
        tab_to(cx, "fleet-disconnect-0"),
        "Disconnect has a tab stop"
    );
    receiver.try_iter().for_each(drop);
    cx.dispatch_action(bezel_ui::focus::Activate);
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetDisconnect { .. }
    ));
    assert!(receiver.try_recv().is_err());
    assert!(
        tab_to(cx, "fleet-use-server-action-0-0"),
        "Use for new sessions has a tab stop"
    );
    let token = view.read_with(cx, |v, _| {
        v.browser_state.fleet.as_ref().unwrap().groups[0].servers[0]
            .selection
            .clone()
            .unwrap()
    });
    receiver.try_iter().for_each(drop);
    cx.dispatch_action(bezel_ui::focus::Activate);
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetServer { selection, .. } if selection == token
    ));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn a_disabled_header_action_ignores_presses(cx: &mut TestAppContext) {
    let (view, cx, receiver) = fleet_home(cx);
    // A publication for another request: the action would act on stale state.
    cx.update(|window, cx| {
        view.update(cx, |v, _| v.browser_state.request += 1);
        window.draw(cx).clear(cx);
    });
    let link = cx.debug_bounds("fleet-use-server-action-0-0").unwrap();
    cx.simulate_click(link.center(), Modifiers::default());
    assert!(
        !receiver
            .try_iter()
            .any(|c| matches!(c, browser::Command::FleetServer { .. }))
    );
    assert!(!tab_to(cx, "fleet-use-server-action-0-0"), "no tab stop");
}

/// #359 review 2: Disconnect is hard to hit by accident and easy on
/// purpose: 24 pt hit boxes with side padding, 20 pt apart, Disconnect last,
/// and the danger ink under the pointer and the keyboard.
#[gpui::test]
fn disconnect_stands_apart_and_reads_as_the_destructive_one(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = fleet_home(cx);
    // One server: its "Use for new sessions" joins Disconnect in the header.
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.fleet.as_mut().unwrap().groups[0]
                .servers
                .truncate(1);
            v.browser_state.selected_server = None;
        });
        window.draw(cx).clear(cx);
    });
    let use_server = cx.debug_bounds("fleet-use-server-action-0-0").unwrap();
    let disconnect = cx.debug_bounds("fleet-disconnect-0").unwrap();
    for (name, b) in [("use", use_server), ("disconnect", disconnect)] {
        assert!(b.size.height >= px(24.), "{name}: {b:?}");
    }
    assert!(disconnect.left() - use_server.right() >= px(20.));
    let header = cx.debug_bounds("fleet-machine-header-0").unwrap();
    assert!(
        header.right() - disconnect.right() < px(20.),
        "Disconnect is last"
    );
    let (muted, danger) = view.read_with(cx, |v, _| {
        let p = v.home_palette();
        (p.text_muted, p.danger_muted)
    });
    let ink = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            cx.global::<design::InkProbes>()
                .0
                .get("fleet-disconnect-0:ink")
                .copied()
        })
    };
    cx.update(|_, cx| cx.set_global(design::InkProbes::default()));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(ink(cx), Some(muted), "muted at rest");
    cx.simulate_mouse_move(disconnect.center(), None, Modifiers::default());
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(ink(cx), Some(danger), "danger under the pointer");
    cx.simulate_mouse_move(header.origin, None, Modifiers::default());
    assert!(tab_to(cx, "fleet-disconnect-0"));
    assert_eq!(ink(cx), Some(danger), "danger under the keyboard");
    // Use for new sessions lights in the text ink, not the danger ink.
    cx.simulate_mouse_move(use_server.center(), None, Modifiers::default());
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let use_ink = cx.update(|_, cx| {
        cx.global::<design::InkProbes>()
            .0
            .get("fleet-use-server-action-0-0:ink")
            .copied()
    });
    assert_ne!(use_ink, Some(danger));
}

/// #803: Home's own Tab reaches each machine's text actions after the
/// action row, "Use for new sessions" before Disconnect; Escape gives the
/// keyboard back; Return presses the focused one and nothing else.
#[gpui::test]
fn homes_tab_reaches_the_machine_actions_after_the_action_row(cx: &mut TestAppContext) {
    let (view, cx, receiver) = fleet_home(cx);
    let on = |cx: &mut VisualTestContext, selector: &'static str| {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.debug_bounds(selector).is_some()
    };
    let action = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| view.read(cx).home_action_index(window))
    };
    let aside = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| view.read(cx).home_aside_focused(window))
    };
    // The first stops are the action row's.
    cx.simulate_keystrokes("tab");
    assert!(action(cx).is_some() && !aside(cx), "the action row leads");
    let mut order = Vec::new();
    for _ in 0..40 {
        cx.simulate_keystrokes("tab");
        if !aside(cx) {
            if !order.is_empty() {
                break;
            }
            continue;
        }
        for selector in [
            "fleet-use-server-action-0-0:focused",
            "fleet-use-server-action-0-1:focused",
            "fleet-disconnect-0:focused",
            "fleet-disconnect-1:focused",
        ] {
            if on(cx, selector) {
                order.push(selector);
            }
        }
    }
    assert!(order.len() >= 2, "{order:?}");
    let disconnect = order
        .iter()
        .position(|s| *s == "fleet-disconnect-0:focused")
        .unwrap();
    assert!(
        disconnect > 0,
        "Disconnect is not the first stop: {order:?}"
    );
    assert!(
        order[..disconnect]
            .iter()
            .all(|s| s.starts_with("fleet-use-server-action-0-")),
        "a machine's own actions come before its Disconnect: {order:?}"
    );
    // Back to a "Use for new sessions" and press it with Return.
    for _ in 0..40 {
        if on(cx, order[0]) {
            break;
        }
        cx.simulate_keystrokes("tab");
    }
    assert!(on(cx, order[0]));
    receiver.try_iter().for_each(drop);
    // Keys that act on Home's table do nothing here.
    cx.simulate_keystrokes("d f ]");
    assert!(receiver.try_recv().is_err());
    assert!(on(cx, order[0]), "the action keeps the keyboard");
    // Shift-Tab steps back and Tab returns.
    cx.simulate_keystrokes("shift-tab");
    assert!(!on(cx, order[0]));
    cx.simulate_keystrokes("tab");
    assert!(on(cx, order[0]));
    // Escape gives the keyboard back to Home, and Tab finds the stop again.
    cx.simulate_keystrokes("escape");
    assert!(!aside(cx));
    let terminal = view.read_with(cx, |v, _| v.terminal_focus.clone());
    cx.update(|window, _| assert!(terminal.is_focused(window)));
    for _ in 0..40 {
        if on(cx, order[0]) {
            break;
        }
        cx.simulate_keystrokes("tab");
    }
    assert!(on(cx, order[0]));
    cx.simulate_keystrokes("enter");
    let sent: Vec<_> = receiver.try_iter().collect();
    assert_eq!(sent.len(), 1, "one press, one command");
    assert!(matches!(sent[0], browser::Command::FleetServer { .. }));
}

/// A focused machine action whose machine goes away does not keep the
/// keyboard on nothing: the next Tab lands on the action row.
#[gpui::test]
fn a_focused_machine_action_that_disappears_does_not_strand_tab(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = fleet_home(cx);
    let aside = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| view.read(cx).home_aside_focused(window))
    };
    for _ in 0..40 {
        cx.simulate_keystrokes("tab");
        if aside(cx) {
            break;
        }
    }
    assert!(aside(cx), "fixture: a machine action has the keyboard");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet.as_mut().unwrap().groups.clear();
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("tab");
    assert!(!aside(cx));
    let on_row = cx.update(|window, cx| view.read(cx).home_action_index(window));
    assert!(on_row.is_some(), "Tab lands on the action row");
}

/// Pressing "Use for new sessions" makes that server the default, and the
/// button gives way to "Default for new sessions". The keyboard does not
/// stay on the button that is gone: Home takes it back in the same frame.
#[gpui::test]
fn a_focused_server_action_that_becomes_the_default_hands_the_keyboard_back(
    cx: &mut TestAppContext,
) {
    let (view, cx, _receiver) = fleet_home(cx);
    let marker = "fleet-use-server-action-0-0:focused";
    let mut found = false;
    for _ in 0..40 {
        cx.simulate_keystrokes("tab");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if cx.debug_bounds(marker).is_some() {
            found = true;
            break;
        }
    }
    assert!(found, "fixture: the first server's action has the keyboard");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let fleet = v.browser_state.fleet.as_ref().unwrap();
            let group = &fleet.groups[0];
            let server = &group.servers[0];
            v.browser_state.selected_server = Some(browser::fleet::SelectedServer {
                machine_id: group.id.clone(),
                machine_label: group.label.clone(),
                server_id: server.id.clone(),
                generation: server.generation.clone().unwrap(),
                label: server.label.clone(),
            });
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    assert!(
        cx.debug_bounds("fleet-server-default-0-0").is_some(),
        "fixture: the server is now the default"
    );
    let aside = cx.update(|window, cx| view.read(cx).home_aside_focused(window));
    assert!(!aside, "the keyboard is not on a button that is gone");
    let terminal = view.read_with(cx, |v, _| v.terminal_focus.clone());
    cx.update(|window, _| assert!(terminal.is_focused(window)));
}

/// Tabs Home's own order until `selector` has the keyboard.
fn home_tab_to(cx: &mut VisualTestContext, selector: &str) -> bool {
    let marker: &'static str = Box::leak(format!("{selector}:focused").into_boxed_str());
    for _ in 0..60 {
        cx.simulate_keystrokes("tab");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if cx.debug_bounds(marker).is_some() {
            return true;
        }
    }
    false
}

/// A second machine "qa-b" after (or, `front`, before) the fixture's first,
/// with its own Disconnect token.
fn add_machine_b(view: &Entity<SnapshotView>, cx: &mut VisualTestContext, front: bool) {
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let fleet = v.browser_state.fleet.as_mut().unwrap();
            let mut b = fleet.groups[0].clone();
            b.id = "qa-b".into();
            b.label = "Machine B".into();
            b.disconnect = Some("token-b".into());
            fleet.groups.insert(if front { 0 } else { 1 }, b);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
}

fn disconnected_b(receiver: &mpsc::Receiver<browser::Command>) -> usize {
    receiver
        .try_iter()
        .filter(|c| {
            matches!(c, browser::Command::FleetDisconnect { disconnect, .. } if disconnect == "token-b")
        })
        .count()
}

fn home_has_the_keyboard(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> bool {
    let terminal = view.read_with(cx, |v, _| v.terminal_focus.clone());
    let aside = cx.update(|window, cx| view.read(cx).home_aside_focused(window));
    !aside && cx.update(|window, _| terminal.is_focused(window))
}

/// Review of #803: machine A's Disconnect has the keyboard and A leaves the
/// list, so B moves up to A's place. The keyboard goes back to Home; it
/// does not move to B's Disconnect, and Return disconnects nothing.
#[gpui::test]
fn a_removed_machine_does_not_hand_its_focus_to_the_next(cx: &mut TestAppContext) {
    let (view, cx, receiver) = fleet_home(cx);
    add_machine_b(&view, cx, false);
    assert!(home_tab_to(cx, "fleet-disconnect-0"), "fixture");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet.as_mut().unwrap().groups.remove(0);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    assert!(home_has_the_keyboard(&view, cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("enter");
    assert_eq!(disconnected_b(&receiver), 0, "Return disconnected B");
}

/// Review of #803: a machine added in front of the focused one does not
/// take its focus; Return still means the machine the user chose.
#[gpui::test]
fn an_added_machine_does_not_take_the_focus(cx: &mut TestAppContext) {
    let (view, cx, receiver) = fleet_home(cx);
    assert!(home_tab_to(cx, "fleet-disconnect-0"), "fixture");
    let a = view.read_with(cx, |v, _| {
        v.browser_state.fleet.as_ref().unwrap().groups[0]
            .disconnect
            .clone()
            .unwrap()
    });
    add_machine_b(&view, cx, true);
    assert!(
        cx.debug_bounds("fleet-disconnect-1:focused").is_some(),
        "the focus stays on A's Disconnect, now the second machine"
    );
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("enter");
    let sent: Vec<_> = receiver.try_iter().collect();
    assert_eq!(sent.len(), 1, "one press, one command");
    assert!(
        matches!(&sent[0], browser::Command::FleetDisconnect { disconnect, .. } if *disconnect == a),
        "Return disconnects A, the machine chosen"
    );
}

/// Review of #803: the focused machine is still listed but no longer drawn
/// (another machine's view, or the waiting-only filter). Home takes the
/// keyboard back, and Tab reaches the action row again.
#[gpui::test]
fn a_hidden_machine_does_not_keep_the_focus(cx: &mut TestAppContext) {
    let (view, cx, receiver) = fleet_home(cx);
    add_machine_b(&view, cx, false);
    assert!(home_tab_to(cx, "fleet-disconnect-0"), "fixture");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let id = v.browser_state.fleet.as_ref().unwrap().groups[1].id.clone();
            v.home_filter.as_mut().unwrap().fleet_view = fleet_nav::View::Machine(id);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    assert!(
        cx.debug_bounds("fleet-disconnect-0").is_none(),
        "fixture: machine 0 is hidden"
    );
    assert!(home_has_the_keyboard(&view, cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("enter");
    assert!(
        !receiver
            .try_iter()
            .any(|c| matches!(c, browser::Command::FleetDisconnect { .. })),
        "Return on a hidden Disconnect"
    );
    cx.simulate_keystrokes("tab");
    let row = cx.update(|window, cx| view.read(cx).home_action_index(window));
    assert!(row.is_some(), "Tab lands on the action row");
}

/// A machine that loses its Disconnect while it has the keyboard hands the
/// keyboard back to Home.
#[gpui::test]
fn a_disconnect_that_goes_away_hands_the_keyboard_back(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = fleet_home(cx);
    assert!(home_tab_to(cx, "fleet-disconnect-0"), "fixture");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet.as_mut().unwrap().groups[0].disconnect = None;
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    assert!(home_has_the_keyboard(&view, cx));
}

/// A "Use for new sessions" drawn disabled is not a Tab stop; Disconnect,
/// which is never disabled, still is.
#[gpui::test]
fn a_disabled_server_action_is_not_a_stop(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = fleet_home(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = v.browser_request + 1;
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    let mut seen = Vec::new();
    for _ in 0..40 {
        cx.simulate_keystrokes("tab");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        for selector in [
            "fleet-use-server-action-0-0:focused",
            "fleet-use-server-action-0-1:focused",
            "fleet-disconnect-0:focused",
        ] {
            if cx.debug_bounds(selector).is_some() {
                seen.push(selector);
            }
        }
    }
    assert!(seen.contains(&"fleet-disconnect-0:focused"), "{seen:?}");
    assert!(
        !seen.iter().any(|s| s.starts_with("fleet-use-server")),
        "{seen:?}"
    );
}

/// Space presses the focused action, as Return does, once per press.
#[gpui::test]
fn space_presses_a_machine_action(cx: &mut TestAppContext) {
    let (_view, cx, receiver) = fleet_home(cx);
    assert!(home_tab_to(cx, "fleet-disconnect-0"), "fixture");
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("space");
    let sent: Vec<_> = receiver.try_iter().collect();
    assert_eq!(sent.len(), 1, "one press, one command");
    assert!(matches!(sent[0], browser::Command::FleetDisconnect { .. }));
}

/// Review of #803 (round 2): the last sessions end while a machine's
/// Disconnect has the keyboard. The table becomes the "No sessions yet"
/// invitation and draws no machine action, so Home takes the keyboard back.
#[gpui::test]
fn an_empty_table_does_not_keep_the_focus(cx: &mut TestAppContext) {
    let (view, cx, receiver) = fleet_home(cx);
    assert!(home_tab_to(cx, "fleet-disconnect-0"), "fixture");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            for g in &mut v.browser_state.fleet.as_mut().unwrap().groups {
                g.sessions.clear();
                g.omitted_sessions = 0;
                g.state = browser::fleet::Phase::Ready;
                g.collapsed = false;
                g.conflict = false;
            }
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    assert!(
        cx.debug_bounds("home-fleet-no-sessions").is_some()
            && cx.debug_bounds("fleet-disconnect-0").is_none(),
        "fixture: the invitation, no machine actions"
    );
    assert!(
        home_has_the_keyboard(&view, cx),
        "an undrawn Disconnect kept the keyboard"
    );
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("enter");
    assert!(
        !receiver
            .try_iter()
            .any(|c| matches!(c, browser::Command::FleetDisconnect { .. })),
        "Return on an undrawn Disconnect"
    );
    cx.simulate_keystrokes("tab");
    let row = cx.update(|window, cx| view.read(cx).home_action_index(window));
    assert!(row.is_some(), "Tab lands on the action row");
}

/// Review of #803 (round 2): with two machines, Tab takes each machine's
/// actions in turn, its servers' before its Disconnect, and never mixes them.
#[gpui::test]
fn tab_takes_each_machines_actions_in_turn(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = fleet_home(cx);
    add_machine_b(&view, cx, false);
    let selectors: Vec<String> = (0..2)
        .flat_map(|m| {
            (0..2)
                .map(move |s| format!("fleet-use-server-action-{m}-{s}"))
                .chain(std::iter::once(format!("fleet-disconnect-{m}")))
        })
        .collect();
    let mut seen: Vec<String> = Vec::new();
    for _ in 0..60 {
        cx.simulate_keystrokes("tab");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        for selector in &selectors {
            let marker: &'static str = Box::leak(format!("{selector}:focused").into_boxed_str());
            if cx.debug_bounds(marker).is_some() && !seen.contains(selector) {
                seen.push(selector.clone());
            }
        }
    }
    // Machine B (index 1): "fleet-use-server-action-1-…" or "fleet-disconnect-1".
    let machine = |s: &String| {
        s.strip_prefix("fleet-use-server-action-")
            .map_or(s == "fleet-disconnect-1", |rest| rest.starts_with("1-"))
    };
    let disconnect = |s: &String| s.starts_with("fleet-disconnect");
    let expected_a: Vec<&String> = seen.iter().filter(|s| !machine(s)).collect();
    assert!(expected_a.len() >= 2, "{seen:?}");
    assert!(seen.iter().any(|s| machine(s) && disconnect(s)), "{seen:?}");
    // Machine A's actions all come before machine B's.
    let first_b = seen.iter().position(machine).unwrap();
    assert!(seen[..first_b].iter().all(|s| !machine(s)), "{seen:?}");
    assert!(seen[first_b..].iter().all(machine), "{seen:?}");
    // In each machine, Disconnect is the last stop.
    for m in [false, true] {
        let mine: Vec<&String> = seen.iter().filter(|s| machine(s) == m).collect();
        assert!(disconnect(mine.last().unwrap()), "{seen:?}");
        assert_eq!(mine.iter().filter(|s| disconnect(s)).count(), 1, "{seen:?}");
    }
}
