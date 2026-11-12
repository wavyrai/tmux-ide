//! Home's session table as its own view, replayed while unchanged: a
//! publication that changes nothing it shows must not render it again, every
//! kind of change it shows must, a replayed frame must paint what a fresh
//! one would at the same height, and an assistive client must read its rows.
#![allow(clippy::unwrap_used)]
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

/// The key covers each input the table's render reads.
#[gpui::test]
fn each_table_input_changes_the_key(cx: &mut TestAppContext) {
    type Change = fn(&mut SnapshotView);
    fn roster(status: &str, phase: &str) -> Option<browser::home_agents::Roster> {
        serde_json::from_value(serde_json::json!({"revision": 5, "phase": phase, "rows": [
            {"key": "busy", "sessionId": "$1", "paneId": "p1", "name": "Busy",
             "sessionLabel": "project-1", "status": status, "attention": false,
             "available": true}],
            "observedSessions": 1, "totalSessions": 1, "truncatedSessions": 0,
            "truncatedRows": 0, "note": null}))
        .ok()
    }
    let changes: [(&str, Change); 19] = [
        ("no agents", |view| view.browser_state.home_agents = None),
        ("an agent's state", |view| {
            view.browser_state.home_agents = roster("DONE", "live")
        }),
        ("the roster's phase", |view| {
            view.browser_state.home_agents = roster("WORKING", "unavailable")
        }),
        ("a session's name", |view| {
            view.browser_state.fleet = Some(fleet(30, "renamed"))
        }),
        ("a favourite", |view| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            fleet.groups[0].sessions[1].favorite = true;
        }),
        ("an attached session", |view| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            fleet.groups[0].sessions[1].active = true;
        }),
        ("last active", |view| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            fleet.groups[0].sessions[1].last_activity = Some(120);
        }),
        ("a machine's state", |view| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            fleet.groups[0].state = browser::fleet::Phase::Disconnected;
        }),
        ("a machine away", |view| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            let long_ago = std::time::Instant::now() - std::time::Duration::from_secs(3600);
            fleet.groups[0].away = Some((long_ago, std::time::SystemTime::UNIX_EPOCH));
        }),
        ("a server", |view| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            fleet.groups[0].servers[0].label = "other".into();
        }),
        ("the preferences", |view| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            fleet.preferences.as_mut().unwrap().revision += 1;
        }),
        ("the view", |view| {
            view.home_filter.as_mut().unwrap().fleet_view =
                crate::tmux_snapshot::home::fleet_nav::View::Favourites
        }),
        ("the waiting filter", |view| {
            view.home_filter.as_mut().unwrap().waiting_only = true
        }),
        ("the keyboard row", |view| {
            view.home_filter.as_mut().unwrap().table_cursor = Some(("local".into(), "s3".into()))
        }),
        ("a queued preference", |view| {
            view.home_filter.as_mut().unwrap().preference_queued = Some((7, 1, 0))
        }),
        ("the scroll offset", |view| {
            let page = &view.home_filter.as_ref().unwrap().page_scroll;
            page.set_offset(point(px(0.), px(-40.)));
        }),
        ("request", |view| view.browser_request += 1),
        ("composition", |view| view.marked = "あ".into()),
        ("commands", |view| view.browser_commands = None),
    ];
    // Each from the same starting window, so no change hides another.
    for (name, change) in changes {
        let (view, cx) = open(cx, 30);
        cx.update(|_, cx| {
            view.update(cx, |view, _| {
                view.browser_state.home_agents = roster("WORKING", "live")
            })
        });
        let key = |cx: &mut VisualTestContext| {
            cx.update(|window, cx| view.read(cx).home_fleet_key(false, window, cx))
        };
        let before = key(cx);
        assert_eq!(key(cx), before, "the key is stable");
        cx.update(|_, cx| view.update(cx, |view, _| change(view)));
        assert_ne!(key(cx), before, "{name} does not change the table's key");
    }
    // An entrance in motion changes the key with the clock.
    let (view, cx) = open(cx, 30);
    let moving = cx.update(|window, cx| view.read(cx).home_fleet_key(true, window, cx));
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(16));
    let later = cx.update(|window, cx| view.read(cx).home_fleet_key(true, window, cx));
    assert_ne!(moving, later, "a moving entrance does not change the key");
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
