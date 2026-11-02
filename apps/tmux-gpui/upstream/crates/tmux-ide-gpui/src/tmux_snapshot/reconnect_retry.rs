//! The Retry button beside the Reconnecting status (card #702). It only asks the
//! catalog to try now; reconnection keeps its own identity checks.
use super::{SnapshotView, browser};
use gpui::{prelude::*, *};

impl SnapshotView {
    pub(super) fn reconnect_retry(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.browser_state.reconnect_attempt?;
        let request = self.browser_state.request;
        let palette = super::design::palette(&self.theme());
        let hover = palette.element_hover;
        Some(
            div()
                .id("reconnect-retry")
                .debug_selector(|| "tmux-reconnect-retry".into())
                .flex_none()
                .px_1()
                .cursor_pointer()
                .child({
                    use bezel_theme::{Sizing as _, Typeset as _};
                    use bezel_ui::widgets::Buttons as _;
                    palette
                        .button("Retry", bezel_ui::widgets::ButtonStyle::Ghost, None)
                        .control_size(bezel_theme::ControlSize::Small)
                        .text_style(bezel_theme::TextStyle::Caption)
                        .hover(move |s| s.bg(hover))
                })
                .on_click(cx.listener(move |view, _, _, cx| {
                    cx.stop_propagation();
                    view.retry_reconnect(request);
                }))
                .into_any_element(),
        )
    }
    /// Send the retry for the request the button was drawn for, never a newer one.
    pub(super) fn retry_reconnect(&self, request: u64) -> bool {
        self.browser_state.reconnect_attempt.is_some()
            && self.browser_state.request == request
            && self.browser_commands.as_ref().is_some_and(|sender| {
                sender
                    .try_send(browser::Command::RetryReconnect { request })
                    .is_ok()
            })
    }
}

#[cfg(test)]
#[path = "reconnect_retry_tests.rs"]
mod tests;
