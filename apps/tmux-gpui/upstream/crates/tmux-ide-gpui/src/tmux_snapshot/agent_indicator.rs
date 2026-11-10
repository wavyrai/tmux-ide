//! Presentation only. Published status is authority; the clock never reads terminals.
use super::{
    SnapshotView,
    browser::home_agents::{Row, Status},
};
use gpui::{prelude::*, *};
pub(super) const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
fn animated(row: &Row, unavailable: bool) -> bool {
    matches!(row.status, Status::Working) && !row.attention && !unavailable
}
fn glyph(row: &Row, unavailable: bool, frame: usize) -> &'static str {
    if unavailable {
        return "·";
    }
    if matches!(row.status, Status::Disconnected) {
        return "·";
    }
    if matches!(row.status, Status::Failed) {
        return "×";
    }
    if row.attention {
        return "!";
    }
    match row.status {
        Status::Working => FRAMES[frame % FRAMES.len()],
        Status::Blocked => "!",
        Status::Done => "✓",
        Status::Failed => "×",
        Status::Disconnected => "·",
        Status::Idle => "○",
    }
}
/// The state's words, as the badge shows them and a screen reader says them.
pub(super) fn state_label(row: &Row, unavailable: bool) -> &'static str {
    label(row, unavailable)
}
fn label(row: &Row, unavailable: bool) -> &'static str {
    if unavailable {
        return "Unavailable";
    }
    if matches!(row.status, Status::Disconnected) {
        return "Unknown";
    }
    if matches!(row.status, Status::Failed) {
        return "Failed";
    }
    if row.attention || matches!(row.status, Status::Blocked) {
        return "Needs input";
    }
    match row.status {
        Status::Working => "Working",
        Status::Done => "Done",
        _ => "Idle",
    }
}
/// The one colour "needs input" wears everywhere, in every theme: the agent's
/// badge and Home's pill (#705).
pub(super) fn attention_ink(theme: &crate::config::Theme) -> u32 {
    theme.ink(theme.palette[3])
}
/// Where a state mark is drawn, which decides the plates it is inked on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Plate {
    /// The theme's own background, surface and active fill: Home's table.
    Chrome,
    /// A sidebar row on the frosted sidebar, bare or under its washes.
    Sidebar,
    /// A pane card's header, bare or under its washes.
    Header,
}
/// The "needs input" pill (#746 mockup): the attention colour as a wash (12%
/// in a light theme, 14% in a dark one), a 5 pt dot and words at Caption,
/// weight 600, 18 pt high, with no outline. The wash is laid opaque over the
/// plate's own colour, so the pill reads the same over the frost whatever
/// the desktop; the dot and words are the attention colour, moved only as
/// far as they must to read at 4.6:1 on it.
pub(super) fn attention_pill(
    theme: &crate::config::Theme,
    on: Plate,
    words: impl Into<SharedString>,
) -> Div {
    let (wash, ink) = attention_pill_colors(theme, on);
    div()
        .debug_selector(|| "attention-pill".into())
        .flex_none()
        .h(px(18.))
        .px(px(7.))
        .flex()
        .items_center()
        .gap(px(4.))
        .rounded_full()
        .bg(wash)
        .text_color(rgb(ink))
        .text_size(px(bezel_theme::TextStyle::Caption.size()))
        .font_weight(FontWeight::SEMIBOLD)
        .whitespace_nowrap()
        .child(div().flex_none().size(px(5.)).rounded_full().bg(rgb(ink)))
        .child(words.into())
}
/// The pill's opaque wash and the ink of its dot and words.
pub(super) fn attention_pill_colors(theme: &crate::config::Theme, on: Plate) -> (Hsla, u32) {
    let accent = attention_ink(theme);
    let dark = crate::contrast::luminance(theme.background) < 0.5;
    let plate = match on {
        // The sidebar's plate is the frost's own tone.
        Plate::Sidebar => theme.sidebar.unwrap_or(theme.surface),
        Plate::Chrome | Plate::Header => theme.background,
    };
    let wash = bezel_theme::flatten(
        Hsla::from(rgb(accent)).opacity(if dark { 0.14 } else { 0.12 }),
        rgb(plate).into(),
    );
    let packed = u32::from(Rgba::from(wash)) >> 8;
    (wash, crate::contrast::ink(accent, &[packed], 4.6))
}
/// The state's colour before inking.
fn hue(row: &Row, unavailable: bool, theme: &crate::config::Theme) -> u32 {
    if unavailable || matches!(row.status, Status::Disconnected) {
        theme.muted
    } else if matches!(row.status, Status::Failed) {
        theme.palette[1]
    } else if row.attention || matches!(row.status, Status::Blocked) {
        theme.palette[3]
    } else if matches!(row.status, Status::Done) {
        theme.palette[2]
    } else {
        // Idle and Working are muted: the spinner's motion says Working, and
        // the theme's one accent is left to "needs input" (#746).
        theme.muted
    }
}
/// The state's mark, inked to the contrast setting's mark ratio on the
/// plates it is drawn on: with the pill's words gone, the glyph is the only
/// sign of the state (#746).
pub(super) fn color(row: &Row, unavailable: bool, theme: &crate::config::Theme, on: Plate) -> u32 {
    let hue = hue(row, unavailable, theme);
    match on {
        Plate::Chrome => theme.ink(hue),
        Plate::Sidebar => super::design::row_mark(theme, hue),
        Plate::Header => super::pane_chrome::header_mark(theme, hue),
    }
}
impl SnapshotView {
    fn agent_motion(&self) -> bool {
        self.presence.active()
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
    }
    /// Starts or stops the spinner overlay's tick; never repaints this view.
    pub(super) fn tick_agent_indicators(&mut self, cx: &mut Context<Self>) {
        self.agent_animation.sync(self.agent_motion(), cx);
    }
    /// A Home chip's state after the agent's name (#746): the spinner and
    /// "Working", or "· Done", "· Idle" and the like, in the muted ink; a
    /// failed agent's words in its own colour.
    pub(super) fn agent_chip_state(&self, row: &Row, unavailable: bool) -> AnyElement {
        let theme = self.theme();
        let words = label(row, unavailable);
        let ink: Hsla = if !unavailable && matches!(row.status, Status::Failed) {
            rgb(color(row, unavailable, &theme, Plate::Chrome)).into()
        } else {
            rgb(theme.ink(theme.muted)).into()
        };
        let state = div()
            .debug_selector(|| "agent-badge".into())
            .flex_none()
            .flex()
            .items_center()
            .text_color(ink);
        if animated(row, unavailable) {
            state
                .gap(px(2.))
                .child(self.agent_glyph(row, unavailable))
                .child(words)
                .into_any_element()
        } else {
            state.child(format!("· {words}")).into_any_element()
        }
    }
    /// A sidebar pane row's state (#746): the full pill only when the agent
    /// needs input; otherwise its bare glyph (the spinner, a check, a cross),
    /// and nothing for an idle agent.
    pub(super) fn agent_state(
        &self,
        row: &Row,
        unavailable: bool,
        on: Plate,
    ) -> Option<AnyElement> {
        if label(row, unavailable) == "Needs input" {
            return Some(
                attention_pill(&self.theme(), on, "Needs input")
                    .debug_selector(|| "agent-badge".into())
                    .into_any_element(),
            );
        }
        if !unavailable && matches!(row.status, Status::Idle) {
            return None;
        }
        let theme = self.theme();
        Some(
            div()
                .debug_selector(|| "agent-glyph".into())
                .flex_none()
                .text_color(rgb(color(row, unavailable, &theme, on)))
                // Keyed by where it's drawn, so a test reads each call site's ink.
                .children(super::design::ink_probe(move || {
                    format!("agent-glyph-{on:?}")
                }))
                .child(self.agent_glyph(row, unavailable))
                .into_any_element(),
        )
    }
    fn agent_glyph(&self, row: &Row, unavailable: bool) -> Div {
        let slots = self.agent_animation.clone();
        // A running row only reserves its slot: the overlay paints the frames.
        let running = animated(row, unavailable) && slots.attached() && self.agent_motion();
        div()
            .relative()
            .w(px(16.))
            .flex_shrink_0()
            .child(
                div()
                    .when(running, |glyph| glyph.text_color(transparent_black()))
                    .child(glyph(row, unavailable, slots.frame())),
            )
            .when(running, |slot| {
                slot.child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, _, window, _| slots.reserve(bounds, window),
                    )
                    // Pinned to the slot: without an inset, an absolute
                    // child sits at its static position, one line below.
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
                )
            })
    }
}
#[cfg(test)]
#[path = "agent_indicator_tests.rs"]
mod tests;
