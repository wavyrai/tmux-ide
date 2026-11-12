//! The sidebar drawn by the window root, replayed while unchanged: it must
//! paint exactly what a fresh render would after every kind of change, and
//! a terminal publication alone must not render it again.
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
    let (sender, receiver) = mpsc::sync_channel(64);
    std::mem::forget(receiver);
    let (host, cx) = cx.add_window_view(|window, cx| {
        let snapshot =
            cx.new(|cx| fit_test_support::fixture_view(window, cx, sender, 7, workspace(8)));
        let content = agent_spinner::window_root(snapshot.clone(), window, cx).into();
        Host { snapshot, content }
    });
    cx.simulate_resize(size(px(1000.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let snapshot = host.read_with(cx, |host, _| host.snapshot.clone());
    (snapshot, cx)
}

/// What the frame painted over the sidebar's slot, as comparable quads and
/// underlines. Only the sidebar: Home's own entrances differ frame to frame.
fn painted(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> String {
    cx.update(|window, cx| {
        let Some(slot) = snapshot.read(cx).sidebar_slot.bounds.get() else {
            return "no sidebar".into();
        };
        let scale = window.scale_factor();
        let slot = slot.scale(scale);
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
    let cached = painted(snapshot, cx);
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(
        painted(snapshot, cx) == cached,
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
