//! The daemon's product announcement, drawn as a dismissible card among the
//! notices over the top-right of the terminal area. Dismissing asks the daemon to mark it seen,
//! so every client of that daemon stops showing it.
use super::HerdrWindow;
use crate::{notifications::safe_text, state::AnnouncementDismissal};
use gpui::{prelude::*, *};
use herdr_client::Method;

const MAX_WIDTH: f32 = 420.;
const MAX_BODY_HEIGHT: f32 = 240.;
const MAX_TITLE: usize = 160;

impl HerdrWindow {
    pub(super) fn announcement_card(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let announcement = self.live.product_announcement()?;
        let lines = self.daemon_text.announcement.lines(&announcement.body);
        let theme = &self.theme;
        let accent = theme.ink(theme.palette[4]);
        let (version, id) = (announcement.version.clone(), announcement.id.clone());
        let caption = if announcement.preview {
            format!("Herdr {} · preview", safe_text(&announcement.version, 64))
        } else {
            format!("Herdr {}", safe_text(&announcement.version, 64))
        };
        let card = div()
            .id("announcement")
            .debug_selector(|| "announcement".into())
            .min_w_0()
            .w_full()
            .max_w(px(MAX_WIDTH))
            .occlude()
            .flex()
            .gap(px(8.))
            .p(px(10.))
            .rounded(px(crate::config::corners::PANEL))
            .border_1()
            .border_color(rgb(accent))
            .bg(rgb(theme.surface))
            .text_color(rgb(theme.foreground))
            .shadow_lg()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(div().truncate().text_color(rgb(theme.muted)).child(caption))
                    .child(
                        div()
                            .debug_selector(|| "announcement-title".into())
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(safe_text(&announcement.title, MAX_TITLE)),
                    )
                    .child(
                        div()
                            .id("announcement-body")
                            .max_h(px(MAX_BODY_HEIGHT))
                            .overflow_y_scroll()
                            .child(crate::release_notes::render(
                                "announcement",
                                &lines,
                                theme,
                                &self.config.terminal,
                            )),
                    ),
            )
            .child(
                div()
                    .id("announcement-dismiss")
                    .debug_selector(|| "announcement-dismiss".into())
                    .flex_none()
                    .size(px(24.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(theme.active)))
                    .child(
                        svg()
                            .path("icons/close.svg")
                            .size(px(12.))
                            .text_color(rgb(theme.foreground)),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.dismiss_announcement(&version, &id, cx);
                    })),
            );
        Some(card.into_any_element())
    }

    /// Hides the announcement at once and asks the daemon to mark it seen. A
    /// daemon that rejects the request brings it back with its next state.
    pub(crate) fn dismiss_announcement(&mut self, version: &str, id: &str, cx: &mut Context<Self>) {
        let endpoint = &self.endpoints[self.selected_endpoint];
        let Ok(mut inbox) = endpoint.connection.inbox.try_lock() else {
            self.local_error = Some(format!(
                "Dismiss announcement: {}",
                crate::Error::ConnectionBusy
            ));
            cx.notify();
            return;
        };
        // Act on the state the reducer holds: the card may have been drawn
        // from a snapshot the daemon has since replaced.
        let Some(boot) = inbox
            .snapshot
            .as_deref()
            .filter(|snapshot| {
                snapshot
                    .product_announcement
                    .as_ref()
                    .is_some_and(|current| current.version == version && current.id == id)
            })
            .map(|snapshot| snapshot.boot_id.clone())
        else {
            return;
        };
        let request = if inbox.supports_announcement_dismiss {
            let Some(handle) = endpoint.connection.handle.as_ref() else {
                return;
            };
            // Registered under the reducer's lock so even an immediate reply is seen.
            match handle.request(
                &boot,
                Method::ProductAnnouncementDismiss,
                serde_json::json!({ "version": version, "id": id }),
            ) {
                Ok(request) => Some(request),
                Err(error) => {
                    drop(inbox);
                    self.local_error = Some(format!("Dismiss announcement: {error}"));
                    cx.notify();
                    return;
                }
            }
        } else {
            None
        };
        let dismissal = AnnouncementDismissal {
            request,
            version: version.into(),
            id: id.into(),
        };
        inbox.announcement_dismissal = Some(dismissal.clone());
        drop(inbox);
        self.live.announcement_dismissal = Some(dismissal);
        cx.notify();
    }
}
