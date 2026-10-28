//! Presentation only. Published status is authority; the clock never reads terminals.
use super::{
    SnapshotView,
    browser::home_agents::{Row, Status},
};
use bezel_ui::widgets::Content;
use gpui::{prelude::*, *};
use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};
const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
#[derive(Default)]
pub(super) struct Clock {
    visible: Rc<Cell<bool>>,
    frame: usize,
    last: Option<Instant>,
}
impl Clock {
    pub(super) fn begin_render(&self) {
        self.visible.set(false);
    }
    fn tick(&mut self, now: Instant, active: bool) -> bool {
        if !active || !self.visible.get() {
            self.last = None;
            self.frame = 0;
            return false;
        }
        if self
            .last
            .is_some_and(|last| now.duration_since(last) < Duration::from_millis(80))
        {
            return false;
        }
        self.last = Some(now);
        self.frame = (self.frame + 1) % FRAMES.len();
        true
    }
}
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
    pub(super) fn tick_agent_indicators(&mut self, cx: &mut Context<Self>) {
        let active = self.presence.active()
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none();
        if self.agent_animation.tick(Instant::now(), active) {
            cx.notify();
        }
    }
    pub(super) fn agent_indicator(&self, row: &Row, unavailable: bool) -> AnyElement {
        self.agent_indicator_with_motion(row, unavailable, true)
    }
    pub(super) fn agent_indicator_with_motion(
        &self,
        row: &Row,
        unavailable: bool,
        motion: bool,
    ) -> AnyElement {
        let running = animated(row, unavailable) && motion;
        let visible = self.agent_animation.visible.clone();
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
                    .child(if !motion && animated(row, unavailable) {
                        "●"
                    } else {
                        glyph(row, unavailable, self.agent_animation.frame)
                    })
                    .child(
                        canvas(
                            |_, _, _| (),
                            move |bounds, _, window, _| {
                                let bounds = bounds.intersect(&window.content_mask().bounds);
                                if running
                                    && bounds.size.width > px(0.)
                                    && bounds.size.height > px(0.)
                                {
                                    visible.set(true);
                                }
                            },
                        )
                        .absolute()
                        .size_full(),
                    ),
            )
            .child(label(row, unavailable))
            .into_any_element()
    }
}
#[cfg(test)]
#[path = "agent_indicator_tests.rs"]
mod tests;
