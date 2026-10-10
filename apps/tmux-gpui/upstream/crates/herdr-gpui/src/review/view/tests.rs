#![allow(clippy::unwrap_used)]
// Not `super::*`: it brings in `gpui::test`, which `#[test]` would then name.
use super::{Agent, HerdrWindow, Loaded, State, pick_agent};
use crate::browser::TabId;
use crate::review::diff::{Diff, RowId};

/// The window's one review tab.
fn the(view: &HerdrWindow) -> TabId {
    *view.reviews.keys().next().unwrap()
}
use gpui::Entity;
use herdr_client::protocol::ClientShellSnapshot;
use std::{collections::HashMap, sync::Arc};

fn snapshot(value: serde_json::Value) -> ClientShellSnapshot {
    serde_json::from_value(value).unwrap()
}

fn agent(pane: &str, workspace: &str, label: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "pane_id": pane, "workspace_id": workspace, "tab_id": "t0", "name": null,
        "display_agent": label, "agent": null, "title": null,
        "terminal_title": null, "terminal_title_stripped": null,
        "agent_status": "idle", "state_change_seq": 0, "state_labels": [],
        "tokens": [], "focused": false
    })
}

fn base(focused_pane: Option<&str>, agents: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({
        "boot_id": "b", "revision": 1, "config_diagnostic": null,
        "product_announcement": null, "update_available": null,
        "update_install_command": "", "server_keybindings_toml": null,
        "latest_release_notes_available": false, "integration_updates_available": false,
        "worktree_directory": "", "release_notes": null,
        "focused_workspace_id": "w1", "focused_tab_id": null,
        "focused_pane_id": focused_pane, "tab_bar_right": [],
        "tab_bar_right_separator": "", "agent_view_label": null, "agent_order": [],
        "workspaces": [], "tabs": [], "panes": [], "agents": agents, "commands": []
    })
}

/// The fixture window, its workspace `w0` focused, with an agent in pane
/// `w0:p1` when `status` is given.
fn window<'a>(
    cx: &'a mut gpui::TestAppContext,
    status: Option<&str>,
) -> (Entity<HerdrWindow>, &'a mut gpui::VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut shown = serde_json::to_value(crate::sidebar::layout_tests::snapshot(2)).unwrap();
        shown["focused_workspace_id"] = "w0".into();
        shown["focused_pane_id"] = "w0:p1".into();
        shown["panes"] = serde_json::json!([{
            "pane_id": "w0:p1", "workspace_id": "w0", "tab_id": "t0", "label": null,
            "cwd": null, "foreground_cwd": null, "focused": true,
            "right_click_passthrough": false
        }]);
        shown["agents"] = match status {
            Some(status) => {
                let mut found = agent("w0:p1", "w0", Some("Claude Code"));
                found["agent_status"] = status.into();
                serde_json::json!([found])
            }
            None => serde_json::json!([]),
        };
        view.live.snapshot = Some(Arc::new(snapshot(shown)));
        view
    })
}

/// One file's change, read: its hunk header (line 0), an unchanged line
/// (1), a removed line (2) and the added line that replaced it (3).
fn changes() -> Loaded {
    Loaded::of(Diff::parse(
        "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n fn a() {}\n-fn b() {}\n+fn b() { todo!() }\n",
    ))
}

/// Line `line` of the first file.
fn line(line: usize) -> RowId {
    RowId::Line { file: 0, line }
}

/// Writes `comment` on diff row `row`, the way a click and typing would.
fn note(view: &Entity<HerdrWindow>, cx: &mut gpui::VisualTestContext, row: RowId, comment: &str) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.begin_review_note(the(view), row, window, cx);
            let input = view.reviews.values().next().unwrap().input.clone();
            input.update(cx, |input, cx| input.set_text_selected(comment, cx));
            view.add_review_note(the(view), window, cx);
        });
    });
}

fn kept(cx: &mut gpui::VisualTestContext) -> Option<String> {
    cx.update(|_, cx| {
        cx.default_global::<crate::browser::Feedback>()
            .take("w0:p1")
    })
}

#[gpui::test]
fn notes_on_lines_reach_the_agent_that_made_the_changes(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, Some("working"));
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(changes(), window, cx)));
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    // Hunk headers take no notes; an empty note is refused.
    note(&view, cx, line(0), "ignored");
    note(&view, cx, line(3), "   ");
    note(&view, cx, line(3), "Implement this");
    note(&view, cx, RowId::Header(0), "Add a test");
    view.read_with(cx, |view, _| {
        let review = view.reviews.values().next().unwrap();
        assert_eq!(review.notes.len(), 2);
        assert_eq!(
            review.marks,
            HashMap::from([(line(3), 1), (RowId::Header(0), 2)])
        );
        assert!(review.draft.is_none());
    });
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    // Every row spans the list, whatever its text, so tints line up.
    let file = cx.debug_bounds("review-header-0").unwrap();
    let added = cx.debug_bounds("review-line-0-3").unwrap();
    assert_eq!(file.size.width, added.size.width);
    assert!(file.size.width > gpui::px(400.));

    // The agent is working: the notes wait for it, and the queue is
    // emptied at once so Send cannot repeat them.
    cx.update(|_, cx| view.update(cx, |view, cx| view.send_review(the(view), cx)));
    view.read_with(cx, |view, _| {
        assert_eq!(view.deliveries.len(), 1);
        assert!(view.menu.page.is_none());
        assert!(view.reviews.values().next().unwrap().notes.is_empty());
    });
    cx.update(|_, cx| view.update(cx, |view, cx| view.poll_deliveries(cx)));
    assert_eq!(view.read_with(cx, |view, _| view.deliveries.len()), 1);

    // This fixture has no connection, so the paste fails once the agent
    // waits and the notes are kept for `browser feedback` instead.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let mut shown = (*view.live.snapshot.clone().unwrap()).clone();
            shown.agents[0].agent_status = herdr_client::protocol::AgentStatus::Idle;
            view.live.snapshot = Some(Arc::new(shown));
            view.poll_deliveries(cx);
        });
    });
    let text = kept(cx).unwrap();
    assert!(text.starts_with("Review notes on your changes in /work/repo"));
    assert!(text.contains(
        "\n1. On `src/lib.rs:2` (added line)\n   Code: `fn b() { todo!() }`\n   Note: Implement this\n"
    ), "{text}");
    assert!(
        text.contains("\n2. On `src/lib.rs` as a whole\n   Note: Add a test\n"),
        "{text}"
    );
}

#[gpui::test]
fn without_an_agent_the_notes_are_copied(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(changes(), window, cx)));
    note(&view, cx, line(2), "Why remove this?");
    cx.update(|_, cx| view.update(cx, |view, cx| view.send_review(the(view), cx)));
    let copied = cx
        .update(|_, cx| cx.read_from_clipboard())
        .and_then(|item| item.text());
    assert!(copied.is_some_and(|text| text.contains("`src/lib.rs:2` (removed line")));
    assert!(kept(cx).is_none());
}

#[gpui::test]
fn a_stale_load_never_replaces_a_newer_one(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(changes(), window, cx);
            view.review_loaded(the(view), 0, Err(crate::Error::GitWorker));
            let review = view.reviews.values().next().unwrap();
            assert!(review.loaded().is_some());
            view.review_loaded(the(view), 1, Err(crate::Error::GitWorker));
            let review = view.reviews.values().next().unwrap();
            assert!(matches!(review.state, State::Failed(_)));
        });
    });
}

#[test]
fn notes_go_to_the_focused_agent_or_the_workspace_s_first() {
    let agents = vec![
        agent("w0:p1", "w0", Some("Codex")),
        agent("w1:p1", "w1", Some("Claude Code")),
        agent("w1:p2", "w1", Some("Pi")),
    ];
    let focused = pick_agent(&snapshot(base(Some("w1:p2"), agents.clone()))).unwrap();
    assert_eq!(
        focused,
        Agent {
            pane_id: "w1:p2".into(),
            label: "Pi".into()
        }
    );
    // A focused shell falls back to the workspace's agent, never
    // another workspace's.
    let fallback = pick_agent(&snapshot(base(Some("w1:p9"), agents))).unwrap();
    assert_eq!(fallback.pane_id, "w1:p1");
    let unnamed = pick_agent(&snapshot(base(None, vec![agent("w1:p3", "w1", None)])));
    assert_eq!(unnamed.unwrap().label, "the agent");
    assert!(pick_agent(&snapshot(base(None, vec![agent("w0:p1", "w0", None)]))).is_none());
}

mod colours;
mod files;
mod find_again;
mod keys;
mod layout;
mod loading;
mod resize;
mod scale;
mod scope;
mod scrollbar;
mod search;
mod selection;
mod split_resize;
mod tab;
mod wrap;
