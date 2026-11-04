//! The UI's 16 ms browser tick. It flushes queued work and re-renders only when
//! something is due; an idle Home must cost no frames (card #703).
use super::{SnapshotView, browser, renderer_probe};
use gpui::{AsyncWindowContext, Context, WeakEntity};

/// The browser window's UI loop. It wakes for the 16 ms tick (queued UI work)
/// or at once when a publication lands (#710), then applies the latest state.
pub(super) async fn run_browser(
    entity: WeakEntity<SnapshotView>,
    mailbox: browser::Mailbox,
    cx: &mut AsyncWindowContext,
) {
    loop {
        let tick = cx
            .background_executor()
            .timer(std::time::Duration::from_millis(16));
        browser::tick_or_publication(tick, &mailbox).await;
        if entity.update(cx, |view, cx| view.browser_tick(cx)).is_err() {
            break;
        }
        let update = mailbox.try_lock().ok().and_then(|mut slot| slot.take());
        if let Some(state) = update {
            let done = state.is_none();
            if entity
                .update_in(cx, |view, window, cx| {
                    view.apply_browser_state(state, cx);
                    view.finish_session_open(window, cx);
                    view.finish_header_actions(window, cx);
                })
                .is_err()
                || done
            {
                break;
            }
        }
    }
}

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
