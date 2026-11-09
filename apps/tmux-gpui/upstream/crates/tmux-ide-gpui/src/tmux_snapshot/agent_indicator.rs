//! Presentation only. Published status is authority; the clock never reads terminals.
use super::{
    SnapshotView,
    browser::home_agents::{Row, Status},
};
use bezel_ui::widgets::Content;
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
    pub(super) fn agent_indicator(&self, row: &Row, unavailable: bool) -> AnyElement {
        let theme = self.theme();
        super::design::palette(&theme)
            .badge("")
            .debug_selector(|| "agent-badge".into())
            .flex()
            .items_center()
            .gap_1()
            .text_color(rgb(color(row, unavailable, &theme, Plate::Chrome)))
            .child(self.agent_glyph(row, unavailable))
            .child(label(row, unavailable))
            .into_any_element()
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
            return Some(self.agent_indicator(row, unavailable));
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
                .children(super::design::ink_probe(|| "agent-glyph".into()))
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
