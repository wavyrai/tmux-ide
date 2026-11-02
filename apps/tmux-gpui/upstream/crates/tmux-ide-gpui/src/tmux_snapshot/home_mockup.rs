//! Dev-only Home mockup for card #705 (design round 2). Static fixture data,
//! no daemon, no handlers. Rendered only by `visual_capture` with
//! `<theme>+design-a` or `<theme>+design-b`, plus `+one`, `+fleet` or
//! `+empty` for the data; never in a release build.
//!
//! Every text colour is Home's inked `text` or `text_muted`, never a faded
//! Bezel role, so the 4.5:1 rule holds in all catalog themes.
use bezel_theme::{TextStyle, Theme, Typeset};
use bezel_ui::icons::Icon;
use bezel_ui::widgets::{ButtonStyle, Buttons as _, Content as _, Scaffolding as _, status_dot};
use gpui::{prelude::*, *};
use std::cell::Cell;

const SPACE: f32 = Theme::SPACE;
const NAV_WIDTH: f32 = 232.;
const RAIL_WIDTH: f32 = 300.;

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Variant {
    A,
    B,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Fixture {
    /// The owner's screenshot: Local with p1, p3 and p8, no agents.
    One,
    /// Local and spark, 12 sessions, two agents.
    Fleet,
    /// Local connected, no sessions.
    Empty,
}

thread_local! {
    static ACTIVE: Cell<Option<(Variant, Fixture)>> = const { Cell::new(None) };
}

pub(crate) fn set(active: Option<(Variant, Fixture)>) {
    ACTIVE.with(|cell| cell.set(active));
}

pub(crate) fn active() -> Option<(Variant, Fixture)> {
    ACTIVE.with(Cell::get)
}

#[derive(Clone, Copy, PartialEq)]
enum AgentState {
    Working,
    NeedsInput,
}

struct Agent {
    name: &'static str,
    state: AgentState,
    since: &'static str,
}

struct Session {
    name: &'static str,
    windows: usize,
    panes: usize,
    favourite: bool,
    attached: bool,
    active: &'static str,
    agent: Option<Agent>,
}

struct Machine {
    name: &'static str,
    remote: bool,
    sessions: Vec<Session>,
}

const fn s(name: &'static str, windows: usize, panes: usize, active: &'static str) -> Session {
    Session {
        name,
        windows,
        panes,
        favourite: false,
        attached: false,
        active,
        agent: None,
    }
}

impl Session {
    fn favourite(mut self) -> Self {
        self.favourite = true;
        self
    }
    fn attached(mut self) -> Self {
        self.attached = true;
        self
    }
    fn agent(mut self, name: &'static str, state: AgentState, since: &'static str) -> Self {
        self.agent = Some(Agent { name, state, since });
        self
    }
}

fn fleet(fixture: Fixture) -> Vec<Machine> {
    match fixture {
        Fixture::One => vec![Machine {
            name: "Local",
            remote: false,
            sessions: vec![
                s("p1", 2, 3, "now").attached(),
                s("p3", 1, 1, "12 min ago"),
                s("p8", 3, 5, "2 h ago"),
            ],
        }],
        Fixture::Empty => vec![Machine {
            name: "Local",
            remote: false,
            sessions: Vec::new(),
        }],
        Fixture::Fleet => vec![
            Machine {
                name: "Local",
                remote: false,
                sessions: vec![s("0", 1, 2, "3 h ago")],
            },
            Machine {
                name: "spark",
                remote: true,
                sessions: vec![
                    s("devstack", 3, 3, "now").favourite().attached().agent(
                        "Claude",
                        AgentState::Working,
                        "6 min",
                    ),
                    s("site", 2, 2, "1 min ago").favourite().agent(
                        "Codex",
                        AgentState::NeedsInput,
                        "1 min",
                    ),
                    s("demo", 1, 3, "8 min ago"),
                    s("api", 2, 4, "25 min ago"),
                    s("growth", 1, 1, "1 h ago"),
                    s("lint", 1, 3, "2 h ago"),
                    s("bezel", 2, 2, "3 h ago"),
                    s("docs", 1, 1, "yesterday"),
                    s("infra", 2, 3, "yesterday"),
                    s("notes", 1, 1, "3 days ago"),
                    s("scratch", 1, 1, "last week"),
                ],
            },
        ],
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn icon(path: &'static str) -> Icon {
    Icon::asset(path)
}

fn glyph(path: &'static str, size: f32, color: Hsla) -> Svg {
    bezel_ui::icons::icon(icon(path))
        .size(px(size))
        .flex_none()
        .text_color(color)
}

fn muted(bezel: &Theme, text: impl Into<SharedString>) -> Div {
    div()
        .text_style(TextStyle::Callout)
        .text_color(bezel.text_muted)
        .child(text.into())
}

fn agent_tone(bezel: &Theme, state: AgentState) -> Hsla {
    match state {
        AgentState::Working => bezel.success,
        AgentState::NeedsInput => bezel.warning,
    }
}

fn agent_label(state: AgentState) -> &'static str {
    match state {
        AgentState::Working => "working",
        AgentState::NeedsInput => "needs input",
    }
}

/// The agent in a session as one quiet line: a status dot, the agent and its
/// state. The colour is the dot's; the words stay in Home's inked ink.
fn agent_inline(bezel: &Theme, agent: &Agent) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .flex_none()
        .child(status_dot(agent_tone(bezel, agent.state)))
        .child(
            div()
                .text_style(TextStyle::Callout)
                .text_color(bezel.text)
                .child(agent.name),
        )
        .child(muted(bezel, agent_label(agent.state)))
}

/// The search field that opens the palette, with its ⌘K hint.
fn browse_field(bezel: &Theme, width: f32) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(SPACE))
        .w(px(width))
        .h(px(Theme::BUTTON_HEIGHT + 4.))
        .px(px(SPACE * 1.5))
        .rounded(px(Theme::control_radius()))
        .border_1()
        .border_color(bezel.border)
        .bg(bezel.card_glass_bg())
        .child(glyph("icons/search.svg", 14., bezel.text_muted))
        .child(
            div()
                .flex_1()
                .text_style(TextStyle::Body)
                .text_color(bezel.text_muted)
                .child("Search sessions and agents…"),
        )
        .child(bezel_ui::popover::kbd_hint(bezel, "⌘K").text_color(bezel.text_muted))
}

/// A labelled quiet button: glyph and word, so nothing in the header is an
/// unnamed icon.
fn labelled(bezel: &Theme, path: &'static str, label: &'static str) -> Div {
    bezel
        .button("", ButtonStyle::Ghost, None)
        .gap(px(6.))
        .text_color(bezel.text)
        .child(glyph(path, 14., bezel.text_muted))
        .child(label)
}

fn new_session(bezel: &Theme) -> Div {
    bezel.button("New session", ButtonStyle::Prominent, None)
}

/// The left list as #684 has it, with the counts; `extra` goes under Add
/// machine (Option A puts Appearance there).
fn nav(bezel: &Theme, machines: &[Machine], extra: Option<Div>) -> Div {
    let total: usize = machines.iter().map(|m| m.sessions.len()).sum();
    let favourites = machines
        .iter()
        .flat_map(|m| &m.sessions)
        .filter(|s| s.favourite)
        .count();
    let entry =
        |path: &'static str, label: &'static str, count: usize, selected: bool, dot: bool| {
            div()
                .flex()
                .items_center()
                .gap(px(SPACE))
                .px(px(SPACE))
                .py(px(6.))
                .rounded(px(Theme::control_radius()))
                .when(selected, |row| row.bg(bezel.card_selected_bg()))
                .child(glyph(
                    path,
                    14.,
                    if selected {
                        bezel.text
                    } else {
                        bezel.text_muted
                    },
                ))
                .child(
                    div()
                        .flex_1()
                        .text_style(TextStyle::Body)
                        .text_color(bezel.text)
                        .child(label),
                )
                .when(dot, |row| row.child(status_dot(bezel.success)))
                .child(muted(bezel, count.to_string()))
        };
    let mut list = div()
        .w(px(NAV_WIDTH))
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(entry(
            "icons/sessions.svg",
            "All sessions",
            total,
            true,
            false,
        ))
        .child(entry(
            "icons/fleet-star.svg",
            "Favourites",
            favourites,
            false,
            false,
        ))
        .child(
            div()
                .mt(px(SPACE * 1.5))
                .px(px(SPACE))
                .pb(px(4.))
                .text_style(TextStyle::Subheadline)
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(bezel.text_muted)
                .child("Machines"),
        );
    for machine in machines {
        list = list.child(entry(
            if machine.remote {
                "icons/globe.svg"
            } else {
                "icons/devices.svg"
            },
            machine.name,
            machine.sessions.len(),
            false,
            true,
        ));
    }
    let footer_row = |path: &'static str, label: &'static str| {
        div()
            .flex()
            .items_center()
            .gap(px(SPACE))
            .px(px(SPACE))
            .py(px(6.))
            .child(glyph(path, 13., bezel.text_muted))
            .child(muted(bezel, label))
    };
    list.child(
        div()
            .mt(px(SPACE))
            .child(footer_row("icons/plus.svg", "Add machine…")),
    )
    .children(extra)
}

/// What both options show with no sessions: one centred invitation with the
/// two ways forward, instead of an empty table.
fn empty(bezel: &Theme) -> Div {
    div()
        .w_full()
        .pt(px(SPACE * 8.))
        .flex()
        .flex_col()
        .items_center()
        .gap(px(SPACE * 2.))
        .child(
            bezel
                .empty_state(
                    icon("icons/terminal.svg"),
                    "No sessions on Local yet",
                    "Start one with New session, or add a machine to see its sessions.",
                )
                .py(px(0.))
                .text_color(bezel.text),
        )
        .child(
            bezel
                .button("Add machine…", ButtonStyle::Ghost, None)
                .text_color(bezel.text),
        )
}

// Option A: one calm list ------------------------------------------------

/// Column widths shared by A's labels and rows.
const A_AGENT: f32 = 220.;
const A_LAYOUT: f32 = 150.;
const A_ACTIVE: f32 = 110.;

fn a_columns(bezel: &Theme, agents: bool) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(SPACE * 1.5))
        .px(px(SPACE * 1.5))
        .pb(px(6.))
        .text_style(TextStyle::Caption)
        .text_color(bezel.text_muted)
        .child(div().w(px(14.)))
        .child(div().flex_1().child("Session"))
        .when(agents, |row| row.child(div().w(px(A_AGENT)).child("Agent")))
        .child(div().w(px(A_LAYOUT)).child("Windows"))
        .child(
            div()
                .w(px(A_ACTIVE))
                .flex()
                .justify_end()
                .child("Last active"),
        )
}

/// One 34px row with no rule: the star only on a favourite (hover shows it
/// on the others), the name with "attached", the agent, the layout and when
/// it was last active. `hover` paints the pointer's row.
fn a_row(bezel: &Theme, session: &Session, agents: bool, hover: bool) -> Div {
    div()
        .h(px(34.))
        .flex()
        .items_center()
        .gap(px(SPACE * 1.5))
        .px(px(SPACE * 1.5))
        .rounded(px(Theme::control_radius()))
        .when(hover, |row| row.bg(bezel.element_hover))
        .child(
            div()
                .w(px(14.))
                .flex_none()
                .when(session.favourite, |cell| {
                    cell.child(glyph("icons/fleet-star-filled.svg", 13., bezel.text_muted))
                })
                .when(hover && !session.favourite, |cell| {
                    cell.child(glyph("icons/fleet-star.svg", 13., bezel.text_muted))
                }),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(SPACE))
                .child(bezel.row_title(session.name).text_color(bezel.text))
                .when(session.attached, |cell| {
                    cell.child(bezel.badge("attached").text_color(bezel.text_muted))
                }),
        )
        .when(agents, |row| {
            row.child(
                div().w(px(A_AGENT)).flex_none().children(
                    session
                        .agent
                        .as_ref()
                        .map(|agent| agent_inline(bezel, agent)),
                ),
            )
        })
        .child(div().w(px(A_LAYOUT)).flex_none().child(muted(
            bezel,
            format!(
                "{} · {}",
                plural(session.windows, "window", "windows"),
                plural(session.panes, "pane", "panes")
            ),
        )))
        .child(
            div()
                .w(px(A_ACTIVE))
                .flex_none()
                .flex()
                .justify_end()
                .child(muted(bezel, session.active)),
        )
}

/// A machine as a quiet label over its rows: no box, no rule, no repeated
/// status. A remote machine keeps Disconnect on its label line.
fn a_machine(bezel: &Theme, machine: &Machine, agents: bool, hover_row: Option<usize>) -> Div {
    div()
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(SPACE))
                .px(px(SPACE * 1.5))
                .pt(px(SPACE * 2.))
                .pb(px(4.))
                .child(
                    div()
                        .text_style(TextStyle::Subheadline)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(bezel.text_muted)
                        .child(machine.name),
                )
                .child(div().flex_1())
                .when(machine.remote, |line| {
                    line.child(muted(bezel, "Disconnect"))
                }),
        )
        .children(
            machine
                .sessions
                .iter()
                .enumerate()
                .map(|(i, session)| a_row(bezel, session, agents, hover_row == Some(i))),
        )
}

fn option_a(bezel: &Theme, fixture: Fixture) -> Div {
    let machines = fleet(fixture);
    let attention = machines
        .iter()
        .flat_map(|m| &m.sessions)
        .filter_map(|s| s.agent.as_ref())
        .filter(|a| a.state == AgentState::NeedsInput)
        .count();
    let appearance = div()
        .flex()
        .items_center()
        .gap(px(SPACE))
        .px(px(SPACE))
        .py(px(6.))
        .child(glyph("icons/theme.svg", 13., bezel.text_muted))
        .child(muted(bezel, "Appearance…"));
    let bar = div()
        .flex()
        .items_center()
        .gap(px(SPACE))
        .child(
            div().w(px(NAV_WIDTH)).flex_none().child(
                div()
                    .px(px(SPACE))
                    .text_style(TextStyle::Title3)
                    .text_color(bezel.text)
                    .child("Home"),
            ),
        )
        .child(div().w(px(SPACE * 3.)))
        .child(browse_field(bezel, 420.))
        .when(attention > 0, |bar| {
            bar.child(
                div()
                    .ml(px(SPACE))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(SPACE))
                    .h(px(Theme::BUTTON_HEIGHT))
                    .rounded_full()
                    .bg(bezel.warning.opacity(0.14))
                    .child(status_dot(bezel.warning))
                    .child(
                        div()
                            .text_style(TextStyle::Callout)
                            .text_color(bezel.text)
                            .child(plural(attention, "agent needs input", "agents need input")),
                    ),
            )
        })
        .child(div().flex_1())
        .child(labelled(bezel, "icons/refresh.svg", "Refresh"))
        .child(new_session(bezel));
    let empty_fleet = machines.iter().all(|m| m.sessions.is_empty());
    let several = machines.len() > 1;
    let mut table = div().flex_1().min_w_0().flex().flex_col();
    if empty_fleet {
        table = table.child(empty(bezel));
    } else {
        let agents = machines
            .iter()
            .flat_map(|m| &m.sessions)
            .any(|s| s.agent.is_some());
        table = table.child(a_columns(bezel, agents));
        for (index, machine) in machines.iter().enumerate() {
            // One machine needs no label: the left list already names it.
            let hover = (index == machines.len() - 1).then_some(1);
            table = table.child(if several {
                a_machine(bezel, machine, agents, hover)
            } else {
                div().children(
                    machine
                        .sessions
                        .iter()
                        .enumerate()
                        .map(|(i, s)| a_row(bezel, s, agents, i == 1)),
                )
            });
        }
    }
    div()
        .w_full()
        .max_w(px(1320.))
        .pt(px(SPACE * 3.))
        .px(px(SPACE * 4.))
        .flex()
        .flex_col()
        .gap(px(SPACE * 3.))
        .child(bar)
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(SPACE * 3.))
                .child(nav(bezel, &machines, Some(appearance)))
                .child(table),
        )
}

// Option B: a richer table and an agents rail ---------------------------

/// A two-line row: the name over a meta line (windows, panes, last active),
/// "attached" and the star at the end. No rule; the rows sit in one card.
fn b_row(bezel: &Theme, session: &Session, hover: bool) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(SPACE * 1.5))
        .px(px(SPACE * 1.5))
        .py(px(7.))
        .rounded(px(Theme::control_radius()))
        .when(hover, |row| row.bg(bezel.element_hover))
        .child(glyph("icons/terminal.svg", 15., bezel.text_muted))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(bezel.row_title(session.name).text_color(bezel.text))
                .child(
                    bezel
                        .meta_line(vec![
                            plural(session.windows, "window", "windows").into_any_element(),
                            plural(session.panes, "pane", "panes").into_any_element(),
                            format!("active {}", session.active).into_any_element(),
                        ])
                        .mt(px(1.))
                        .text_color(bezel.text_muted),
                ),
        )
        .children(
            session
                .agent
                .as_ref()
                .map(|agent| agent_inline(bezel, agent)),
        )
        .when(session.attached, |row| {
            row.child(bezel.badge("attached").text_color(bezel.text_muted))
        })
        .child(
            div()
                .w(px(16.))
                .flex_none()
                .when(session.favourite, |cell| {
                    cell.child(glyph("icons/fleet-star-filled.svg", 14., bezel.text_muted))
                })
                .when(hover && !session.favourite, |cell| {
                    cell.child(glyph("icons/fleet-star.svg", 14., bezel.text_muted))
                }),
        )
}

fn b_rail(bezel: &Theme, machines: &[Machine]) -> Div {
    let mut agents: Vec<(&Session, &Agent)> = machines
        .iter()
        .flat_map(|m| &m.sessions)
        .filter_map(|s| s.agent.as_ref().map(|a| (s, a)))
        .collect();
    // Attention first.
    agents.sort_by_key(|(_, a)| a.state != AgentState::NeedsInput);
    let rows = agents.into_iter().map(|(session, agent)| {
        div()
            .flex()
            .items_start()
            .gap(px(SPACE))
            .px(px(SPACE * 1.5))
            .py(px(SPACE))
            .rounded(px(Theme::control_radius()))
            .child(
                div()
                    .pt(px(6.))
                    .child(status_dot(agent_tone(bezel, agent.state))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_style(TextStyle::Body)
                            .text_color(bezel.text)
                            .child(format!("{} · {}", agent.name, agent_label(agent.state))),
                    )
                    .child(muted(
                        bezel,
                        format!("in {} · {}", session.name, agent.since),
                    )),
            )
    });
    div()
        .w(px(RAIL_WIDTH))
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            div()
                .px(px(SPACE * 1.5))
                .pb(px(4.))
                .flex()
                .items_baseline()
                .gap(px(SPACE))
                .child(
                    div()
                        .text_style(TextStyle::Headline)
                        .text_color(bezel.text)
                        .child("Agents"),
                )
                .child(muted(bezel, "2 running")),
        )
        .children(rows)
}

fn option_b(bezel: &Theme, fixture: Fixture) -> Div {
    let machines = fleet(fixture);
    let has_agents = machines
        .iter()
        .flat_map(|m| &m.sessions)
        .any(|s| s.agent.is_some());
    let total: usize = machines.iter().map(|m| m.sessions.len()).sum();
    let bar = div()
        .flex()
        .items_center()
        .gap(px(SPACE))
        .child(browse_field(bezel, 360.))
        .child(div().flex_1())
        .child(labelled(bezel, "icons/refresh.svg", "Refresh"))
        .child(labelled(bezel, "icons/theme.svg", "Theme"))
        .child(div().w(px(SPACE * 0.5)))
        .child(new_session(bezel));
    let several = machines.len() > 1;
    let body = if total == 0 {
        empty(bezel)
    } else {
        let mut card = bezel.group_box().p(px(4.)).gap(px(1.));
        for (index, machine) in machines.iter().enumerate() {
            if several {
                card = card.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(SPACE))
                        .px(px(SPACE * 1.5))
                        .pt(px(if index == 0 { SPACE } else { SPACE * 2. }))
                        .pb(px(4.))
                        .child(
                            div()
                                .text_style(TextStyle::Subheadline)
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(bezel.text_muted)
                                .child(machine.name),
                        )
                        .child(div().flex_1())
                        .when(machine.remote, |line| {
                            line.child(muted(bezel, "Disconnect"))
                        }),
                );
            }
            let hover = (index == machines.len() - 1).then_some(1);
            card = card.children(
                machine
                    .sessions
                    .iter()
                    .enumerate()
                    .map(|(i, s)| b_row(bezel, s, hover == Some(i))),
            );
        }
        card
    };
    let detail = div()
        .flex_1()
        .min_w_0()
        .flex()
        .items_start()
        .gap(px(SPACE * 3.))
        .child(div().flex_1().min_w_0().child(body))
        .when(has_agents, |detail| detail.child(b_rail(bezel, &machines)));
    let footnote = (!has_agents && total > 0).then(|| {
        muted(
            bezel,
            "No agents running. Agents you start in a session show beside it.",
        )
        .pt(px(SPACE * 1.5))
        .px(px(SPACE * 1.5))
    });
    div()
        .w_full()
        .max_w(px(1320.))
        .pt(px(SPACE * 3.))
        .px(px(SPACE * 4.))
        .flex()
        .flex_col()
        .gap(px(SPACE * 3.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(SPACE * 3.))
                .child(
                    div()
                        .w(px(NAV_WIDTH))
                        .flex_none()
                        .px(px(SPACE))
                        .flex()
                        .items_baseline()
                        .gap(px(SPACE))
                        .child(
                            div()
                                .text_style(TextStyle::Title3)
                                .text_color(bezel.text)
                                .child("Home"),
                        ),
                )
                .child(div().flex_1().child(bar)),
        )
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(SPACE * 3.))
                .child(nav(bezel, &machines, None))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(detail)
                        .children(footnote),
                ),
        )
}

pub(crate) fn render(
    (variant, fixture): (Variant, Fixture),
    bezel: &Theme,
    canvas: u32,
    focus: &FocusHandle,
) -> AnyElement {
    let body = match variant {
        Variant::A => option_a(bezel, fixture),
        Variant::B => option_b(bezel, fixture),
    };
    div()
        .id("tmux-home")
        .track_focus(focus)
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .items_center()
        .bg(rgb(canvas))
        .text_color(bezel.text)
        .text_style(TextStyle::Body)
        .child(body)
        .into_any_element()
}
