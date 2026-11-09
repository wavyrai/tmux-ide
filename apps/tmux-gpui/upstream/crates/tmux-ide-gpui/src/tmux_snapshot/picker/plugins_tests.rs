#![allow(clippy::unwrap_used)]
// Not `use super::*`: that brings gpui's `test` macro, which shadows #[test].
use super::{Form, Options, Phase, Row, Session, Target, rows};
use crate::tmux_snapshot::picker::Target as PickerTarget;
use herdr_client::tmux_daemon::{
    ArgValue, Choice, ParamKind, ParamOptions, PluginCommand, PluginParam,
};

fn param(name: &str, kind: ParamKind) -> PluginParam {
    PluginParam {
        name: name.into(),
        kind,
        label: name.into(),
        description: None,
        required: true,
        default: None,
        dynamic_default: false,
        choices: Vec::new(),
        dynamic_choices: false,
    }
}

fn command(id: &str, label: &str, dangerous: bool, params: Vec<PluginParam>) -> PluginCommand {
    PluginCommand {
        id: id.into(),
        label: label.into(),
        category: "Tasks".into(),
        plugin: "tasks".into(),
        dangerous,
        params,
    }
}

fn labels(rows: &[Row]) -> Vec<String> {
    rows.iter().map(|row| row.label.clone()).collect()
}

fn targets(rows: &[Row]) -> Vec<Target> {
    rows.iter()
        .map(|row| match &row.target {
            PickerTarget::Plugin(target) => target.clone(),
            other => panic!("not a plugin row: {other:?}"),
        })
        .collect()
}

fn ready(commands: Vec<PluginCommand>) -> Session {
    Session {
        context: Default::default(),
        phase: Phase::Ready,
        commands,
        form: None,
        note: None,
        generation: 1,
    }
}

fn in_form(command: PluginCommand, step: usize, options: Option<Options>) -> Session {
    let mut session = ready(vec![command.clone()]);
    session.form = Some(Form {
        command,
        step,
        values: Vec::new(),
        options,
    });
    session
}

#[test]
fn lists_commands_with_category_and_plugin_and_filters_them() {
    let session = ready(vec![
        command(
            "plugin.tasks.new",
            "New task",
            false,
            vec![param("name", ParamKind::String)],
        ),
        command("plugin.tasks.sync", "Sync", false, vec![]),
        command("plugin.tasks.rm", "Remove task", true, vec![]),
    ]);
    assert_eq!(
        labels(&rows(&session, "")),
        vec![
            "New task… · Tasks · tasks plugin",
            "Sync · Tasks · tasks plugin",
            "Remove task… · Tasks · tasks plugin",
        ]
    );
    assert_eq!(
        targets(&rows(&session, "remove")),
        vec![Target::Command("plugin.tasks.rm".into())]
    );
}

#[test]
fn says_what_is_happening_when_there_is_nothing_to_choose() {
    let mut session = Session::new(Default::default());
    assert_eq!(
        labels(&rows(&session, "")),
        vec!["Loading plugin commands…"]
    );
    session.phase = Phase::Failed("No local tmux-ide daemon is running.".into());
    assert_eq!(targets(&rows(&session, "")), vec![Target::Info]);
    let empty = ready(vec![]);
    assert!(labels(&rows(&empty, ""))[0].starts_with("No plugin commands."));
    let mut noted = ready(vec![command("plugin.a.b", "B", false, vec![])]);
    noted.note = Some("B: done".into());
    assert_eq!(targets(&rows(&noted, ""))[0], Target::Info);
}

#[test]
fn a_text_step_uses_the_search_line_as_input() {
    let mut name = param("name", ParamKind::String);
    name.label = "Branch name".into();
    let session = in_form(
        command("plugin.t.new", "New", false, vec![name.clone()]),
        0,
        None,
    );
    assert_eq!(
        labels(&rows(&session, "")),
        vec!["Branch name (1/1) · Type the value above, then press Return"]
    );
    assert_eq!(
        labels(&rows(&session, "fix-login")),
        vec!["Branch name (1/1) · Use “fix-login”"]
    );
    name.default = Some(ArgValue::Text("main".into()));
    name.required = false;
    let session = in_form(command("plugin.t.new", "New", false, vec![name]), 0, None);
    assert_eq!(
        targets(&rows(&session, "")),
        vec![Target::Submit, Target::Skip],
    );
    assert_eq!(
        labels(&rows(&session, ""))[0],
        "Branch name (1/1) · Use default “main”"
    );
}

#[test]
fn choice_and_boolean_steps_list_their_options_and_mark_the_default() {
    let mut agent = param("agent", ParamKind::Choice);
    agent.choices = vec![
        Choice {
            value: "claude".into(),
            label: "Claude".into(),
        },
        Choice {
            value: "codex".into(),
            label: "Codex".into(),
        },
    ];
    agent.default = Some(ArgValue::Text("codex".into()));
    let mut draft = param("draft", ParamKind::Boolean);
    draft.default = Some(ArgValue::Bool(false));
    let cmd = command("plugin.t.new", "New", false, vec![agent, draft]);
    let first = in_form(cmd.clone(), 0, None);
    assert_eq!(
        labels(&rows(&first, "")),
        vec!["agent (1/2) · Claude", "agent (1/2) · Codex (default)"]
    );
    assert_eq!(
        targets(&rows(&first, "cod")),
        vec![Target::Choice("codex".into())]
    );
    let second = in_form(cmd, 1, None);
    assert_eq!(
        labels(&rows(&second, "")),
        vec!["draft (2/2) · Yes", "draft (2/2) · No (default)"]
    );
}

#[test]
fn dynamic_choices_show_loading_then_the_plugins_answer() {
    let mut task = param("task", ParamKind::Choice);
    task.dynamic_choices = true;
    let cmd = command("plugin.t.merge", "Merge", false, vec![task]);
    let loading = in_form(cmd.clone(), 0, Some(Options::Loading));
    assert_eq!(targets(&rows(&loading, "")), vec![Target::Info]);
    let ready = in_form(
        cmd.clone(),
        0,
        Some(Options::Ready(ParamOptions {
            choices: Some(vec![Choice {
                value: "a".into(),
                label: "A".into(),
            }]),
            default: Some(ArgValue::Text("a".into())),
        })),
    );
    assert_eq!(labels(&rows(&ready, "")), vec!["task (1/1) · A (default)"]);
    let failed = in_form(
        cmd,
        0,
        Some(Options::Failed("Choices are unavailable.".into())),
    );
    assert_eq!(
        labels(&rows(&failed, ""))[0],
        "task (1/1) · Choices are unavailable."
    );
}

#[test]
fn a_dangerous_command_ends_with_an_explicit_cancel_or_run() {
    let session = in_form(command("plugin.t.rm", "Remove task", true, vec![]), 0, None);
    // Cancel is first, so it is what Return chooses unless the person moves.
    assert_eq!(
        targets(&rows(&session, "")),
        vec![Target::Cancel, Target::Run]
    );
    assert_eq!(
        labels(&rows(&session, "")),
        vec!["Cancel", "Run Remove task"]
    );
    // The search text cannot hide or replace the confirmation rows.
    assert_eq!(
        targets(&rows(&session, "anything")),
        vec![Target::Cancel, Target::Run]
    );
}

mod keyboard {
    use super::super::{Mode, Session, Target};
    use super::{command, param, ready};
    use crate::tmux_snapshot::fit_test_support::key_down;
    use crate::tmux_snapshot::picker::tests::make_view;
    use core::prelude::v1::test;
    use gpui::TestAppContext;
    use herdr_client::tmux_daemon::{InvokeContext, ParamKind};
    use std::sync::mpsc;

    fn labels(view: &crate::tmux_snapshot::SnapshotView) -> Vec<String> {
        view.picker
            .as_ref()
            .unwrap()
            .rows
            .iter()
            .map(|row| row.label.clone())
            .collect()
    }

    /// Opens "Plugin commands" with a fixed catalog instead of asking a daemon.
    fn open(
        cx: &mut TestAppContext,
        session: Session,
    ) -> (
        gpui::Entity<crate::tmux_snapshot::SnapshotView>,
        &mut gpui::VisualTestContext,
    ) {
        let (sender, _receiver) = mpsc::sync_channel(64);
        std::mem::forget(_receiver);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.open_picker_mode(Mode::Plugins, window, cx);
                view.picker.as_mut().unwrap().plugins = Some(session);
                view.refresh_picker(cx);
            })
        });
        (view, cx)
    }

    #[gpui::test]
    fn f5_lists_plugin_commands(cx: &mut TestAppContext) {
        let (sender, _receiver) = mpsc::sync_channel(64);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        view.read_with(cx, |view, _| assert!(view.picker.is_none()));
        let rows = super::super::super::commands::command_rows_with_settings(
            &Default::default(),
            "plugin",
            false,
            false,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Plugin commands…");
        let _ = cx;
    }

    #[gpui::test]
    fn a_dangerous_command_runs_only_after_return_on_run(cx: &mut TestAppContext) {
        let (view, cx) = open(
            cx,
            ready(vec![command("plugin.t.rm", "Remove task", true, vec![])]),
        );
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                // Return on the command opens the confirm step; nothing runs yet.
                view.picker_key(&key_down("enter"), window, cx);
                assert_eq!(labels(view), vec!["Cancel", "Run Remove task"]);
                // Return on the selected Cancel: back to the list, nothing ran.
                view.picker_key(&key_down("enter"), window, cx);
                assert_eq!(labels(view)[0], "Cancelled.");
                assert!(
                    labels(view)
                        .iter()
                        .all(|label| !label.starts_with("Running"))
                );
            })
        });
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                let rows = labels(view);
                let index = rows
                    .iter()
                    .position(|l| l.starts_with("Remove task"))
                    .unwrap();
                view.picker.as_mut().unwrap().selected = index;
                // Return, Down to Run, Return.
                view.picker_key(&key_down("enter"), window, cx);
                view.picker_key(&key_down("down"), window, cx);
                view.picker_key(&key_down("enter"), window, cx);
                assert_eq!(labels(view)[0], "Running Remove task…");
            })
        });
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            // Unit tests have no daemon, so the run reports that, in the palette.
            assert_eq!(
                labels(view)[..1],
                ["Remove task: No local tmux-ide daemon is running."]
            );
        });
    }

    /// Review D1: one held Return opened the confirm step and its key repeat
    /// chose "Run". Repeats are ignored, and Cancel is selected anyway.
    #[gpui::test]
    fn a_held_return_never_runs_a_dangerous_command(cx: &mut TestAppContext) {
        let (view, cx) = open(
            cx,
            ready(vec![command("plugin.t.rm", "Remove task", true, vec![])]),
        );
        let held = gpui::KeyDownEvent {
            is_held: true,
            ..key_down("enter")
        };
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.picker_key(&key_down("enter"), window, cx);
                assert_eq!(labels(view), vec!["Cancel", "Run Remove task"]);
                for _ in 0..5 {
                    view.picker_key(&held, window, cx);
                }
                // Still at the confirm step: the repeats chose nothing.
                assert_eq!(labels(view), vec!["Cancel", "Run Remove task"]);
                // Even a repeat with Run selected does not run it.
                view.picker_key(&key_down("down"), window, cx);
                view.picker_key(&held, window, cx);
                assert_eq!(labels(view), vec!["Cancel", "Run Remove task"]);
                assert_eq!(view.picker.as_ref().unwrap().mode, Mode::Plugins);
            })
        });
    }

    /// The palette passes where it was opened: the focused session's name,
    /// and the pane only when the app has its tmux id.
    #[gpui::test]
    fn the_context_is_the_focused_session_and_a_tmux_pane(cx: &mut TestAppContext) {
        let (view, cx) = open(cx, ready(vec![]));
        let choice = |id: &str, label: &str| crate::tmux_snapshot::browser::Choice {
            pane_count: None,
            id: id.into(),
            label: label.into(),
            window_id: None,
            window_label: None,
            browser_icon: None,
        };
        cx.update(|_, cx| {
            view.update(cx, |view, _| {
                let state = &mut view.browser_state;
                state.sessions = vec![choice("uuid-1", "demo"), choice("uuid-2", "other")];
                state.selected_session = Some("uuid-1".into());
                state.selected_pane = Some("pane.aaaaaaaaaaaaaaaaaaaa".into());
                assert_eq!(
                    view.plugin_context(),
                    InvokeContext {
                        session: Some("demo".into()),
                        pane: None
                    }
                );
                view.browser_state.selected_pane = Some("%7".into());
                assert_eq!(
                    view.plugin_context(),
                    InvokeContext {
                        session: Some("demo".into()),
                        pane: Some("%7".into())
                    }
                );
                view.browser_state.selected_session = None;
                assert_eq!(view.plugin_context().session, None);
            })
        });
    }

    #[gpui::test]
    fn a_text_parameter_is_typed_into_the_search_line(cx: &mut TestAppContext) {
        let mut name = param("name", ParamKind::String);
        name.label = "Branch name".into();
        let (view, cx) = open(
            cx,
            ready(vec![command("plugin.t.new", "New task", false, vec![name])]),
        );
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.picker_key(&key_down("enter"), window, cx)
            })
        });
        // Return with nothing typed and no default: required, the step stays.
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.picker_key(&key_down("enter"), window, cx)
            })
        });
        view.read_with(cx, |view, _| {
            let rows = labels(view);
            assert_eq!(rows[0], "Branch name is required");
            assert_eq!(
                rows[1],
                "Branch name (1/1) · Type the value above, then press Return"
            );
        });
        cx.simulate_input("fix-login");
        view.read_with(cx, |view, _| {
            assert_eq!(
                labels(view).last().unwrap(),
                "Branch name (1/1) · Use “fix-login”"
            );
        });
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                let last = view.picker.as_ref().unwrap().rows.len() - 1;
                view.picker.as_mut().unwrap().selected = last;
                view.picker_key(&key_down("enter"), window, cx);
                assert_eq!(labels(view)[0], "Running New task…");
            })
        });
    }

    #[gpui::test]
    fn status_rows_are_not_actions(cx: &mut TestAppContext) {
        let mut session = ready(vec![]);
        session.note = Some("B: done".into());
        let (view, cx) = open(cx, session);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                assert!(!super::super::super::current(
                    &view.browser_state,
                    &crate::tmux_snapshot::picker::Target::Plugin(Target::Info)
                ));
                view.picker_key(&key_down("enter"), window, cx);
                assert_eq!(view.picker.as_ref().unwrap().mode, Mode::Plugins);
            })
        });
    }
}
