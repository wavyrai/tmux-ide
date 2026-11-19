//! The guide's Machines step (onboarding phase 2): this Mac first, then each
//! saved machine with its live status; add one by `user@host` or a Host
//! suggested from the SSH config. Adding goes through the add-machine path
//! Commands → Connect to machine… uses (`Selection::Machine`), so saving
//! and connecting stay what they are there. A machine ssh can't reach says
//! why in ssh's own words, stays saved, and can be tried again. Nothing
//! here asks whether a machine is local or remote.
use super::guide::{Act as GuideAct, Kind, slot};
use super::render::Stop;
use super::*;
use crate::search_input::SearchInput;
use bezel_theme::{TextStyle, Typeset as _};
use bezel_ui::widgets::{ButtonStyle, Scaffolding as _, Status as _};
use std::path::PathBuf;

pub(super) const MACHINES_TITLE: &str = "Your machines";
pub(super) const MACHINES_LEDE: &str = "Add a machine you reach with SSH and its sessions and agents appear in Home and the sidebar next to this Mac's.";
pub(super) const PLACEHOLDER: &str = "user@host, or a Host from your SSH config";
pub(super) const NEEDS_SERVICE: &str =
    "Machines need the background service. Go back to Set up to start it.";
pub(super) const CHECKING: &str = "Checking your saved machines…";
pub(super) const INVALID: &str =
    "Enter an SSH alias or user@host. Configure ports and keys in SSH config.";
pub(super) const UNSENT: &str = "Couldn't start connecting. Try again.";
pub(super) const SUGGESTED: &str = "From your SSH config:";
pub(super) const FOOTNOTE: &str = "Tmux IDE uses your own SSH keys and config. You can add machines later from Commands: Connect to machine…";
pub(super) const SKIP_FOR_NOW: &str = "Skip for now";

/// An add this guide started: the target, and the saved list's revision
/// when it was sent, to tell "still saving" from "saving failed".
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) struct Attempt {
    pub target: String,
    pub revision: u64,
}

/// What the step keeps while the guide is open.
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Machines {
    pub field: Option<Entity<SearchInput>>,
    pub error: Option<&'static str>,
    pub attempt: Option<Attempt>,
    /// Host suggestions: `None` until read.
    pub hosts: Option<Vec<String>>,
    /// The home directory whose `.ssh/config` suggests Hosts; set only by
    /// the app at launch, so tests never read the user's own.
    pub home: Option<PathBuf>,
    reading: bool,
    asked: bool,
}

/// Whether machines can be added now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Service {
    /// No background service: nothing to save machines with.
    Down,
    /// The saved list hasn't been read yet.
    Loading,
    Ready,
}
pub(super) fn service(state: &browser::State, connected: bool) -> Service {
    if !connected || matches!(stage(state, connected), Stage::Setup(_)) {
        return Service::Down;
    }
    match &state.machines {
        Some(registry) if registry.available || registry.error.is_some() => Service::Ready,
        _ => Service::Loading,
    }
}

/// One machine as the step lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Row {
    pub label: String,
    pub detail: String,
    pub status: String,
    pub mark: Mark,
    /// Why it couldn't connect, in a line the user reads; with `retry`,
    /// the target Try again connects to.
    pub problem: Option<String>,
    pub retry: Option<String>,
}

pub(super) fn sessions(count: usize) -> String {
    if count == 1 {
        "1 session".into()
    } else {
        format!("{count} sessions")
    }
}

/// This Mac, then every saved machine in the saved order, then an add
/// that hasn't reached the saved list.
pub(super) fn rows(state: &browser::State, connected: bool, attempt: Option<&Attempt>) -> Vec<Row> {
    let groups = state.fleet.as_ref().map_or(&[][..], |f| &f.groups[..]);
    let count = |g: &browser::fleet::Group| g.sessions.len() + g.omitted_sessions as usize;
    let here = |status: String, mark| Row {
        label: "This Mac".into(),
        detail: "Here".into(),
        status,
        mark,
        problem: None,
        retry: None,
    };
    let mut rows = vec![match groups.iter().find(|g| g.id == "local") {
        Some(g) if g.state == browser::fleet::Phase::Ready => here(sessions(count(g)), Mark::Done),
        Some(_) => here("Connecting…".into(), Mark::Running),
        None => match stage(state, connected) {
            Stage::Ready { sessions: n } => here(sessions(n), Mark::Done),
            Stage::Setup(_) => here("Not set up".into(), Mark::Problem),
            Stage::Waiting => here("Checking…".into(), Mark::Pending),
        },
    }];
    let saved = state.machines.as_ref().map_or(&[][..], |r| &r.machines[..]);
    for profile in saved {
        let group = groups.iter().find(|g| g.id == profile.id);
        let said = state
            .ssh_failure
            .as_ref()
            .filter(|f| f.machine == profile.id)
            .map(|f| f.said.clone());
        // This guide's own add, now the machine Home shows, that stopped.
        let stopped = attempt.is_some_and(|a| a.target == profile.ssh_target)
            && state.surface == browser::Surface::Home
            && state.home_phase == browser::HomePhase::Unavailable;
        let ready = group.filter(|g| g.state == browser::fleet::Phase::Ready && !g.conflict);
        let failed = group
            .is_some_and(|g| g.conflict || g.state == browser::fleet::Phase::Disconnected)
            || said.is_some()
            || stopped;
        let row = |status: &str, mark| Row {
            label: profile.label.clone(),
            detail: profile.ssh_target.clone(),
            status: status.into(),
            mark,
            problem: None,
            retry: None,
        };
        rows.push(if !profile.enabled {
            row("Turned off", Mark::Pending)
        } else if let Some(g) = ready {
            row(&format!("Connected · {}", sessions(count(g))), Mark::Done)
        } else if failed {
            let conflict = group.is_some_and(|g| g.conflict);
            Row {
                problem: Some(problem(
                    &profile.label,
                    &profile.ssh_target,
                    said.as_deref(),
                    conflict,
                )),
                retry: Some(profile.ssh_target.clone()),
                ..row("Couldn't connect", Mark::Problem)
            }
        } else if group.is_some() || attempt.is_some_and(|a| a.target == profile.ssh_target) {
            row("Connecting…", Mark::Running)
        } else {
            row("Saved", Mark::Pending)
        });
    }
    if let Some(attempt) = attempt
        && !saved.iter().any(|p| p.ssh_target == attempt.target)
    {
        let registry = state.machines.as_ref();
        let answered = registry.is_some_and(|r| !r.pending && r.revision > attempt.revision);
        rows.push(Row {
            label: attempt.target.clone(),
            detail: attempt.target.clone(),
            status: if answered { "Not saved" } else { "Saving…" }.into(),
            mark: if answered {
                Mark::Problem
            } else {
                Mark::Running
            },
            problem: answered.then(|| {
                registry
                    .and_then(|r| r.error.clone())
                    .unwrap_or_else(|| format!("{} wasn't saved. Try again.", attempt.target))
            }),
            retry: answered.then(|| attempt.target.clone()),
        });
    }
    rows
}

/// A failure in plain words: ssh's own reason when it gave one.
pub(super) fn problem(label: &str, target: &str, said: Option<&str>, conflict: bool) -> String {
    if conflict {
        return format!(
            "{label}: a different machine answered. Check its SSH settings, then try again. The machine stays saved."
        );
    }
    match said {
        Some(said) => {
            let end = if said.ends_with('.') { "" } else { "." };
            format!("{label}: ssh said: {said}{end} The machine stays saved.")
        }
        None => format!(
            "{label}: couldn't connect. Check that ssh {target} works in Terminal, then try again. The machine stays saved."
        ),
    }
}

/// The suggestions to show: not already saved, at most `slot::MANY`.
pub(super) fn chips(hosts: &[String], state: &browser::State) -> Vec<String> {
    let saved = state.machines.as_ref().map_or(&[][..], |r| &r.machines[..]);
    hosts
        .iter()
        .filter(|h| !saved.iter().any(|p| &p.ssh_target == *h))
        .take(slot::MANY)
        .cloned()
        .collect()
}

impl SnapshotView {
    /// The add-machine path, as Commands → Connect to machine… takes it.
    pub(super) fn machines_connect(
        &mut self,
        target: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let connected = self.browser_commands.is_some();
        if service(&self.browser_state, connected) != Service::Ready || !self.presence.ready() {
            return;
        }
        let Some(target) = super::super::picker::ssh_target(&target) else {
            self.welcome.guide.machines.error = Some(INVALID);
            cx.notify();
            return;
        };
        let revision = self
            .browser_state
            .machines
            .as_ref()
            .map_or(0, |r| r.revision);
        let before = self.browser_request;
        self.select(Selection::Machine(Some(target.clone())), window, cx);
        let machines = &mut self.welcome.guide.machines;
        if self.browser_request == before {
            machines.error = Some(UNSENT);
            return;
        }
        machines.error = None;
        machines.attempt = Some(Attempt { target, revision });
    }
    pub(super) fn machines_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(field) = self.welcome.guide.machines.field.clone() else {
            return;
        };
        if field.read(cx).is_composing() {
            return;
        }
        let text = field.read(cx).text().to_owned();
        self.machines_connect(text, window, cx);
        if self.welcome.guide.machines.error.is_none() {
            field.update(cx, |input, cx| input.set_text_selected("", cx));
        }
    }
    /// Reads the SSH config's Hosts once, off the UI thread, and the saved
    /// list when nothing has read it yet.
    fn machines_prepare(&mut self, cx: &mut Context<Self>) {
        let machines = &mut self.welcome.guide.machines;
        if machines.hosts.is_none() && !machines.reading {
            if let Some(home) = machines.home.clone() {
                machines.reading = true;
                let task = cx
                    .background_executor()
                    .spawn(async move { ssh_hosts::hosts(&ssh_hosts::ssh_dir(&home), &home) });
                cx.spawn(async move |view, cx| {
                    let hosts = task.await;
                    let _ = view.update(cx, |view, cx| {
                        view.welcome.guide.machines.hosts = Some(hosts);
                        cx.notify();
                    });
                })
                .detach();
            } else {
                machines.hosts = Some(Vec::new());
            }
        }
        let unread = self
            .browser_state
            .machines
            .as_ref()
            .is_none_or(|r| !r.available && !r.pending && r.error.is_none());
        if unread && !self.welcome.guide.machines.asked {
            self.welcome.guide.machines.asked = true;
            if let Some(sender) = &self.browser_commands {
                let _ = sender.try_send(browser::Command::Machines {
                    request: self.browser_request,
                    operation: browser::machines::Operation::Read,
                });
            }
        }
    }
    fn machines_field(&mut self, cx: &mut Context<Self>) -> Entity<SearchInput> {
        if let Some(field) = &self.welcome.guide.machines.field {
            return field.clone();
        }
        let theme = self.theme();
        let field = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(255);
            input.set_placeholder(PLACEHOLDER, cx);
            input.set_appearance(crate::config::Config::default().ui, theme, cx);
            input
        });
        // The field's own focus is the step's keyboard stop.
        self.welcome.focus[slot::FIELD] = field.read(cx).focus.clone();
        self.welcome.guide.machines.field = Some(field.clone());
        field
    }

    pub(super) fn machines_body(
        &mut self,
        bezel: &bezel_theme::Theme,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> (AnyElement, Vec<Stop>, Option<usize>) {
        self.machines_prepare(cx);
        let connected = self.browser_commands.is_some();
        let service = service(&self.browser_state, connected);
        let ready = service == Service::Ready;
        let attempt = self.welcome.guide.machines.attempt.clone();
        let rows = rows(&self.browser_state, connected, attempt.as_ref());
        let mut stops: Vec<Stop> = Vec::new();
        let list = rows.iter().enumerate().map(|(index, row)| {
            div()
                .id(("welcome-machine", index))
                .debug_selector(move || format!("welcome-machine-{index}"))
                .role(Role::ListItem)
                .aria_label(format!("{}: {}", row.label, row.status))
                .aria_description(row.detail.clone())
                .w_full()
                .px(px(16.))
                .py(px(10.))
                .flex()
                .items_center()
                .gap(px(12.))
                .when(index > 0, |r| {
                    r.border_t_1().border_color(bezel.border_faint)
                })
                .child(render::mark(row.mark, bezel))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_color(bezel.text)
                                .truncate()
                                .child(row.label.clone()),
                        )
                        .when(row.detail != row.label, |d| {
                            d.child(
                                div()
                                    .text_style(TextStyle::Callout)
                                    .text_color(bezel.text_muted)
                                    .truncate()
                                    .child(row.detail.clone()),
                            )
                        }),
                )
                .child(
                    div()
                        .flex_none()
                        .text_style(TextStyle::Callout)
                        .text_color(bezel.text_muted)
                        .child(row.status.clone()),
                )
        });
        let list = bezel
            .group_box()
            .id("welcome-machines")
            .debug_selector(|| "welcome-machines".into())
            .role(Role::List)
            .aria_label("Machines")
            .w_full()
            .p_0()
            .gap_0()
            .children(list);
        let field = self.machines_field(cx);
        let field_ring = bezel.ring;
        if ready {
            stops.push((slot::FIELD, Act::Guide(GuideAct::Add), Kind::Field));
            stops.push((slot::ADD, Act::Guide(GuideAct::Add), Kind::Press));
        }
        let add = self.guide_button(
            slot::ADD,
            "welcome-machine-add",
            "Add",
            Act::Guide(GuideAct::Add),
            ButtonStyle::Ghost,
            ready,
            bezel,
            cx,
        );
        let form = div()
            .id("welcome-machine-form")
            .w_full()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .id("welcome-machine-field")
                    .debug_selector(|| "welcome-machine-field".into())
                    .role(Role::TextInput)
                    .aria_label("Machine to add")
                    .flex_1()
                    .min_w_0()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(transparent_black())
                    .when(field.read(cx).focus.is_focused(window), |d| {
                        d.border_color(field_ring)
                    })
                    .when(!ready, |d| d.opacity(0.6))
                    .child(field),
            )
            .child(add);
        let hosts = self
            .welcome
            .guide
            .machines
            .hosts
            .clone()
            .unwrap_or_default();
        let chips = chips(&hosts, &self.browser_state);
        let chip_row = (!chips.is_empty()).then(|| {
            let mut row = div()
                .id("welcome-machine-chips")
                .debug_selector(|| "welcome-machine-chips".into())
                .role(Role::Group)
                .aria_label("From your SSH config")
                .w_full()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .text_style(TextStyle::Callout)
                        .text_color(bezel.text_muted)
                        .child(SUGGESTED),
                );
            for (index, host) in chips.iter().enumerate() {
                let act = Act::Guide(GuideAct::Connect(host.clone()));
                if ready {
                    stops.push((slot::CHIP + index, act.clone(), Kind::Press));
                }
                let selector: &'static str = CHIP_SELECTORS[index];
                row = row.child(self.guide_button(
                    slot::CHIP + index,
                    selector,
                    host,
                    act,
                    ButtonStyle::Ghost,
                    ready,
                    bezel,
                    cx,
                ));
            }
            row
        });
        let problems = rows
            .iter()
            .filter_map(|r| r.problem.clone().map(|p| (p, r.retry.clone())))
            .take(slot::MANY)
            .enumerate()
            .map(|(index, (problem, retry))| {
                let copy = Act::Guide(GuideAct::Copy(problem.clone()));
                stops.push((slot::COPY + index, copy.clone(), Kind::Press));
                let copy = self.guide_button(
                    slot::COPY + index,
                    COPY_SELECTORS[index],
                    "Copy details",
                    copy,
                    ButtonStyle::Ghost,
                    true,
                    bezel,
                    cx,
                );
                let retry = retry.map(|target| {
                    let act = Act::Guide(GuideAct::Connect(target));
                    if ready {
                        stops.push((slot::RETRY + index, act.clone(), Kind::Press));
                    }
                    self.guide_button(
                        slot::RETRY + index,
                        RETRY_SELECTORS[index],
                        "Try again",
                        act,
                        ButtonStyle::Ghost,
                        ready,
                        bezel,
                        cx,
                    )
                });
                div()
                    .id(("welcome-machine-problem", index))
                    .debug_selector(move || format!("welcome-machine-problem-{index}"))
                    .role(Role::Alert)
                    .aria_label(problem.clone())
                    .w_full()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        bezel
                            .warning_strip(crate::notifications::safe_text(&problem, 480))
                            .text_color(bezel.warning_muted)
                            .w_full(),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(8.))
                            .child(copy)
                            .children(retry),
                    )
            })
            .collect::<Vec<_>>();
        let message = match service {
            Service::Down => Some(NEEDS_SERVICE),
            Service::Loading => Some(CHECKING),
            Service::Ready => self.welcome.guide.machines.error,
        };
        let registry_note = self
            .browser_state
            .machines
            .as_ref()
            .and_then(|r| r.message.clone().or_else(|| r.error.clone()))
            .filter(|_| ready);
        let body = div()
            .w_full()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(list)
            .child(form)
            .children(message.map(|m| {
                div()
                    .debug_selector(|| "welcome-machine-message".into())
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .child(m)
            }))
            .children(registry_note.map(|m| {
                bezel
                    .warning_strip(crate::notifications::safe_text(&m, 240))
                    .text_color(bezel.warning_muted)
                    .w_full()
            }))
            .children(chip_row)
            .children(problems)
            .child(
                div()
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .child(FOOTNOTE),
            )
            .into_any_element();
        let start = if ready { slot::FIELD } else { slot::NEXT };
        (body, stops, Some(start))
    }
    /// Continue's words on this step: Skip for now until a machine is saved.
    pub(super) fn machines_next_label(&self) -> &'static str {
        let saved = self
            .browser_state
            .machines
            .as_ref()
            .is_some_and(|r| !r.machines.is_empty());
        if saved || self.welcome.guide.machines.attempt.is_some() {
            "Continue"
        } else {
            SKIP_FOR_NOW
        }
    }
}

/// The capture example's Machines: this Mac with three sessions, spark
/// connected, build-box refused by ssh.
#[cfg(feature = "visual-capture")]
pub(in crate::tmux_snapshot) fn capture(state: &mut browser::State) -> Result<()> {
    const SPARK: &str = "6840aaaa-0000-4000-8000-000000000001";
    const BUILD: &str = "6840aaaa-0000-4000-8000-000000000002";
    let profile = |id: &str, target: &str| {
        serde_json::json!({"id": id, "label": target, "sshTarget": target,
            "expectedEnvironmentId": null, "enabled": true})
    };
    state.machines = Some(serde_json::from_value(serde_json::json!({
        "revision": 1, "available": true, "pending": false, "error": null, "message": null,
        "machines": [profile(SPARK, "spark"), profile(BUILD, "build-box")],
    }))?);
    let session =
        |id: &str, name: &str| serde_json::json!({"id": id, "name": name, "paneCount": 2});
    let group = |id: &str, label: &str, state: &str, sessions: Vec<serde_json::Value>| {
        serde_json::json!({"id": id, "label": label, "state": state, "conflict": false,
            "omittedSessions": 0, "sessions": sessions})
    };
    state.fleet = Some(serde_json::from_value(serde_json::json!({
        "omittedGroups": 0,
        "groups": [
            group("local", "This Mac", "ready", vec![session("l1", "api"), session("l2", "web"), session("l3", "notes")]),
            group(SPARK, "spark", "ready", vec![session("s1", "train"), session("s2", "logs")]),
            group(BUILD, "build-box", "disconnected", vec![]),
        ],
    }))?);
    state.ssh_failure = Some(browser::SshFailure {
        machine: BUILD.into(),
        said: "Permission denied (publickey).".into(),
    });
    Ok(())
}

const CHIP_SELECTORS: [&str; slot::MANY] = [
    "welcome-host-0",
    "welcome-host-1",
    "welcome-host-2",
    "welcome-host-3",
    "welcome-host-4",
    "welcome-host-5",
    "welcome-host-6",
    "welcome-host-7",
];
const RETRY_SELECTORS: [&str; slot::MANY] = [
    "welcome-retry-0",
    "welcome-retry-1",
    "welcome-retry-2",
    "welcome-retry-3",
    "welcome-retry-4",
    "welcome-retry-5",
    "welcome-retry-6",
    "welcome-retry-7",
];
const COPY_SELECTORS: [&str; slot::MANY] = [
    "welcome-copy-0",
    "welcome-copy-1",
    "welcome-copy-2",
    "welcome-copy-3",
    "welcome-copy-4",
    "welcome-copy-5",
    "welcome-copy-6",
    "welcome-copy-7",
];
