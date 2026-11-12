//! The sidebar as its own view, replayed while unchanged: it must paint
//! exactly what a fresh render would after every kind of change, a terminal
//! publication alone must not render it again, and an assistive client must
//! read the tree it reads on main.
#![allow(clippy::unwrap_used)]
use crate::tmux_snapshot::{SnapshotView, agent_spinner, browser, fit_test_support};
use core::prelude::v1::test;
use gpui::*;
use std::sync::mpsc;

struct Host {
    snapshot: Entity<SnapshotView>,
    content: AnyView,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.content.clone())
    }
}

/// A workspace with a fleet of `sessions` sessions.
fn workspace(sessions: usize) -> browser::State {
    named(sessions, "project")
}

/// The same, with sessions named `<prefix>-<n>`.
fn named(sessions: usize, prefix: &str) -> browser::State {
    let rows: Vec<serde_json::Value> = (0..sessions)
        .map(|i| {
            serde_json::json!({"id": format!("s{i}"), "name": format!("{prefix}-{i}"),
                "sessionId": format!("${i}"), "serverId": "default", "paneCount": 1})
        })
        .collect();
    let mut state = browser::State {
        surface: browser::Surface::Workspace,
        request: 7,
        selected_session: Some("$0".into()),
        ..Default::default()
    };
    state.fleet = Some(
        serde_json::from_value(serde_json::json!({
            "omittedGroups": 0, "groups": [{"id": "local", "label": "Local", "state": "ready",
                "conflict": false, "omittedSessions": 0, "sessions": rows}]
        }))
        .unwrap(),
    );
    state
}

fn open(cx: &mut TestAppContext) -> (Entity<SnapshotView>, &mut VisualTestContext) {
    open_with(cx, workspace(8))
}

fn open_with(
    cx: &mut TestAppContext,
    state: browser::State,
) -> (Entity<SnapshotView>, &mut VisualTestContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    std::mem::forget(receiver);
    let (host, cx) = cx.add_window_view(|window, cx| {
        let snapshot = cx.new(|cx| fit_test_support::fixture_view(window, cx, sender, 7, state));
        let content = agent_spinner::window_root(snapshot.clone(), window, cx).into();
        Host { snapshot, content }
    });
    cx.simulate_resize(size(px(1000.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let snapshot = host.read_with(cx, |host, _| host.snapshot.clone());
    (snapshot, cx)
}

/// What the frame painted over the sidebar's column, as comparable quads and
/// underlines. Only the sidebar: Home's own entrances differ frame to frame.
fn painted(cx: &mut VisualTestContext) -> String {
    cx.update(|window, _| {
        let scale = window.scale_factor();
        let height = window.viewport_size().height;
        let slot = Bounds::new(
            point(px(0.), px(0.)),
            size(px(crate::tmux_snapshot::browser_ui::SIDEBAR_WIDTH), height),
        )
        .scale(scale);
        let inside = |b: &Bounds<ScaledPixels>| slot.contains(&b.origin);
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
        format!("{quads:?} {lines:?}")
    })
}

/// Draws after `change` through the cached path, then again with every view
/// forced fresh, and requires both frames to paint the same.
fn same_as_fresh(
    snapshot: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    name: &str,
    change: impl FnOnce(&mut SnapshotView, &mut Context<SnapshotView>),
) {
    cx.update(|window, cx| {
        snapshot.update(cx, |view, cx| {
            change(view, cx);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    let cached = painted(cx);
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(
        painted(cx) == cached,
        "{name}: the cached sidebar went stale"
    );
}

/// Risk 7 of the design: every kind of change the sidebar shows reaches it.
#[gpui::test]
fn the_cached_sidebar_paints_what_a_fresh_one_would(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    same_as_fresh(&snapshot, cx, "a terminal-only publication", |view, _| {
        view.browser_state.status = view.browser_state.status.clone();
    });
    same_as_fresh(&snapshot, cx, "a session added", |view, _| {
        let mut state = workspace(9);
        state.selected_session = Some("$3".into());
        view.browser_state.fleet = state.fleet;
    });
    same_as_fresh(&snapshot, cx, "keyboard navigation on", |view, _| {
        view.sidebar_keyboard.active = true;
    });
    same_as_fresh(&snapshot, cx, "the surface", |view, _| {
        view.browser_state.surface = browser::Surface::Home;
    });
    same_as_fresh(&snapshot, cx, "back to the workspace", |view, _| {
        view.browser_state.surface = browser::Surface::Workspace;
    });
    same_as_fresh(&snapshot, cx, "the sidebar hidden", |view, _| {
        view.sidebar_hidden = true;
    });
    same_as_fresh(&snapshot, cx, "the sidebar shown", |view, _| {
        view.sidebar_hidden = false;
    });
}

/// The point of the cache: a publication that changes nothing the sidebar
/// shows does not render it again.
#[gpui::test]
fn a_terminal_frame_does_not_render_the_sidebar(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    let renders = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| crate::tmux_snapshot::browser_ui::sidebar_view::renders(cx))
    };
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let before = renders(cx);
    for _ in 0..5 {
        cx.update(|window, cx| {
            snapshot.update(cx, |_, cx| cx.notify());
            window.draw(cx).clear(cx);
        });
    }
    assert_eq!(
        renders(cx),
        before,
        "the sidebar rendered for terminal frames"
    );
    cx.update(|window, cx| {
        snapshot.update(cx, |view, cx| {
            // Only the rows' labels change: nothing but the rows sees it.
            view.browser_state.fleet = named(8, "renamed").fleet;
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    assert_eq!(
        renders(cx),
        before + 1,
        "a sidebar change must render it once"
    );
}

/// The key covers each input the sidebar reads (design risk 7).
#[gpui::test]
fn each_sidebar_input_changes_the_key(cx: &mut TestAppContext) {
    type Change = fn(&mut SnapshotView);
    let changes: [(&str, Change); 6] = [
        ("keyboard", |view| {
            view.sidebar_keyboard.active = !view.sidebar_keyboard.active
        }),
        ("surface", |view| {
            view.browser_state.surface = browser::Surface::Home
        }),
        ("request", |view| view.browser_request += 1),
        ("sessions", |view| {
            view.browser_state.fleet = workspace(3).fleet
        }),
        ("composition", |view| view.marked = "あ".into()),
        ("commands", |view| view.browser_commands = None),
    ];
    // Each from the same starting window, so no change hides another.
    for (name, change) in changes {
        let (snapshot, cx) = open(cx);
        let key = |cx: &mut VisualTestContext| {
            cx.update(|window, cx| snapshot.read(cx).sidebar_key(window, cx))
        };
        let before = key(cx);
        cx.update(|_, cx| snapshot.update(cx, |view, _| change(view)));
        assert_ne!(key(cx), before, "{name} does not change the sidebar key");
    }
}

/// The window's accessibility tree as an outline, in the order an assistive
/// client walks it: one line per node, indented by depth, role then label.
fn outline(cx: &mut VisualTestContext) -> Vec<String> {
    let json = cx.update(|window, _| window.debug_a11y_tree_json().unwrap());
    let tree: serde_json::Value = serde_json::from_str(&json).unwrap();
    fn walk(tree: &serde_json::Value, id: &str, depth: usize, out: &mut Vec<String>) {
        let node = &tree["nodes"][id];
        let aria = &node["aria"];
        let mut line = format!("{}{}", "  ".repeat(depth), aria["role"].as_str().unwrap());
        for key in ["label", "description", "value", "selected"] {
            if !aria[key].is_null() {
                line.push_str(&format!(" {key}={}", aria[key]));
            }
        }
        out.push(line);
        for child in node["children"].as_array().into_iter().flatten() {
            walk(tree, child.as_str().unwrap(), depth + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(&tree, tree["root"].as_str().unwrap(), 0, &mut out);
    out
}

/// Switches accessibility on, as VoiceOver connecting does, and draws.
fn with_assistive_client(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.set_a11y_active_for_test(true);
        window.draw(cx).clear(cx);
    });
}

/// Home with three sessions: the sidebar, then Home's own controls.
fn home() -> browser::State {
    let mut state = workspace(3);
    state.surface = browser::Surface::Home;
    state
}

/// The tree main builds for [`home`], where the sidebar's elements are part
/// of `SnapshotView`'s own render (850b150d; the same outline function, run
/// there). The sidebar's nodes come after the title controls and before
/// Home's, each row a heading with its favourite button.
const MAIN_OUTLINE: &str = r#"Window
  Button label="Show / hide sidebar · F10"
  Button label="Browse sessions…"
  Button label="New session on this Mac"
  Button label="Home" selected=true
  Heading label="project-0, Unavailable, project" selected=false
    Button label="Add favorite"
  Heading label="project-1, Unavailable, project" selected=false
    Button label="Add favorite"
  Heading label="project-2, Unavailable, project" selected=false
    Button label="Add favorite"
  Button label="Switch session"
  Button label="Switch machine"
  Button label="Choose theme" description="Appearance settings are not available yet"
  Button label="Settings and commands"
  Button label="Browse sessions"
  Button label="Refresh"
  Button label="New session…" description="Connect to a local tmux server from Your fleet, then create a session."
  TabList label="Fleet"
    Tab label="All sessions" selected=true
    Tab label="Favourites" selected=false
    Tab label="Local" selected=false
    Button label="Add machine…"
  Grid label="Sessions"
    Button label="Add favorite"
    Button label="Add favorite"
    Button label="Add favorite""#;

/// GPUI builds the accessibility tree from the elements a frame prepaints, and
/// a replayed view prepaints none. So while an assistive client is connected
/// the sidebar is drawn every frame, and the client reads on every frame the
/// tree main builds: same nodes, same order.
#[gpui::test]
fn an_assistive_client_reads_the_tree_main_builds(cx: &mut TestAppContext) {
    let (snapshot, cx) = open_with(cx, home());
    let without = painted(cx);
    with_assistive_client(cx);
    assert!(painted(cx) == without, "a client changed what is painted");
    assert_eq!(outline(cx).join("\n"), MAIN_OUTLINE, "the first frame");
    for frame in 0..3 {
        cx.update(|window, cx| {
            snapshot.update(cx, |_, cx| cx.notify());
            window.draw(cx).clear(cx);
        });
        assert_eq!(
            outline(cx).join("\n"),
            MAIN_OUTLINE,
            "terminal frame {frame}"
        );
    }
}

/// A frame only the window root renders (an agent-spinner tick) replays
/// `SnapshotView`. On main that frame's tree is the window node alone, so a
/// working agent emptied the tree twelve times a second; the root now draws
/// `SnapshotView` on such frames while a client is connected.
#[gpui::test]
fn a_spinner_tick_keeps_the_tree_for_an_assistive_client(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    std::mem::forget(receiver);
    let (host, cx) = cx.add_window_view(|window, cx| {
        let snapshot = cx.new(|cx| fit_test_support::fixture_view(window, cx, sender, 7, home()));
        let content = agent_spinner::window_root(snapshot.clone(), window, cx).into();
        Host { snapshot, content }
    });
    cx.simulate_resize(size(px(1000.), px(700.)));
    with_assistive_client(cx);
    let root = host.read_with(cx, |host, _| host.content.entity_id());
    cx.update(|window, cx| {
        cx.notify(root);
        window.draw(cx).clear(cx);
    });
    assert_eq!(outline(cx).join("\n"), MAIN_OUTLINE);
}

/// Without a client nothing reads the tree, and the sidebar is replayed
/// again from the frame after the client leaves.
#[gpui::test]
fn the_sidebar_is_replayed_again_when_the_client_leaves(cx: &mut TestAppContext) {
    let (snapshot, cx) = open_with(cx, home());
    let renders = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| crate::tmux_snapshot::browser_ui::sidebar_view::renders(cx))
    };
    let terminal_frame = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            snapshot.update(cx, |_, cx| cx.notify());
            window.draw(cx).clear(cx);
        });
    };
    with_assistive_client(cx);
    let before = renders(cx);
    terminal_frame(cx);
    assert_eq!(renders(cx), before + 1, "drawn for the client");
    cx.update(|window, cx| {
        window.set_a11y_active_for_test(false);
        window.draw(cx).clear(cx);
    });
    // The first frame without the client stores the paint to replay.
    terminal_frame(cx);
    let settled = renders(cx);
    terminal_frame(cx);
    terminal_frame(cx);
    assert_eq!(renders(cx), settled, "replayed without a client");
}

/// Lets `ms` of the executor's clock pass, a frame every 20 ms: the frame
/// clock that hover washes claim and GPUI's animations both read it.
fn animate(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext, ms: u64) {
    for _ in 0..ms / 20 {
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(20));
        cx.run_until_parked();
        cx.update(|window, cx| {
            // A terminal frame, as a busy pane publishes while this runs.
            snapshot.update(cx, |_, cx| cx.notify());
            window.draw(cx).clear(cx);
        });
    }
}

fn with_motion(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        // A test window is not the active one, and the frame clock refuses
        // claims while no window is: keep it running.
        bezel_motion::AppExt::set_pause_when_inactive(cx, false);
        snapshot.update(cx, |view, cx| {
            view.chrome.force_motion(false);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
}

/// What a frame drawn now paints over the sidebar, against a forced render.
fn assert_settled(cx: &mut VisualTestContext, name: &str) {
    let cached = painted(cx);
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(
        painted(cx) == cached,
        "{name}: the replayed sidebar is stale"
    );
}

/// A wash's value follows the wall clock while its frames follow the
/// executor's: wait out the 150 ms, so the frames that follow paint its end.
fn settle_wash() {
    std::thread::sleep(std::time::Duration::from_millis(250));
}

/// A row's hover wash fades in over 150 ms. The frames of that fade must
/// render the sidebar, or it keeps the wash of the frame it was last drawn.
#[gpui::test]
fn a_hover_wash_finishes_on_the_replayed_sidebar(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    with_motion(&snapshot, cx);
    let row = cx.debug_bounds("tmux-sidebar-row-2").unwrap();
    let renders = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| crate::tmux_snapshot::browser_ui::sidebar_view::renders(cx))
    };
    let before = renders(cx);
    cx.simulate_mouse_move(row.center(), None, Modifiers::none());
    settle_wash();
    animate(&snapshot, cx, 400);
    // One render is the hover itself; the rest are the fade's frames.
    assert!(
        renders(cx) - before >= 3,
        "the wash's frames did not render the sidebar: {}",
        renders(cx) - before
    );
    assert_settled(cx, "hovered");
    // The Home row's wash asks the same view.
    let home = cx.debug_bounds("tmux-sidebar-home").unwrap();
    let before = renders(cx);
    cx.simulate_mouse_move(home.center(), None, Modifiers::none());
    settle_wash();
    animate(&snapshot, cx, 400);
    assert!(
        renders(cx) - before >= 3,
        "the Home row's wash did not render the sidebar: {}",
        renders(cx) - before
    );
    assert_settled(cx, "Home hovered");
    let other = cx.debug_bounds("tmux-sidebar-row-5").unwrap();
    cx.simulate_mouse_move(other.center(), None, Modifiers::none());
    settle_wash();
    animate(&snapshot, cx, 400);
    assert_settled(cx, "moved to another row");
}

/// Showing the sidebar fades it in over 150 ms. Its paint carries the
/// opacity of the frame that drew it, so it is drawn until the fade ends.
#[gpui::test]
fn the_sidebar_is_opaque_after_it_fades_in(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    with_motion(&snapshot, cx);
    for hidden in [true, false] {
        cx.update(|window, cx| {
            snapshot.update(cx, |view, cx| {
                view.sidebar_hidden = hidden;
                cx.notify();
            });
            window.draw(cx).clear(cx);
        });
    }
    // Three frames at once, well inside the 150 ms: each draws the sidebar.
    let renders = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| crate::tmux_snapshot::browser_ui::sidebar_view::renders(cx))
    };
    let before = renders(cx);
    for _ in 0..3 {
        cx.update(|window, cx| {
            snapshot.update(cx, |_, cx| cx.notify());
            window.draw(cx).clear(cx);
        });
    }
    assert_eq!(renders(cx) - before, 3, "replayed while it fades in");
    animate(&snapshot, cx, 400);
    assert_settled(cx, "shown again");
    // Faded in: replayed again.
    let settled = renders(cx);
    cx.update(|window, cx| {
        snapshot.update(cx, |_, cx| cx.notify());
        window.draw(cx).clear(cx);
    });
    assert_eq!(renders(cx), settled, "still drawn after the fade");
}

#[path = "sidebar_key_tests.rs"]
mod key;
