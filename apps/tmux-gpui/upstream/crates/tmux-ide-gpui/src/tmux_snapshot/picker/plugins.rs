//! Plugin commands in the app: F5 → "Plugin commands…" lists the plugin
//! half of the local daemon's command catalog. A command with parameters
//! becomes a step-by-step form in the same picker (the search line is the
//! input, the rows are the choices); a dangerous command always ends with an
//! explicit "Run …" / "Cancel" step. Plugin text is shown as plain text only.
//!
//! Daemon calls are blocking HTTP, so they run on the background executor;
//! results come back through `generation` so a stale answer is ignored.
use super::{Mode, Row, SnapshotView, Target as PickerTarget};
use gpui::*;
use herdr_client::tmux_daemon::{
    ArgValue, Choice, InvokeContext, LocalConfigNamespace, LocalDaemon, ParamKind, ParamOptions,
    PluginCommand, PluginOutcome, PluginParam, tmux_pane_id,
};
use std::path::PathBuf;
use std::sync::OnceLock;

static LOCAL_RECORD: OnceLock<PathBuf> = OnceLock::new();

/// The daemon record the app was started with, when it was given explicitly.
pub(in crate::tmux_snapshot) fn remember_local_record(record: &std::path::Path) {
    let _ = LOCAL_RECORD.set(record.to_path_buf());
}

fn local_daemon() -> Option<LocalDaemon> {
    // Unit tests never reach a real daemon, whatever is installed on the machine.
    if cfg!(test) {
        return None;
    }
    let record = LOCAL_RECORD.get().cloned().or_else(|| {
        LocalConfigNamespace::capture(None).and_then(|namespace| namespace.daemon_record())
    })?;
    LocalDaemon::discover(&record).ok()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Target {
    Command(String),
    Submit,
    Choice(String),
    Bool(bool),
    Skip,
    Run,
    Cancel,
    /// A status line; choosing it does nothing.
    Info,
}

enum Phase {
    Loading,
    Ready,
    Failed(String),
}

enum Options {
    Loading,
    Ready(ParamOptions),
    Failed(String),
}

struct Form {
    command: PluginCommand,
    step: usize,
    values: Vec<(String, ArgValue)>,
    options: Option<Options>,
}

pub(in crate::tmux_snapshot) struct Session {
    /// Where the palette was opened: the plugin's `ctx.session` and `ctx.pane`.
    context: InvokeContext,
    phase: Phase,
    commands: Vec<PluginCommand>,
    form: Option<Form>,
    note: Option<String>,
    generation: u64,
}

impl Session {
    fn new(context: InvokeContext) -> Self {
        Self {
            context,
            phase: Phase::Loading,
            commands: Vec::new(),
            form: None,
            note: None,
            generation: 0,
        }
    }
    fn param(&self) -> Option<&PluginParam> {
        let form = self.form.as_ref()?;
        form.command.params.get(form.step)
    }
}

fn row(target: Target, label: impl Into<String>) -> Row {
    Row {
        target: PickerTarget::Plugin(target),
        label: label.into(),
    }
}

fn matches(label: &str, query: &str) -> bool {
    let label = label.to_lowercase();
    query
        .to_lowercase()
        .split_whitespace()
        .all(|term| label.contains(term))
}

/// The picker rows for the current state and search text.
pub(super) fn rows(session: &Session, query: &str) -> Vec<Row> {
    let mut out = Vec::new();
    if let Some(note) = &session.note {
        out.push(row(Target::Info, note.clone()));
    }
    let Some(form) = &session.form else {
        match &session.phase {
            Phase::Loading => out.push(row(Target::Info, "Loading plugin commands…")),
            Phase::Failed(message) => out.push(row(Target::Info, message.clone())),
            Phase::Ready if session.commands.is_empty() => out.push(row(
                Target::Info,
                "No plugin commands. Add plugins in ~/.tmux-ide/plugins and allow them with `tmux-ide plugin consent`.",
            )),
            Phase::Ready => {
                for command in &session.commands {
                    let suffix = if command.params.is_empty() && !command.dangerous {
                        ""
                    } else {
                        "…"
                    };
                    let label = format!(
                        "{}{suffix} · {} · {} plugin",
                        command.label, command.category, command.plugin
                    );
                    if matches(&label, query) {
                        out.push(row(Target::Command(command.id.clone()), label));
                    }
                }
            }
        }
        return out;
    };
    let Some(param) = session.param() else {
        // Cancel comes first and is selected: a held Return never runs it.
        out.push(row(Target::Cancel, "Cancel"));
        out.push(row(Target::Run, format!("Run {}", form.command.label)));
        return out;
    };
    let step = format!(
        "{} ({}/{})",
        param.label,
        form.step + 1,
        form.command.params.len()
    );
    let (choices, fallback) = match &form.options {
        Some(Options::Loading) => {
            out.push(row(Target::Info, format!("{step} · Loading choices…")));
            return out;
        }
        Some(Options::Failed(message)) => {
            out.push(row(Target::Info, format!("{step} · {message}")));
            (param.choices.clone(), param.default.clone())
        }
        Some(Options::Ready(options)) => (
            options
                .choices
                .clone()
                .unwrap_or_else(|| param.choices.clone()),
            options.default.clone().or_else(|| param.default.clone()),
        ),
        None => (param.choices.clone(), param.default.clone()),
    };
    match param.kind {
        ParamKind::Choice => {
            for Choice { value, label } in choices {
                let is_default = fallback == Some(ArgValue::Text(value.clone()));
                let label = format!(
                    "{step} · {label}{}",
                    if is_default { " (default)" } else { "" }
                );
                if matches(&label, query) {
                    out.push(row(Target::Choice(value), label));
                }
            }
        }
        ParamKind::Boolean => {
            for flag in [true, false] {
                let is_default = fallback == Some(ArgValue::Bool(flag));
                out.push(row(
                    Target::Bool(flag),
                    format!(
                        "{step} · {}{}",
                        if flag { "Yes" } else { "No" },
                        if is_default { " (default)" } else { "" }
                    ),
                ));
            }
        }
        ParamKind::String | ParamKind::Text | ParamKind::Number => {
            let label = if !query.is_empty() {
                format!(
                    "{step} · Use “{}”",
                    query.chars().take(200).collect::<String>()
                )
            } else if let Some(value) = &fallback {
                format!("{step} · Use default “{}”", value.display())
            } else {
                format!("{step} · Type the value above, then press Return")
            };
            out.push(row(Target::Submit, label));
        }
    }
    if !param.required {
        out.push(row(Target::Skip, format!("{step} · Leave empty")));
    }
    out
}

impl SnapshotView {
    /// F5 → "Plugin commands…".
    pub(super) fn open_plugin_commands(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let context = self.plugin_context();
        self.open_picker_mode(Mode::Plugins, window, cx);
        let Some(picker) = self.picker.as_mut().filter(|p| p.mode == Mode::Plugins) else {
            return;
        };
        picker.plugins = Some(Session::new(context));
        self.load_plugin_commands(cx);
        self.refresh_picker(cx);
    }

    /// The focused session (its tmux name) and, when the app knows one, the
    /// focused pane's tmux id (`%N`). The app's panes carry the daemon's
    /// semantic ids, so `ctx.pane` is usually absent here.
    pub(super) fn plugin_context(&self) -> InvokeContext {
        let state = &self.browser_state;
        let session = state
            .selected_session
            .as_ref()
            .and_then(|id| state.sessions.iter().find(|choice| &choice.id == id))
            .map(|choice| choice.label.clone());
        let pane = state
            .selected_pane
            .clone()
            .filter(|pane| tmux_pane_id(pane));
        InvokeContext { session, pane }
    }

    fn plugin_session(&mut self) -> Option<&mut Session> {
        self.picker
            .as_mut()
            .filter(|p| p.mode == Mode::Plugins)
            .and_then(|p| p.plugins.as_mut())
    }

    fn load_plugin_commands(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.plugin_session() else {
            return;
        };
        session.generation += 1;
        let generation = session.generation;
        let task = cx.background_executor().spawn(async move {
            local_daemon()
                .ok_or("No local tmux-ide daemon is running.")
                .and_then(|daemon| {
                    daemon
                        .plugin_commands()
                        .map_err(|_| "Plugin commands are unavailable from this daemon.")
                })
        });
        cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                if let Some(session) = view.plugin_session().filter(|s| s.generation == generation)
                {
                    match result {
                        Ok(commands) => {
                            session.commands = commands;
                            session.phase = Phase::Ready;
                        }
                        Err(message) => session.phase = Phase::Failed(message.into()),
                    }
                }
                view.refresh_picker(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn clear_plugin_search(&mut self, cx: &mut Context<Self>) {
        if let Some(picker) = self.picker.as_mut() {
            picker.selected = 0;
            picker
                .search
                .update(cx, |input, cx| input.set_text_selected("", cx));
        }
    }

    /// Enter the form's current step, or finish the form.
    fn enter_plugin_step(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.plugin_session() else {
            return;
        };
        let Some(form) = session.form.as_mut() else {
            return;
        };
        if form.step >= form.command.params.len() && !form.command.dangerous {
            let command = form.command.clone();
            let values = std::mem::take(&mut form.values);
            self.run_plugin_command(command, values, false, window, cx);
            return;
        }
        form.options = None;
        let fetch = form
            .command
            .params
            .get(form.step)
            .filter(|p| p.dynamic_choices || p.dynamic_default)
            .map(|p| (form.command.id.clone(), p.name.clone()));
        if let Some((id, name)) = fetch {
            form.options = Some(Options::Loading);
            session.generation += 1;
            let generation = session.generation;
            let context = session.context.clone();
            let task = cx.background_executor().spawn(async move {
                local_daemon()
                    .ok_or_else(|| "No local tmux-ide daemon is running.".to_owned())
                    .and_then(|daemon| {
                        daemon
                            .plugin_param_options(&id, &name, &context)
                            .map_err(|_| "Choices are unavailable.".to_owned())
                    })
            });
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    if let Some(form) = view
                        .plugin_session()
                        .filter(|s| s.generation == generation)
                        .and_then(|s| s.form.as_mut())
                    {
                        form.options = Some(match result {
                            Ok(PluginOutcome::Ok(options)) => Options::Ready(options),
                            Ok(PluginOutcome::Failed(message)) | Err(message) => {
                                Options::Failed(message)
                            }
                        });
                    }
                    view.refresh_picker(cx);
                    cx.notify();
                });
            })
            .detach();
        }
        self.clear_plugin_search(cx);
        self.refresh_picker(cx);
        cx.notify();
    }

    fn advance_plugin_form(
        &mut self,
        value: Option<ArgValue>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(form) = self.plugin_session().and_then(|s| s.form.as_mut()) else {
            return;
        };
        let Some(param) = form.command.params.get(form.step) else {
            return;
        };
        let name = param.name.clone();
        form.values.retain(|(existing, _)| existing != &name);
        if let Some(value) = value {
            form.values.push((name, value));
        }
        form.step += 1;
        self.enter_plugin_step(window, cx);
    }

    /// Run the command and keep the palette open: its first row reports
    /// "Running …" and then the outcome, where VoiceOver reads it too.
    fn run_plugin_command(
        &mut self,
        command: PluginCommand,
        values: Vec<(String, ArgValue)>,
        confirmed: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if command.dangerous && !confirmed {
            return;
        }
        let label = command.label.clone();
        let mut context = InvokeContext::default();
        if let Some(session) = self.plugin_session() {
            session.form = None;
            session.note = Some(format!("Running {label}…"));
            context = session.context.clone();
        }
        self.clear_plugin_search(cx);
        self.refresh_picker(cx);
        let task = cx.background_executor().spawn(async move {
            let daemon = local_daemon().ok_or("No local tmux-ide daemon is running.")?;
            daemon
                .invoke_plugin_command(&command.id, &values, &context, confirmed)
                .map_err(|_| "The daemon did not run the command.")
        });
        cx.spawn(async move |view, cx| {
            let note = match task.await {
                Ok(PluginOutcome::Ok(Some(value))) => format!("{label}: {value}"),
                Ok(PluginOutcome::Ok(None)) => format!("{label}: done"),
                Ok(PluginOutcome::Failed(message)) => format!("{label}: {message}"),
                Err(message) => format!("{label}: {message}"),
            };
            let _ = view.update(cx, |view, cx| {
                if let Some(session) = view.plugin_session() {
                    session.note = Some(note);
                }
                view.refresh_picker(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// A plugin row was chosen.
    pub(super) fn choose_plugin(
        &mut self,
        target: Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let query = self
            .picker
            .as_ref()
            .map(|p| p.search.read(cx).text().to_owned())
            .unwrap_or_default();
        let Some(session) = self.plugin_session() else {
            return;
        };
        session.note = None;
        match target {
            Target::Info => {}
            Target::Command(id) => {
                let Some(command) = session.commands.iter().find(|c| c.id == id).cloned() else {
                    return;
                };
                if command.params.is_empty() && !command.dangerous {
                    self.run_plugin_command(command, Vec::new(), false, window, cx);
                    return;
                }
                session.form = Some(Form {
                    command,
                    step: 0,
                    values: Vec::new(),
                    options: None,
                });
                self.enter_plugin_step(window, cx);
            }
            Target::Run => {
                let Some(form) = session.form.take() else {
                    return;
                };
                self.run_plugin_command(form.command, form.values, true, window, cx);
            }
            Target::Cancel => {
                session.form = None;
                session.note = Some("Cancelled.".into());
                self.clear_plugin_search(cx);
                self.refresh_picker(cx);
            }
            Target::Skip => self.advance_plugin_form(None, window, cx),
            Target::Bool(flag) => self.advance_plugin_form(Some(ArgValue::Bool(flag)), window, cx),
            Target::Choice(value) => {
                self.advance_plugin_form(Some(ArgValue::Text(value)), window, cx)
            }
            Target::Submit => {
                let Some(param) = session.param().cloned() else {
                    return;
                };
                let fallback = match session.form.as_ref().and_then(|f| f.options.as_ref()) {
                    Some(Options::Ready(options)) => options.default.clone(),
                    _ => None,
                }
                .or(param.default.clone());
                let value = if query.is_empty() {
                    fallback
                } else if param.kind == ParamKind::Number {
                    match query.trim().parse::<f64>() {
                        Ok(number) if number.is_finite() => Some(ArgValue::Number(number)),
                        _ => {
                            session.note = Some(format!("{} must be a number", param.label));
                            self.refresh_picker(cx);
                            cx.notify();
                            return;
                        }
                    }
                } else {
                    Some(ArgValue::Text(query))
                };
                match value {
                    Some(ArgValue::Text(text)) if text.is_empty() && param.required => {
                        session.note = Some(format!("{} is required", param.label));
                    }
                    None if param.required => {
                        session.note = Some(format!("{} is required", param.label));
                    }
                    value => {
                        self.advance_plugin_form(value, window, cx);
                        return;
                    }
                }
                self.refresh_picker(cx);
            }
        }
        cx.notify();
    }
}

#[cfg(test)]
#[path = "plugins_tests.rs"]
mod tests;
