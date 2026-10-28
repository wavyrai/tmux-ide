//! What the terminal area shows while the selected endpoint reconnects after a
//! drop: the last picture dimmed, and a card naming the host, why it dropped,
//! and a way to retry now. The endpoint keeps retrying on its own backoff and
//! the window stays on it; nothing typed meanwhile is sent.
use super::HerdrWindow;
use crate::notifications::safe_text;
use gpui::{prelude::*, *};

const MAX_WIDTH: f32 = 420.;
const MAX_REASON: usize = 240;
/// How much of the stale picture shows through.
const DIM_ALPHA: u32 = 0xa0;

impl HerdrWindow {
    /// Whether the card shows. A replacement connection's snapshot ends the
    /// outage before its first frame, so the card stays over the old picture
    /// until that frame lands.
    pub(crate) fn reconnecting(&self) -> bool {
        self.endpoints[self.selected_endpoint].outage().is_some() || self.presentation.stale()
    }

    pub(super) fn render_reconnecting(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.reconnecting() {
            return None;
        }
        let endpoint = &self.endpoints[self.selected_endpoint];
        let reason = endpoint.outage();
        let theme = &self.theme;
        let card = div()
            .id("reconnecting")
            .debug_selector(|| "reconnecting".into())
            .min_w_0()
            .max_w(px(MAX_WIDTH))
            .occlude()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(12.))
            .rounded(px(crate::config::corners::PANEL))
            .border_1()
            .border_color(rgb(theme.ink(theme.palette[3])))
            .bg(rgb(theme.surface))
            .text_color(rgb(theme.foreground))
            .shadow_lg()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .truncate()
                    .child(format!(
                        "Reconnecting to {}",
                        safe_text(&endpoint.label, 80)
                    )),
            )
            .children(reason.map(|reason| {
                div()
                    .debug_selector(|| "reconnecting-reason".into())
                    .text_color(rgb(theme.muted))
                    .child(safe_text(reason, MAX_REASON))
            }))
            .child(
                div().flex().child(
                    div()
                        .id("reconnect-now")
                        .debug_selector(|| "reconnect-now".into())
                        .px(px(10.))
                        .py(px(4.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .border_1()
                        .border_color(rgb(theme.active))
                        .cursor_pointer()
                        .hover(|s| s.bg(rgb(theme.active)))
                        .child("Reconnect now")
                        .on_click(cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            this.reconnect(cx);
                            cx.notify();
                        })),
                ),
            );
        Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .p(px(16.))
                .when(self.presentation.stale(), |overlay| {
                    overlay.bg(rgba((theme.background << 8) | DIM_ALPHA))
                })
                .child(card)
                .into_any_element(),
        )
    }
}
