use super::HerdrWindow;
use crate::{
    fonts::StyledFont,
    notifications::{Notice, VISIBLE_LIMIT, safe_text},
};
use gpui::{prelude::*, *};
use herdr_client::protocol::{SemanticNotification, SemanticNotificationKind, ToastHerdrPosition};
use std::{sync::TryLockError, task::Poll, time::Instant};

impl HerdrWindow {
    pub(crate) fn click_toast(
        &mut self,
        endpoint_id: &str,
        generation: u64,
        inbox: &std::sync::Arc<std::sync::Mutex<crate::state::LiveState>>,
        id: u64,
        cx: &mut Context<Self>,
    ) {
        if self.menu.page.is_some() || self.toasts_hidden {
            return;
        }
        let Some(index) = self.endpoints.iter().position(|e| {
            e.id == endpoint_id
                && e.generation == generation
                && std::sync::Arc::ptr_eq(&e.connection.inbox, inbox)
        }) else {
            return;
        };
        self.open_notice(index, id, cx);
    }

    /// Selects the notice's host and navigates once its inbox validates the
    /// target, for a toast click and an OS notification click alike.
    pub(super) fn open_notice(&mut self, index: usize, id: u64, cx: &mut Context<Self>) {
        let target = match self.toast_target(index, id) {
            Poll::Ready(target) => target,
            Poll::Pending => {
                // The displayed target can start a handoff, but only a fresh
                // inbox validation may queue navigation after contention ends.
                let endpoint = &self.endpoints[index];
                endpoint.live.snapshot.as_deref().and_then(|snapshot| {
                    endpoint
                        .toasts
                        .entries
                        .iter()
                        .find(|(entry, _)| *entry == id)
                        .and_then(|(_, notice)| notice.target(snapshot))
                        .map(|target| (&target).into())
                })
            }
        };
        let Some(target) = target else {
            return;
        };
        let endpoint_id = self.endpoints[index].id.clone();
        if !self.select_endpoint(&endpoint_id, cx) {
            return;
        }
        self.pending_navigation = Some(target);
        self.pending_toast = Some(id);
        self.navigate_toast(id, cx);
        cx.notify();
    }

    pub(crate) fn toast_target(
        &self,
        index: usize,
        id: u64,
    ) -> Poll<Option<crate::navigation::OwnedNavigationTarget>> {
        let endpoint = &self.endpoints[index];
        if !endpoint.enabled || endpoint.connection.handle.is_none() {
            return Poll::Ready(None);
        }
        let Some((_, notice)) = endpoint
            .toasts
            .entries
            .iter()
            .find(|(entry, _)| *entry == id)
        else {
            return Poll::Ready(None);
        };
        let accepted = index == self.selected_endpoint && self.pending_toast == Some(id);
        // A posted OS notification has no in-app lifetime; its click is
        // fenced by the boot, inbox, and loss checks below instead.
        if !notice.posted && (!notice.visible || (!accepted && notice.expires <= Instant::now())) {
            return Poll::Ready(None);
        }
        let state = match endpoint.connection.inbox.try_lock() {
            Ok(state) => state,
            Err(TryLockError::WouldBlock) => return Poll::Pending,
            Err(TryLockError::Poisoned(_)) => return Poll::Ready(None),
        };
        if !state.status.is_connected()
            || state.notifications_lost
            || notice.pane_id.as_ref().is_some_and(|pane| {
                state
                    .notifications
                    .iter()
                    .any(|new| new.pane_id.as_ref() == Some(pane))
            })
        {
            return Poll::Ready(None);
        }
        Poll::Ready(
            state
                .snapshot
                .as_deref()
                .and_then(|snapshot| notice.target(snapshot))
                .map(|target| (&target).into()),
        )
    }

    pub(crate) fn navigate_toast(&mut self, id: u64, cx: &mut Context<Self>) {
        if self.menu.page.is_some() || !self.navigation_ready() {
            return;
        }
        let Poll::Ready(target) = self.toast_target(self.selected_endpoint, id) else {
            return;
        };
        self.pending_toast = None;
        self.pending_navigation = None;
        if let Some(target) = target
            && self.navigate(target.as_deref(), cx)
        {
            self.endpoints[self.selected_endpoint].toasts.dismiss(id);
        }
        cx.notify();
    }

    pub(crate) fn show_toast_preview(
        &mut self,
        kind: SemanticNotificationKind,
        cx: &mut Context<Self>,
    ) {
        let (title, body) = match kind {
            SemanticNotificationKind::NeedsAttention => (
                "Needs attention",
                "QA preview: an agent is waiting for your input.",
            ),
            SemanticNotificationKind::Finished => {
                ("Finished", "QA preview: an agent has completed its task.")
            }
            SemanticNotificationKind::UpdateInstalled => (
                "Update installed",
                "QA preview only. No update was installed.",
            ),
            SemanticNotificationKind::Custom => (
                "Custom notification",
                "QA preview: a custom notification message.",
            ),
        };
        let snapshot = self.endpoints[self.selected_endpoint].live.snapshot.clone();
        let target = snapshot.as_ref().filter(|_| {
            matches!(
                kind,
                SemanticNotificationKind::NeedsAttention | SemanticNotificationKind::Finished
            )
        });
        let mut notice = Notice::new(
            SemanticNotification {
                kind,
                title: title.into(),
                body: Some(body.into()),
                sound: None,
                agent: None,
                workspace_id: target.and_then(|s| s.focused_workspace_id.clone()),
                tab_id: target.and_then(|s| s.focused_tab_id.clone()),
                pane_id: target.and_then(|s| s.focused_pane_id.clone()),
                position: None,
            },
            Instant::now(),
        )
        .with_snapshot(snapshot.as_deref())
        .preview();
        // Each QA action immediately presents its own card, even offline.
        for endpoint in &mut self.endpoints {
            endpoint.toasts.entries.retain(|(_, n)| !n.visible);
        }
        notice.position = self.config.notifications.position;
        notice.promote(Instant::now());
        self.endpoints[self.selected_endpoint]
            .toasts
            .receive([notice]);
        self.tick_toasts(false, Instant::now());
        cx.notify();
    }

    pub(crate) fn tick_toasts(&mut self, hidden: bool, now: Instant) -> bool {
        crate::notifications::tick(
            &mut self.endpoints,
            self.selected_endpoint,
            self.config.notifications,
            hidden,
            self.active,
            self.pending_toast,
            now,
        )
    }

    pub(super) fn render_toasts(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let viewport = window.viewport_size();
        self.toasts_hidden = viewport.height < px(180.) || viewport.width < px(180.);
        self.tick_toasts(
            self.menu.page.is_some() || self.toasts_hidden,
            Instant::now(),
        );
        if self.menu.page.is_some() {
            return Vec::new();
        }
        let viewport = window.viewport_size();
        if viewport.height < px(180.) || viewport.width < px(180.) {
            return Vec::new();
        }
        let visible_limit =
            ((viewport.height.to_f64() as usize).saturating_sub(108) / 108).clamp(1, VISIBLE_LIMIT);
        let narrow = viewport.width < px(720.);
        let width = (viewport.width - px(24.)).max(px(0.)).min(px(340.));
        let visible: Vec<_> = self
            .endpoints
            .iter()
            .flat_map(|endpoint| {
                endpoint
                    .toasts
                    .entries
                    .iter()
                    .filter(|(_, notice)| notice.visible)
                    .map(move |(id, notice)| (endpoint, *id, notice))
            })
            .take(visible_limit)
            .collect();
        [
            ToastHerdrPosition::TopLeft,
            ToastHerdrPosition::TopRight,
            ToastHerdrPosition::BottomLeft,
            ToastHerdrPosition::BottomRight,
        ]
        .into_iter()
        .filter_map(|position| {
            let mut cards = Vec::new();
            for (endpoint, id, notice) in &visible {
                let corner = if narrow {
                    ToastHerdrPosition::BottomRight
                } else {
                    notice.position
                };
                if corner != position {
                    continue;
                }
                let endpoint_id = endpoint.id.clone();
                let inbox = endpoint.connection.inbox.clone();
                let generation = endpoint.generation;
                let id = *id;
                let accent = self.theme.ink(match notice.kind {
                    SemanticNotificationKind::NeedsAttention => self.theme.palette[3],
                    SemanticNotificationKind::Finished => self.theme.palette[2],
                    _ => self.theme.primary(),
                });
                cards.push(
                    div()
                        .id(SharedString::from(format!(
                            "toast-{}-{generation}-{id}",
                            endpoint.id
                        )))
                        .debug_selector({
                            let endpoint_id = endpoint.id.clone();
                            move || format!("toast-{endpoint_id}-{id}")
                        })
                        .occlude()
                        .w_full()
                        .flex_none()
                        .overflow_hidden()
                        .max_h((viewport.height - px(132.)) / visible_limit as f32)
                        .rounded(px(crate::config::corners::PANEL))
                        .border_1()
                        .border_color(rgb(accent))
                        .bg(rgb(self.theme.surface))
                        .text_color(rgb(self.theme.foreground))
                        .text_font(&self.config.ui)
                        .text_size(px(self.config.ui.size))
                        .p(px(10.))
                        .flex()
                        .gap(px(8.))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
                        .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                        .when(
                            endpoint
                                .live
                                .snapshot
                                .as_deref()
                                .and_then(|s| notice.target(s))
                                .is_some(),
                            |d| d.cursor_pointer(),
                        )
                        .on_click({
                            let endpoint_id = endpoint_id.clone();
                            let inbox = inbox.clone();
                            cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                this.click_toast(&endpoint_id, generation, &inbox, id, cx);
                            })
                        })
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(
                                    div()
                                        .truncate()
                                        .text_color(rgb(self.theme.muted))
                                        .child(safe_text(&endpoint.label, 80)),
                                )
                                .child(div().truncate().child(notice.title.clone()))
                                .when_some(notice.body.clone(), |d, body| {
                                    d.child(div().max_h(px(48.)).overflow_hidden().child(body))
                                }),
                        )
                        .child(
                            div()
                                .id("dismiss")
                                .debug_selector({
                                    let endpoint_id = endpoint.id.clone();
                                    move || format!("toast-dismiss-{endpoint_id}-{id}")
                                })
                                .flex_none()
                                .size(px(24.))
                                .rounded(px(crate::config::corners::CONTROL))
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .hover(|s| s.bg(rgb(self.theme.active)))
                                .child(
                                    svg()
                                        .path("icons/close.svg")
                                        .size(px(12.))
                                        .text_color(rgb(self.theme.foreground)),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    if let Some(endpoint) = this.endpoints.iter_mut().find(|e| {
                                        e.id == endpoint_id
                                            && e.generation == generation
                                            && std::sync::Arc::ptr_eq(&e.connection.inbox, &inbox)
                                    }) {
                                        endpoint.toasts.dismiss(id);
                                        cx.notify();
                                    }
                                })),
                        ),
                );
            }
            if cards.is_empty() {
                return None;
            }
            Some(
                div()
                    .absolute()
                    .w(width)
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .when(
                        matches!(
                            position,
                            ToastHerdrPosition::TopLeft | ToastHerdrPosition::TopRight
                        ),
                        |d| d.top(px(72.)),
                    )
                    .when(
                        matches!(
                            position,
                            ToastHerdrPosition::BottomLeft | ToastHerdrPosition::BottomRight
                        ),
                        |d| d.bottom(px(36.)),
                    )
                    .when(
                        matches!(
                            position,
                            ToastHerdrPosition::TopLeft | ToastHerdrPosition::BottomLeft
                        ),
                        |d| d.left(px(12.)),
                    )
                    .when(
                        matches!(
                            position,
                            ToastHerdrPosition::TopRight | ToastHerdrPosition::BottomRight
                        ),
                        |d| d.right(px(12.)),
                    )
                    .children(cards)
                    .into_any_element(),
            )
        })
        .collect()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
