//! The UI's 16 ms browser tick. It flushes queued work and re-renders only when
//! something is due; an idle Home must cost no frames (card #703).
use super::{SnapshotView, renderer_probe};
use gpui::Context;

impl SnapshotView {
    pub(super) fn browser_tick(&mut self, cx: &mut Context<Self>) {
        if let Some(sender) = &self.browser_commands {
            self.presence.flush(sender);
        }
        self.flush_resize_gesture(cx);
        self.flush_pending_input(cx);
        renderer_probe::runtime::tick();
        if !self.terminal_input_ready() || self.selection.is_some() || self.divider.is_some() {
            self.fit_settle.clear();
        } else if self.fit_settle.due(std::time::Instant::now()) {
            cx.notify();
        }
        self.flush_attention();
        self.flush_palette(cx);
        self.flush_kitty_graphics(cx);
        self.tick_agent_indicators(cx);
        if self.chrome.take_policy_change() {
            cx.notify();
        }
    }
}

#[cfg(test)]
#[path = "browser_tick_tests.rs"]
mod tests;
