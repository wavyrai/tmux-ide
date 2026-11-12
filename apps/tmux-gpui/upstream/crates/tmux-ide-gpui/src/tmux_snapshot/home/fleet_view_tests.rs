//! Home's session table as its own view, replayed while unchanged: a
//! publication that changes nothing it shows must not render it again, every
//! kind of change it shows must, a replayed frame must paint what a fresh
//! one would at the same height, and an assistive client must read its rows.
#![allow(clippy::unwrap_used)]
use super::Inputs;
use crate::tmux_snapshot::{SnapshotView, browser, fit_test_support};
use core::prelude::v1::test;
use gpui::*;
use std::sync::mpsc;

/// One machine, one server, `count` sessions named `<prefix>-<n>`.
fn fleet(count: usize, prefix: &str) -> browser::fleet::Fleet {
    let token =
        |n: u128| uuid::Uuid::from_u128(0x9990_0000_0000_4000_8000_0000_0000_0000 + n).to_string();
    let rows: Vec<serde_json::Value> = (0..count)
        .map(|i| {
            serde_json::json!({
                "id": format!("s{i}"), "name": format!("{prefix}-{i}"), "sessionId": format!("${i}"),
                "serverId": "default", "paneCount": 1, "windowCount": 1, "lastActivity": 0,
                "favorite": i % 7 == 0,
                "favoriteAction": token(1000 + i as u128), "selection": token(2000 + i as u128),
                "active": false})
        })
        .collect();
    serde_json::from_value(serde_json::json!({
        "preferences": {"revision": 1, "phase": "ready", "error": null}, "omittedGroups": 0,
        "groups": [{"id": "local", "label": "Local", "state": "ready", "conflict": false,
            "collapsed": false, "collapseAction": token(1), "omittedSessions": 0, "omittedServers": 0,
            "servers": [{"id": "default", "label": "default", "state": "online",
                "generation": token(2), "selection": token(3)}],
            "sessions": rows}]}))
    .unwrap()
}

fn open(cx: &mut TestAppContext, count: usize) -> (Entity<SnapshotView>, &mut VisualTestContext) {
    let (sender, receiver) = mpsc::sync_channel(256);
    std::mem::forget(receiver);
    let state = browser::State {
        request: 7,
        surface: browser::Surface::Home,
        fleet: Some(fleet(count, "project")),
        ..Default::default()
    };
    let (view, cx) = cx
        .add_window_view(|window, cx| fit_test_support::fixture_view(window, cx, sender, 7, state));
    cx.simulate_resize(size(px(1200.), px(700.)));
    settle(cx);
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

/// Draws until the rows' window has been measured and nothing is owed.
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..4 {
        draw(cx);
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
        });
        cx.run_until_parked();
    }
    draw(cx);
}

/// A publication: the view is notified, then the window draws.
fn publish(
    view: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    change: impl FnOnce(&mut SnapshotView, &mut Context<SnapshotView>),
) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            change(view, cx);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
}

fn renders() -> usize {
    super::renders()
}

fn built(cx: &mut VisualTestContext, row: usize) -> bool {
    cx.debug_bounds(Box::leak(format!("fleet-session-0-{row}").into_boxed_str()))
        .is_some()
}

/// What the frame painted over Home's page, as comparable quads and
/// underlines, with the table's place and the page's scroll length.
fn painted(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> String {
    let table = cx.debug_bounds("home-fleet-table");
    let extent = view.read_with(cx, |v, _| {
        v.home_filter.as_ref().unwrap().page_scroll.max_offset()
    });
    cx.update(|window, _| {
        // Only the table: the page's scrollbar fades by the clock.
        let slot = table.map(|table| table.scale(window.scale_factor()));
        let inside =
            |b: &Bounds<ScaledPixels>| slot.as_ref().is_some_and(|slot| slot.contains(&b.origin));
        // Draw order is assigned per frame; what is drawn, and where, is not.
        let quads: Vec<_> = window
            .painted_quads()
            .into_iter()
            .filter(|q| inside(&q.bounds))
            .map(|q| {
                format!(
                    "{:?} {:?} {:?} {:?}",
                    q.bounds, q.background, q.border_color, q.content_mask
                )
            })
            .collect();
        let lines: Vec<_> = window
            .painted_underlines()
            .into_iter()
            .filter(|u| inside(&u.bounds))
            .map(|u| format!("{:?} {:?}", u.bounds, u.color))
            .collect();
        format!("{table:?} {extent:?} {quads:?} {lines:?}")
    })
}

/// Draws after `change` through the replayed path (the frame of the change,
/// then two more, so the last is a replay), then with every view forced
/// fresh, and requires both to paint the same.
fn same_as_fresh(
    view: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    name: &str,
    change: impl FnOnce(&mut SnapshotView, &mut Context<SnapshotView>),
) {
    publish(view, cx, change);
    settle(cx);
    let before = renders();
    publish(view, cx, |_, _| {});
    assert_eq!(renders(), before, "{name}: the last frame is a replay");
    let replayed = painted(view, cx);
    // Fresh: every view rendered, and the table laid out by its content
    // again, not at the height measured before.
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.home_fleet.forget());
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(
        painted(view, cx) == replayed,
        "{name}: the replayed table went stale"
    );
}

/// The point of the cache: a publication that changes nothing the table
/// shows does not render it again, and one that does renders it at once.
#[gpui::test]
fn a_publication_that_changes_nothing_replays_the_table(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, 30);
    let before = renders();
    for _ in 0..5 {
        publish(&view, cx, |view, _| {
            view.browser_state.status = view.browser_state.status.clone();
        });
    }
    assert_eq!(renders(), before, "the table rendered for nothing");
    assert!(built(cx, 0), "and its rows are still there");
    publish(&view, cx, |view, _| {
        view.browser_state.fleet = Some(fleet(30, "renamed"));
    });
    assert_eq!(renders(), before + 1, "a change renders it on its frame");
    // The frame after stores the paint to replay; then nothing more.
    publish(&view, cx, |_, _| {});
    let stored = renders();
    assert!(stored <= before + 2);
    for _ in 0..3 {
        publish(&view, cx, |_, _| {});
    }
    assert_eq!(renders(), stored, "and then it is replayed again");
}

/// Every kind of change the table shows reaches it, and a replayed frame is
/// the frame a fresh render paints, at the same height.
#[gpui::test]
fn the_replayed_table_paints_what_a_fresh_one_would(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, 30);
    same_as_fresh(&view, cx, "nothing", |_, _| {});
    same_as_fresh(&view, cx, "a session added", |view, _| {
        view.browser_state.fleet = Some(fleet(31, "project"));
    });
    same_as_fresh(&view, cx, "sessions gone", |view, _| {
        view.browser_state.fleet = Some(fleet(4, "project"));
    });
    same_as_fresh(&view, cx, "many sessions", |view, _| {
        view.browser_state.fleet = Some(fleet(100, "project"));
    });
    same_as_fresh(&view, cx, "favourites only", |view, _| {
        view.home_filter.as_mut().unwrap().fleet_view =
            crate::tmux_snapshot::home::fleet_nav::View::Favourites;
    });
    same_as_fresh(&view, cx, "all sessions again", |view, _| {
        view.home_filter.as_mut().unwrap().fleet_view =
            crate::tmux_snapshot::home::fleet_nav::View::All;
    });
    same_as_fresh(&view, cx, "the page scrolled", |view, _| {
        let page = &view.home_filter.as_ref().unwrap().page_scroll;
        page.set_offset(point(px(0.), px(-900.)));
    });
    same_as_fresh(&view, cx, "the machine collapsed", |view, _| {
        let mut fleet = fleet(100, "project");
        fleet.groups[0].collapsed = true;
        view.browser_state.fleet = Some(fleet);
    });
    same_as_fresh(&view, cx, "no connection", |view, _| {
        view.browser_commands = None;
    });
}

/// A resize is planned against the old page: the table is drawn again when
/// the page is laid out at its new size, replayed or not.
#[gpui::test]
fn a_resized_page_draws_the_table_again(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, 100);
    assert!(!built(cx, 30), "row 30 is below a 700 pt page");
    cx.simulate_resize(size(px(1200.), px(1800.)));
    settle(cx);
    assert!(built(cx, 30), "the rows now in view are built");
    let replayed = painted(&view, cx);
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.home_fleet.forget());
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(painted(&view, cx) == replayed);
}

type Change = fn(&mut SnapshotView, &mut Window, &mut Context<SnapshotView>);

fn roster(status: &str, phase: &str) -> Option<browser::home_agents::Roster> {
    serde_json::from_value(serde_json::json!({"revision": 5, "phase": phase, "rows": [
        {"key": "busy", "sessionId": "$1", "paneId": "p1", "name": "Busy",
         "sessionLabel": "project-1", "status": status, "attention": false,
         "available": true}],
        "observedSessions": 1, "totalSessions": 1, "truncatedSessions": 0,
        "truncatedRows": 0, "note": null}))
    .ok()
}

fn appearance(background: u32) -> crate::tmux_snapshot::appearance::Appearance {
    serde_json::from_value(serde_json::json!({
        "selected":"dark", "system":"dark", "error":null,
        "theme":{"canvas":1,"background":background,"foreground":3,"cursor":4,"surface":5,
            "active":6,"muted":7,"accent":8,"palette":vec![9;256]},
        "options":[{"id":"dark","name":"Dark"}]
    }))
    .unwrap()
}

/// The link drops, and the clock passes the point where its words show.
fn drop_the_link(view: &mut SnapshotView, cx: &mut Context<SnapshotView>) {
    let start = std::time::Instant::now();
    let wall = std::time::SystemTime::now();
    view.connection.clock = std::rc::Rc::new(move || (start, wall));
    view.browser_state.agents_last_known = true;
    view.browser_state.reconnect_attempt = Some(1);
    view.observe_connection(cx);
    let later = start + std::time::Duration::from_secs(600);
    view.connection.clock = std::rc::Rc::new(move || (later, wall));
}

/// Home with 30 sessions and a working agent on one, read, changed and
/// read again inside one update: no frame is drawn in between, so nothing
/// but the change moves a field.
fn inputs_around(cx: &mut TestAppContext, change: Change) -> ((Inputs, u64), (Inputs, u64)) {
    let (view, cx) = open(cx, 30);
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.browser_state.home_agents = roster("WORKING", "live")
        })
    });
    cx.update(|window, cx| {
        let read = |window: &Window, cx: &App| {
            let view = view.read(cx);
            (
                view.home_fleet_inputs(false, window, cx),
                view.home_fleet_key(false, window, cx),
            )
        };
        let before = read(window, cx);
        view.update(cx, |view, cx| change(view, window, cx));
        (before, read(window, cx))
    })
}

macro_rules! case {
    ($field:ident, $change:expr) => {
        (
            stringify!($field),
            $change as Change,
            (|a: &Inputs, b: &Inputs| a.$field != b.$field) as fn(&Inputs, &Inputs) -> bool,
        )
    };
}

/// One case per field of the table's [`Inputs`]: a change the table shows
/// must move that field, and with it the key its paint is kept under.
#[gpui::test]
fn each_input_the_table_reads_moves_its_field_and_the_key(cx: &mut TestAppContext) {
    // The appearance bezel paints in is process-wide: hold it, so no test
    // running alongside changes it under this one.
    let _appearance = bezel_theme::lock_appearance();
    let cases = [
        case!(catalog, |view, _, _| {
            view.browser_state.fleet = Some(fleet(30, "renamed"))
        }),
        case!(last_active, |view, _, _| {
            // From weeks ago to "now".
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap();
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            fleet.groups[0].sessions[1].last_activity = Some(now.as_secs() as i64);
        }),
        case!(away, |view, _, _| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            let long_ago = std::time::Instant::now() - std::time::Duration::from_secs(3600);
            fleet.groups[0].away = Some((long_ago, std::time::SystemTime::UNIX_EPOCH));
        }),
        case!(selected_server, |view, _, _| {
            view.browser_state.selected_server = Some(browser::fleet::SelectedServer {
                machine_id: "local".into(),
                machine_label: "Local".into(),
                server_id: "default".into(),
                generation: "g".into(),
                label: "default".into(),
            });
        }),
        case!(roster, |view, _, _| {
            view.browser_state.home_agents = roster("WORKING", "unavailable")
        }),
        case!(agents, |view, _, _| {
            view.browser_state.home_agents = roster("DONE", "live")
        }),
        case!(agents_last_known, |view, _, cx| drop_the_link(view, cx)),
        case!(local_last_known, |view, _, cx| drop_the_link(view, cx)),
        case!(request, |view, _, _| view.browser_request += 1),
        case!(state_request, |view, _, _| view.browser_state.request += 1),
        case!(presence_revision, |view, _, _| {
            view.browser_state.presence_revision += 1
        }),
        case!(home, |view, _, _| {
            view.browser_state.surface = browser::Surface::Workspace
        }),
        case!(connected, |view, _, _| view.browser_commands = None),
        case!(presence_ready, |view, _, _| {
            let ready = view.presence.ready();
            view.presence.set_active(!ready);
            assert_ne!(view.presence.ready(), ready, "the fixture's presence");
        }),
        case!(picker_closed, |view, window, cx| view
            .open_picker(window, cx)),
        case!(new_session_closed, |view, window, cx| {
            view.browser_state.home_phase = browser::HomePhase::Live;
            view.browser_state.create_session = Some(browser::CreateSession {
                phase: browser::CreatePhase::Idle,
                error: None,
                revision: 0,
            });
            view.open_new_session(view.browser_request, window, cx)
        }),
        case!(pane_actions_closed, |view, window, cx| {
            // The pane menu opens over a workspace (the fixture's pane-a).
            let state = &mut view.browser_state;
            state.surface = browser::Surface::Workspace;
            state.input_ready = true;
            state.selected_session = Some("session-a".into());
            state.pane_actions = Some(browser::PaneActions {
                token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                id: "pane-a".into(),
                zoomed: false,
            });
            state.panes = vec![browser::Choice {
                id: "pane-a".into(),
                label: "Editor".into(),
                pane_count: None,
                window_id: None,
                browser_icon: None,
                display_name_source: None,
                window_label: None,
            }];
            view.open_pane_actions(window, cx)
        }),
        case!(composing, |view, _, _| view.marked = "あ".into()),
        case!(view, |view, _, _| {
            view.home_filter.as_mut().unwrap().fleet_view =
                crate::tmux_snapshot::home::fleet_nav::View::Favourites
        }),
        case!(waiting_only, |view, _, _| {
            view.home_filter.as_mut().unwrap().waiting_only = true
        }),
        case!(cursor, |view, _, _| {
            view.home_filter.as_mut().unwrap().table_cursor = Some(("local".into(), "s3".into()))
        }),
        case!(preference_queued, |view, _, _| {
            view.home_filter.as_mut().unwrap().preference_queued = Some((7, 1, 0))
        }),
        case!(preference_error, |view, _, _| {
            view.home_filter.as_mut().unwrap().preference_error = true
        }),
        case!(table_focused, |view, window, cx| {
            let table = view.home_filter.as_ref().unwrap().fleet_table.clone();
            table.focus(window, cx);
        }),
        case!(rows_window, |view, _, _| {
            let page = &view.home_filter.as_ref().unwrap().page_scroll;
            page.set_offset(point(px(0.), px(-40.)));
        }),
        case!(theme, |view, _, _| {
            view.browser_state.appearance = Some(appearance(0x202020))
        }),
        case!(canvas, |view, _, _| {
            view.browser_state.appearance = Some(appearance(0x202020))
        }),
        case!(reduce_motion, |_, _, cx| {
            use bezel_motion::AppExt as _;
            let reduced = cx.reduced_motion();
            cx.set_reduced_motion(!reduced);
        }),
        case!(agent_motion, |view, _, _| {
            let active = view.presence.active();
            view.presence.set_active(!active)
        }),
        // This window has no spinner overlay: the glyphs animate themselves.
        case!(spinner_frame, |view, _, _| view
            .agent_animation
            .set_frame(3)),
    ];
    for (field, change, moved) in cases {
        let ((before, key), (after, new_key)) = inputs_around(cx, change);
        assert!(moved(&before, &after), "{field} did not move");
        assert_ne!(key, new_key, "{field} moved and the key did not");
    }
    // An entrance in motion changes the key with the clock.
    let (view, cx) = open(cx, 30);
    let read = |cx: &mut VisualTestContext, settling| {
        cx.update(|window, cx| view.read(cx).home_fleet_inputs(settling, window, cx))
    };
    let still = read(cx, false);
    assert_eq!(read(cx, false), still, "the inputs are stable");
    assert_eq!(still.moving, None);
    let moving = read(cx, true);
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(16));
    assert_ne!(
        read(cx, true).moving,
        moving.moving,
        "moving follows the clock"
    );
}

/// The spinner overlay being mounted is an input: under the window's root
/// the overlay animates the glyphs, and the frame is not.
#[gpui::test]
fn the_spinner_overlay_is_an_input(cx: &mut TestAppContext) {
    let (alone, cx) = open(cx, 3);
    let inputs = cx.update(|window, cx| alone.read(cx).home_fleet_inputs(false, window, cx));
    assert!(!inputs.spinner_attached);
    assert_eq!(inputs.spinner_frame, Some(0));
    alone.read_with(cx, |view, _| view.agent_animation.set_frame(3));
    let later = cx.update(|window, cx| alone.read(cx).home_fleet_inputs(false, window, cx));
    assert_eq!(later.spinner_frame, Some(3));
}

/// One case per field of the catalog the table draws from: each moves
/// `catalog`, and the key with it.
#[gpui::test]
fn each_catalog_field_moves_the_key(cx: &mut TestAppContext) {
    type Edit = fn(&mut browser::fleet::Fleet);
    let edits: [(&str, Edit); 30] = [
        ("omitted groups", |f| f.omitted_groups = 2),
        ("no preferences", |f| f.preferences = None),
        ("preferences revision", |f| {
            f.preferences.as_mut().unwrap().revision = 9
        }),
        ("preferences phase", |f| {
            f.preferences.as_mut().unwrap().phase = browser::fleet::PreferencePhase::Saving
        }),
        ("preferences error", |f| {
            f.preferences.as_mut().unwrap().error = Some("no".into())
        }),
        ("a machine more", |f| {
            let mut other = f.groups[0].clone();
            other.id = "other".into();
            f.groups.push(other);
        }),
        ("collapsed", |f| f.groups[0].collapsed = true),
        ("collapse action", |f| f.groups[0].collapse_action = None),
        ("machine id", |f| f.groups[0].id = "other".into()),
        ("machine label", |f| f.groups[0].label = "Other".into()),
        ("machine state", |f| {
            f.groups[0].state = browser::fleet::Phase::Disconnected
        }),
        ("diagnostic", |f| {
            f.groups[0].diagnostic =
                serde_json::from_value(serde_json::json!({"phase": "ready", "failure": null})).ok();
            assert!(f.groups[0].diagnostic.is_some());
        }),
        ("conflict", |f| f.groups[0].conflict = true),
        ("retry", |f| f.groups[0].retry = Some("r".into())),
        ("disconnect", |f| f.groups[0].disconnect = Some("d".into())),
        ("omitted sessions", |f| f.groups[0].omitted_sessions = 3),
        ("omitted servers", |f| f.groups[0].omitted_servers = 3),
        ("a server fewer", |f| f.groups[0].servers.clear()),
        ("server id", |f| f.groups[0].servers[0].id = "other".into()),
        ("server label", |f| {
            f.groups[0].servers[0].label = "other".into()
        }),
        ("server state", |f| {
            f.groups[0].servers[0].state = browser::fleet::ServerPhase::Offline
        }),
        ("server generation", |f| {
            f.groups[0].servers[0].generation = None
        }),
        ("server selection", |f| {
            f.groups[0].servers[0].selection = None
        }),
        ("a session fewer", |f| {
            f.groups[0].sessions.pop();
        }),
        ("session server", |f| {
            f.groups[0].sessions[1].server_id = None
        }),
        ("favourite", |f| f.groups[0].sessions[1].favorite = true),
        ("favourite action", |f| {
            f.groups[0].sessions[1].favorite_action = None
        }),
        ("attached", |f| f.groups[0].sessions[1].active = true),
        ("panes and windows", |f| {
            f.groups[0].sessions[1].pane_count = 4;
        }),
        ("selection", |f| f.groups[0].sessions[1].selection = None),
    ];
    let (view, cx) = open(cx, 30);
    let key = |cx: &mut VisualTestContext, fleet: browser::fleet::Fleet| {
        cx.update(|window, cx| {
            view.update(cx, |view, _| view.browser_state.fleet = Some(fleet));
            let view = view.read(cx);
            (
                view.home_fleet_inputs(false, window, cx).catalog,
                view.home_fleet_key(false, window, cx),
            )
        })
    };
    let base = key(cx, fleet(30, "project"));
    assert_eq!(
        key(cx, fleet(30, "project")),
        base,
        "the catalog's digest is stable"
    );
    for (name, edit) in edits {
        let mut changed = fleet(30, "project");
        edit(&mut changed);
        let (catalog, new_key) = key(cx, changed);
        assert_ne!(catalog, base.0, "{name} does not move the catalog");
        assert_ne!(new_key, base.1, "{name} does not move the key");
    }
    // The rest of a session's fields, one at a time.
    type SessionEdit = fn(&mut browser::fleet::Session);
    let session_edits: [(&str, SessionEdit); 5] = [
        ("session id", |s| s.id = "other".into()),
        ("session name", |s| s.name = "other".into()),
        ("windows", |s| s.window_count = Some(7)),
        ("tmux session id", |s| s.session_id = None),
        ("favicon", |s| {
            s.favicon = Some(std::sync::Arc::new(Image::from_bytes(
                ImageFormat::Png,
                Vec::new(),
            )))
        }),
    ];
    for (name, edit) in session_edits {
        let mut changed = fleet(30, "project");
        edit(&mut changed.groups[0].sessions[1]);
        assert_ne!(
            key(cx, changed).0,
            base.0,
            "{name} does not move the catalog"
        );
    }
}

/// An assistive client reads every row on every frame: with one connected
/// the table is drawn, never replayed, and replayed again when it leaves.
#[gpui::test]
fn an_assistive_client_reads_the_table_on_every_frame(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, 30);
    let rows_read = |cx: &mut VisualTestContext| {
        let tree = cx.update(|window, _| window.debug_a11y_tree_json().unwrap());
        (0..30)
            .filter(|row| tree.contains(&format!(r#"NamedInteger(\"fleet-favorite\", {row})"#)))
            .count()
    };
    cx.update(|window, cx| {
        window.set_a11y_active_for_test(true);
        window.draw(cx).clear(cx);
    });
    assert_eq!(rows_read(cx), 30, "the first frame");
    for frame in 0..3 {
        let before = renders();
        publish(&view, cx, |_, _| {});
        assert_eq!(renders(), before + 1, "drawn for the client");
        assert_eq!(rows_read(cx), 30, "frame {frame}");
    }
    cx.update(|window, cx| {
        window.set_a11y_active_for_test(false);
        window.draw(cx).clear(cx);
    });
    // The first frame without the client stores the paint to replay.
    publish(&view, cx, |_, _| {});
    let before = renders();
    publish(&view, cx, |_, _| {});
    assert_eq!(renders(), before, "replayed once the client leaves");
}

/// The table's view keeps its agents' spinner slots while it is replayed.
/// When Home is left they go: nothing spins where the table was.
#[gpui::test]
fn leaving_home_stops_the_tables_spinners(cx: &mut TestAppContext) {
    // Under the window's root, whose overlay paints the spinners.
    struct Host(AnyView);
    impl Render for Host {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(self.0.clone())
        }
    }
    let (sender, receiver) = mpsc::sync_channel(256);
    std::mem::forget(receiver);
    let state = browser::State {
        request: 7,
        surface: browser::Surface::Home,
        fleet: Some(fleet(3, "project")),
        ..Default::default()
    };
    let mut snapshot = None;
    let (_, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| fit_test_support::fixture_view(window, cx, sender, 7, state));
        snapshot = Some(view.clone());
        Host(crate::tmux_snapshot::agent_spinner::window_root(view, window, cx).into())
    });
    let view = snapshot.unwrap();
    cx.simulate_resize(size(px(1200.), px(700.)));
    settle(cx);
    publish(&view, cx, |view, _| {
        view.browser_state.home_agents = Some(
            serde_json::from_value(serde_json::json!({"revision": 5, "phase": "live", "rows": [
                {"key": "busy", "sessionId": "$1", "paneId": "p1", "name": "Busy",
                 "sessionLabel": "project-1", "status": "WORKING", "attention": false,
                 "available": true}],
                "observedSessions": 1, "totalSessions": 1, "truncatedSessions": 0,
                "truncatedRows": 0, "note": null}))
            .unwrap(),
        );
    });
    settle(cx);
    let table = cx.debug_bounds("home-fleet-table").unwrap();
    let in_table = |cx: &mut VisualTestContext| {
        view.read_with(cx, |view, _| {
            view.agent_animation
                .slot_bounds()
                .iter()
                .filter(|slot| table.contains(&slot.origin))
                .count()
        })
    };
    assert_eq!(in_table(cx), 1, "the working agent's spinner");
    publish(&view, cx, |_, _| {});
    assert_eq!(in_table(cx), 1, "kept while the table is replayed");
    publish(&view, cx, |view, _| {
        view.browser_state.surface = browser::Surface::Workspace;
    });
    assert_eq!(in_table(cx), 0, "gone with Home");
    publish(&view, cx, |view, _| {
        view.browser_state.surface = browser::Surface::Home;
    });
    assert_eq!(in_table(cx), 1, "and back with it");
}

/// The key's stand-in for a row's "last active" words changes exactly when
/// the words do, so an old session's row is not drawn again every minute.
#[test]
fn the_last_active_step_changes_with_the_words() {
    use crate::tmux_snapshot::home::fleet_rows::{last_active, last_active_step};
    let mut ago = 0;
    while ago < 40 * 86_400 {
        let next = ago + 1 + ago / 50;
        assert_eq!(
            last_active(ago, 0) == last_active(next, 0),
            last_active_step(ago, 0) == last_active_step(next, 0),
            "{ago} s and {next} s ago"
        );
        ago = next;
    }
    assert_eq!(last_active_step(5, 10), (0, 0), "a time ahead reads as now");
}
