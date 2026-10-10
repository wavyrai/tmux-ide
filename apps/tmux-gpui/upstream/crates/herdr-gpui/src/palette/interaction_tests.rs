#![allow(clippy::unwrap_used)]

use super::*;
use core::prelude::v1::test;
use gpui::TestAppContext;
use std::sync::Arc;

#[gpui::test]
fn one_palette_combines_navigation_actions_commands_and_projects(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot
                .commands
                .push(herdr_client::protocol::ClientShellCommand {
                    command_id: "build".into(),
                    action: ClientShellCommandAction::Shell,
                    description: Some("Build project".into()),
                    binding_label: String::new(),
                    binding_labels: Vec::new(),
                });
            view.open_palette(Filter::All, window, cx);
            let mut palette = view.menu.palette.take().unwrap();
            palette.projects.projects.push(projects::Project {
                path: "/projects/herdr".into(),
                label: "herdr".into(),
            });
            // And a note on the fixture's checkout, for the Notes filter.
            let mut notes = crate::worktree_notes::Notes::default();
            notes.set(
                crate::worktree_notes::Checkout {
                    endpoint: crate::endpoint::LOCAL.into(),
                    repo_key: "repo/main".into(),
                    branch: "main".into(),
                },
                "release blocker",
            );
            view.prepare_palette_entries(&mut palette, Some(&notes));
            view.menu.palette = Some(palette);
            view.rank_palette(Selection::Keep, cx);
            for filter in Filter::ALL {
                view.set_palette_filter(filter, cx);
                let palette = view.menu.palette.as_ref().unwrap();
                assert!(!palette.filtered.is_empty());
                assert!(
                    palette
                        .filtered
                        .iter()
                        .all(|hit| filter.accepts(&palette.entries[hit.index].action))
                );
            }
            view.set_palette_filter(Filter::All, cx);
            view.filter_palette("build", cx);
            let palette = view.menu.palette.as_ref().unwrap();
            assert!(matches!(
                palette.selected_entry().unwrap().action,
                Action::Configured(..)
            ));
            view.filter_palette("projects herdr", cx);
            let palette = view.menu.palette.as_ref().unwrap();
            assert!(matches!(
                palette.selected_entry().unwrap().action,
                Action::Project(_)
            ));
        })
    });
}

#[gpui::test]
fn metadata_refresh_preserves_selection_and_command_invocation_context(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_palette(Filter::All, window, cx);
            view.filter_palette("Settings", cx);
            let palette = view.menu.palette.as_ref().unwrap();
            let selected = palette.selected_identity();
            let captured = palette.target.as_ref().unwrap().workspace.clone();
            Arc::make_mut(view.live.snapshot.as_mut().unwrap()).focused_workspace_id = None;
            view.refresh_palette(window, cx);
            let palette = view.menu.palette.as_ref().unwrap();
            assert_eq!(palette.selected_identity(), selected);
            assert_eq!(palette.target.as_ref().unwrap().workspace, captured);
            assert_eq!(palette.query, "Settings");
        })
    });
}

#[gpui::test]
fn project_loading_is_incremental_and_config_changes_rescan_without_losing_query(
    cx: &mut TestAppContext,
) {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("herdr")).unwrap();
    let other = tempfile::tempdir().unwrap();
    std::fs::create_dir(other.path().join("herdr-next")).unwrap();
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.config.palette.project_roots = vec![root.path().to_string_lossy().into_owned()];
            view.open_palette(Filter::All, window, cx);
            let palette = view.menu.palette.as_ref().unwrap();
            assert!(palette.loading_projects);
            assert!(
                palette
                    .entries
                    .iter()
                    .any(|entry| matches!(entry.action, Action::Native(_)))
            );
            view.filter_palette("herdr", cx);
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let palette = view.menu.palette.as_ref().unwrap();
        assert!(!palette.loading_projects);
        assert_eq!(palette.projects.projects.len(), 1);
        assert_eq!(palette.projects.projects[0].label, "herdr");
        assert_eq!(palette.query, "herdr");
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.config.palette.project_roots = vec![other.path().to_string_lossy().into_owned()];
            view.refresh_palette(window, cx);
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let palette = view.menu.palette.as_ref().unwrap();
        assert_eq!(palette.projects.projects[0].label, "herdr-next");
        assert_eq!(palette.query, "herdr");
    });
}

#[gpui::test]
fn a_closed_palettes_scan_cannot_fill_a_reopened_palette(cx: &mut TestAppContext) {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("old-project")).unwrap();
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.config.palette.project_roots = vec![root.path().to_string_lossy().into_owned()];
            view.open_palette(Filter::All, window, cx);
            view.dismiss_menu(window, cx);
            view.config.palette.project_roots.clear();
            view.open_palette(Filter::Commands, window, cx);
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let palette = view.menu.palette.as_ref().unwrap();
        assert!(palette.projects.projects.is_empty());
        assert!(!palette.loading_projects);
        assert_eq!(palette.filter, Filter::Commands);
    });
}

#[gpui::test]
fn native_search_input_owns_text_and_filter_navigation(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.open_palette(Filter::All, window, cx));
        window.draw(cx).clear(cx);
    });
    cx.simulate_input("Settings");
    cx.simulate_keystrokes("tab");
    view.read_with(cx, |view, cx| {
        let palette = view.menu.palette.as_ref().unwrap();
        assert_eq!(palette.search.read(cx).text(), "Settings");
        assert_eq!(palette.filter, Filter::Navigation);
        assert!(view.marked.is_empty());
    });
    cx.simulate_keystrokes("shift-tab");
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| assert!(view.menu.palette.is_none()));
}

#[gpui::test]
fn narrow_layout_keeps_filters_and_long_result_rows_inside_the_window(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    for (width, height) in [(360., 420.), (900., 700.)] {
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                Arc::make_mut(view.live.snapshot.as_mut().unwrap()).workspaces[0].label =
                    "a very long workspace label ".repeat(20);
                view.open_palette(Filter::Navigation, window, cx);
            });
            window.draw(cx).clear(cx);
        });
        for selector in ["palette-row-0", "palette-filter-projects", "palette-status"] {
            let bounds = cx.debug_bounds(selector).unwrap();
            assert!(
                bounds.left() >= px(0.) && bounds.right() <= px(width),
                "{selector}: {bounds:?}"
            );
            assert!(
                bounds.top() >= px(0.) && bounds.bottom() <= px(height),
                "{selector}: {bounds:?}"
            );
        }
    }
}

#[gpui::test]
fn composition_does_not_activate_or_dismiss_the_palette(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_palette(Filter::All, window, cx);
            let search = view.menu.palette.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "設定", Some(2..2), window, cx)
            });
            for key in ["enter", "escape", "tab"] {
                view.palette_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                    },
                    window,
                    cx,
                );
                assert!(view.menu.palette.is_some());
                assert_eq!(view.menu.palette.as_ref().unwrap().filter, Filter::All);
            }
            assert!(view.marked.is_empty());
            search.update(cx, |input, cx| input.unmark_text(window, cx));
            view.palette_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("escape").unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                window,
                cx,
            );
            assert!(view.menu.palette.is_none());
        })
    });
}
