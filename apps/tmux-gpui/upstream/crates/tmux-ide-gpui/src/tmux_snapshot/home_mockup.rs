//! Dev-only Home redesign mockup for card #684 (design step). Static fixture
//! data, no daemon, no handlers. Rendered only by `visual_capture` with
//! `<theme>+mockup-a` or `<theme>+mockup-b`; never in a release build.
use bezel_theme::{TextStyle, Theme, Typeset};
use bezel_ui::icons::Icon;
use bezel_ui::widgets::{ButtonStyle, Buttons as _, Scaffolding as _, status_dot};
use gpui::{prelude::*, *};
use std::cell::Cell;

const SPACE: f32 = Theme::SPACE;

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Variant {
    A,
    B,
}

thread_local! {
    static ACTIVE: Cell<Option<Variant>> = const { Cell::new(None) };
}

pub(crate) fn set(variant: Option<Variant>) {
    ACTIVE.with(|active| active.set(variant));
}

pub(crate) fn active() -> Option<Variant> {
    ACTIVE.with(Cell::get)
}

struct Session {
    name: &'static str,
    panes: usize,
    favourite: bool,
    attached: bool,
}

struct Machine {
    name: &'static str,
    remote: bool,
    server: &'static str,
    sessions: Vec<Session>,
}

const fn s(name: &'static str, panes: usize, favourite: bool, attached: bool) -> Session {
    Session {
        name,
        panes,
        favourite,
        attached,
    }
}

fn fleet() -> Vec<Machine> {
    vec![
        Machine {
            name: "Local",
            remote: false,
            server: "default",
            sessions: vec![s("0", 2, false, true)],
        },
        Machine {
            name: "spark",
            remote: true,
            server: "default",
            sessions: vec![
                s("demo", 3, false, false),
                s("devstack", 3, true, true),
                s("growth", 1, false, false),
                s("lint", 3, false, false),
                s("site", 2, true, false),
                s("api", 4, false, false),
                s("bezel", 2, false, false),
                s("docs", 1, false, false),
                s("infra", 3, false, false),
                s("notes", 1, false, false),
                s("scratch", 1, false, false),
            ],
        },
    ]
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

fn panes(n: usize) -> String {
    crate::plural::count(n, "pane", "panes")
}

/// The search field that stands in for "Browse sessions": it opens the
/// palette, so it reads as one and carries the ⌘K hint.
fn browse_field(bezel: &Theme, width: Option<f32>) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(SPACE))
        .h(px(Theme::BUTTON_HEIGHT + 4.))
        .px(px(SPACE * 1.5))
        .rounded(px(Theme::control_radius()))
        .border_1()
        .border_color(bezel.border)
        .bg(bezel.card_glass_bg())
        .when_some(width, |field, w| field.w(px(w)))
        .when(width.is_none(), |field| field.flex_1())
        .child(glyph("icons/search.svg", 14., bezel.text_muted))
        .child(
            div()
                .flex_1()
                .text_style(TextStyle::Body)
                .text_color(bezel.text_muted)
                .child("Browse sessions…"),
        )
        .child(bezel_ui::popover::kbd_hint(bezel, "⌘K"))
}

/// Refresh and Theme as quiet glyph buttons, then the one prominent action.
fn header_actions(bezel: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(SPACE * 0.5))
        .child(bezel.icon_button(icon("icons/refresh.svg"), ButtonStyle::Ghost, None))
        .child(bezel.icon_button(icon("icons/theme.svg"), ButtonStyle::Ghost, None))
        .child(div().w(px(SPACE * 0.5)))
        .child(bezel.button("New session", ButtonStyle::Prominent, None))
}

fn connected(bezel: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .child(status_dot(bezel.success))
        .child(
            div()
                .text_style(TextStyle::Callout)
                .text_color(bezel.text_muted)
                .child("Connected"),
        )
}

fn star(bezel: &Theme, on: bool) -> Svg {
    if on {
        glyph("icons/fleet-star-filled.svg", 14., bezel.warning)
    } else {
        glyph("icons/fleet-star.svg", 14., bezel.text_muted.opacity(0.45))
    }
}

/// One dense session row: star, name, an "attached" dot, and the pane count
/// as plain muted text. `cursor` paints the keyboard row with its ↵ hint.
fn session_row(bezel: &Theme, session: &Session, meta: Option<&str>, first: bool, cursor: bool) -> Div {
    bezel
        .card_row(first)
        .py(px(7.))
        .when(cursor, |row| row.bg(bezel.card_selected_bg()))
        .child(star(bezel, session.favourite))
        .child(glyph("icons/terminal.svg", 14., bezel.text_muted))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(SPACE))
                .child(bezel.row_title(session.name))
                .when_some(meta, |row, meta| {
                    row.child(
                        div()
                            .text_style(TextStyle::Callout)
                            .text_color(bezel.text_muted)
                            .child(meta.to_string()),
                    )
                }),
        )
        .when(session.attached, |row| {
            row.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .child(status_dot(bezel.accent))
                    .child("attached"),
            )
        })
        .child(
            div()
                .w(px(64.))
                .flex()
                .justify_end()
                .text_style(TextStyle::Callout)
                .text_color(bezel.text_muted)
                .child(panes(session.panes)),
        )
        .child(
            div()
                .w(px(24.))
                .flex()
                .justify_end()
                .when(cursor, |cell| {
                    cell.child(bezel_ui::popover::kbd_hint(bezel, "↵"))
                }),
        )
}

fn section_label(bezel: &Theme, label: &str) -> Div {
    div()
        .text_style(TextStyle::Subheadline)
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(bezel.text_muted)
        .child(label.to_string())
}

fn page_head(bezel: &Theme, trailing: Div) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(SPACE * 2.))
        .child(
            div()
                .flex()
                .items_baseline()
                .gap(px(SPACE * 1.5))
                .child(bezel.page_header("tmux-ide", None))
                .child(
                    div()
                        .text_style(TextStyle::Body)
                        .text_color(bezel.text_muted)
                        .child("2 machines · 12 sessions"),
                ),
        )
        .child(trailing)
}

/// Option A: one column. Header line with the single primary action, the
/// browse field, Favourites, then each machine as a flat heading over one
/// card of session rows. The server shows in the heading while a machine has
/// one; a second server would become a sub-heading inside the card.
fn option_a(bezel: &Theme) -> Div {
    let machines = fleet();
    let favourites: Vec<(&Session, &str)> = machines
        .iter()
        .flat_map(|m| m.sessions.iter().map(move |s| (s, m.name)))
        .filter(|(s, _)| s.favourite)
        .collect();
    let mut column = div()
        .w_full()
        .max_w(px(920.))
        .pt(px(SPACE * 3.))
        .px(px(SPACE * 4.))
        .pb(px(SPACE * 4.))
        .flex()
        .flex_col()
        .gap(px(SPACE * 2.))
        .child(page_head(bezel, header_actions(bezel)))
        .child(browse_field(bezel, None))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(SPACE))
                .child(section_label(bezel, "Favourites"))
                .child(bezel.group_box().children(favourites.iter().enumerate().map(
                    |(i, (session, machine))| session_row(bezel, session, Some(machine), i == 0, false),
                ))),
        );
    for (mi, machine) in machines.iter().enumerate() {
        let heading = div()
            .flex()
            .items_center()
            .gap(px(SPACE))
            .child(glyph("icons/devices.svg", 15., bezel.text_muted))
            .child(
                div()
                    .text_style(TextStyle::Headline)
                    .text_color(bezel.text)
                    .child(machine.name),
            )
            .child(connected(bezel))
            .child(
                div()
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .child(format!(
                        "· tmux {} · {}",
                        machine.server,
                        crate::plural::count(machine.sessions.len(), "session", "sessions")
                    )),
            )
            .child(div().flex_1())
            .when(machine.remote, |h| {
                h.child(bezel.button("Disconnect", ButtonStyle::Ghost, None))
            })
            .when(!machine.remote, |h| {
                h.child(bezel.icon_button(icon("icons/plus.svg"), ButtonStyle::Ghost, None))
            });
        column = column.child(
            div()
                .flex()
                .flex_col()
                .gap(px(SPACE))
                .child(heading)
                .child(bezel.group_box().children(machine.sessions.iter().enumerate().map(
                    |(i, session)| session_row(bezel, session, None, i == 0, mi == 1 && i == 1),
                ))),
        );
    }
    div().w_full().flex().justify_center().child(column)
}

fn machine_nav_row(
    bezel: &Theme,
    glyph_path: &'static str,
    label: &str,
    count: usize,
    selected: bool,
    dot: Option<Hsla>,
) -> Div {
    div()
        .w_full()
        .flex()
        .items_center()
        .gap(px(SPACE))
        .px(px(SPACE))
        .py(px(6.))
        .rounded(px(Theme::control_radius()))
        .when(selected, |row| row.bg(bezel.card_selected_bg()))
        .child(glyph(glyph_path, 15., if selected { bezel.text } else { bezel.text_muted }))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_style(TextStyle::Body)
                .text_color(bezel.text)
                .child(label.to_string()),
        )
        .when_some(dot, |row, tone| row.child(status_dot(tone)))
        .child(
            div()
                .text_style(TextStyle::Callout)
                .text_color(bezel.text_muted)
                .child(count.to_string()),
        )
}

/// Option B: master–detail. A machine list on the left (with Favourites and
/// All sessions as filters), the selected machine's sessions on the right as
/// one dense card. Connection state and Disconnect sit in the detail header.
fn option_b(bezel: &Theme) -> Div {
    let machines = fleet();
    let spark = &machines[1];
    let nav = div()
        .w(px(232.))
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(machine_nav_row(bezel, "icons/sessions.svg", "All sessions", 12, false, None))
        .child(machine_nav_row(bezel, "icons/fleet-star.svg", "Favourites", 2, false, None))
        .child(div().h(px(SPACE * 1.5)))
        .child(div().px(px(SPACE)).pb(px(4.)).child(section_label(bezel, "Machines")))
        .child(machine_nav_row(bezel, "icons/devices.svg", "Local", 1, false, Some(bezel.success)))
        .child(machine_nav_row(bezel, "icons/globe.svg", "spark", 11, true, Some(bezel.success)))
        .child(
            div()
                .mt(px(SPACE))
                .px(px(SPACE))
                .flex()
                .items_center()
                .gap(px(SPACE))
                .text_style(TextStyle::Callout)
                .text_color(bezel.text_muted)
                .child(glyph("icons/plus.svg", 13., bezel.text_muted))
                .child("Add machine…"),
        );
    let detail_head = div()
        .flex()
        .items_center()
        .gap(px(SPACE))
        .child(
            div()
                .text_style(TextStyle::Title3)
                .text_color(bezel.text)
                .child(spark.name),
        )
        .child(connected(bezel))
        .child(
            div()
                .text_style(TextStyle::Callout)
                .text_color(bezel.text_muted)
                .child("· tmux default · 11 sessions"),
        )
        .child(div().flex_1())
        .child(bezel.button("Disconnect", ButtonStyle::Ghost, None));
    let table_head = div()
        .px(px(16.))
        .py(px(6.))
        .flex()
        .items_center()
        .gap(px(SPACE))
        .text_style(TextStyle::Caption)
        .text_color(bezel.text_muted)
        .child(div().w(px(14.)))
        .child(div().w(px(14.)))
        .child(div().flex_1().child("Session"))
        .child(div().w(px(64.)).flex().justify_end().child("Panes"))
        .child(div().w(px(24.)));
    let rows = spark
        .sessions
        .iter()
        .enumerate()
        .map(|(i, session)| session_row(bezel, session, None, false, i == 1));
    let detail = div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(SPACE * 1.5))
        .child(detail_head)
        .child(bezel.group_box().child(table_head).children(rows));
    let column = div()
        .w_full()
        .max_w(px(1180.))
        .pt(px(SPACE * 3.))
        .px(px(SPACE * 4.))
        .pb(px(SPACE * 4.))
        .flex()
        .flex_col()
        .gap(px(SPACE * 3.))
        .child(page_head(
            bezel,
            div()
                .flex()
                .items_center()
                .gap(px(SPACE))
                .child(browse_field(bezel, Some(300.)))
                .child(header_actions(bezel)),
        ))
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(SPACE * 4.))
                .child(nav)
                .child(detail),
        );
    div().w_full().flex().justify_center().child(column)
}

pub(crate) fn render(variant: Variant, bezel: &Theme, canvas: u32, focus: &FocusHandle) -> AnyElement {
    let body = match variant {
        Variant::A => option_a(bezel),
        Variant::B => option_b(bezel),
    };
    div()
        .id("tmux-home")
        .track_focus(focus)
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .bg(rgb(canvas))
        .text_color(bezel.text)
        .text_style(TextStyle::Body)
        .child(body)
        .into_any_element()
}
