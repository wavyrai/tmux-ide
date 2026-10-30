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
fn color(row: &Row, unavailable: bool, theme: &crate::config::Theme) -> u32 {
    if unavailable || matches!(row.status, Status::Disconnected) {
        theme.muted
    } else if matches!(row.status, Status::Failed) {
        theme.ink(theme.palette[1])
    } else if row.attention || matches!(row.status, Status::Blocked) {
        theme.ink(theme.palette[3])
    } else if matches!(row.status, Status::Idle) {
        theme.muted
    } else if matches!(row.status, Status::Done) {
        theme.ink(theme.palette[2])
    } else {
        theme.ink(theme.palette[4])
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
        let slots = self.agent_animation.clone();
        // A running row only reserves its slot: the overlay paints the frames.
        let running = animated(row, unavailable) && slots.attached() && self.agent_motion();
        let theme = self.theme();
        super::design::palette(&theme)
            .badge("")
            .flex()
            .items_center()
            .gap_1()
            .text_color(rgb(color(row, unavailable, &theme)))
            .child(
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
                            .absolute()
                            .size_full(),
                        )
                    }),
            )
            .child(label(row, unavailable))
            .into_any_element()
    }
}
#[cfg(test)]
#[path = "agent_indicator_tests.rs"]
mod tests;
