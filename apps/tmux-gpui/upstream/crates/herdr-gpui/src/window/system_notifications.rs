//! OS notification center delivery for Herdr's shared `system` toast setting.
//!
//! GPUI owns the platform work: `UNUserNotificationCenter` on macOS (only from
//! an app bundle; it asks for permission on the first post), freedesktop
//! notifications over D-Bus on Linux, and WinRT toasts on Windows. Posting
//! never blocks this thread. Notifications are silent: sounds stay with the
//! sound service and its per-agent policy.
//!
//! GPUI accepts one app-wide response handler, so this registry routes a click
//! back to the window, host, and connection generation that posted it. The
//! window then resolves the target through the toast path, which rejects a
//! reconnected inbox or a restarted daemon instead of guessing.

use super::HerdrWindow;
use crate::{notifications::SystemPost, state::LiveState};
use gpui::{App, Context, Global, SharedString, SystemNotification, Window, WindowHandle};
use std::{
    collections::VecDeque,
    sync::{Mutex, Weak},
    time::{Duration, Instant},
};

/// Clicks are routed for this many recent posts; older ones only focus nothing.
const REGISTRY_LIMIT: usize = 64;
/// Two windows attached to the same host receive the same event. The second
/// window's copy within this interval is a duplicate, not a new event.
const DUPLICATE_WINDOW: Duration = Duration::from_secs(2);
/// Long enough to switch to another app before the QA preview arrives.
const PREVIEW_DELAY: Duration = Duration::from_secs(3);

struct Posted {
    tag: SharedString,
    window: WindowHandle<HerdrWindow>,
    endpoint: String,
    generation: u64,
    inbox: Weak<Mutex<LiveState>>,
    id: u64,
    at: Instant,
}

#[derive(Default)]
pub(crate) struct Registry {
    posted: VecDeque<Posted>,
    identity: bool,
}

impl Global for Registry {}

impl Registry {
    /// Whether another window already posted this tag just now.
    fn duplicate(&self, tag: &str, window: WindowHandle<HerdrWindow>, now: Instant) -> bool {
        self.posted.iter().any(|posted| {
            posted.tag == tag
                && posted.window != window
                && now.saturating_duration_since(posted.at) < DUPLICATE_WINDOW
        })
    }

    fn record(&mut self, posted: Posted) {
        self.posted.retain(|old| old.tag != posted.tag);
        if self.posted.len() == REGISTRY_LIMIT {
            self.posted.pop_front();
        }
        self.posted.push_back(posted);
    }

    fn find(&self, tag: &str) -> Option<&Posted> {
        self.posted.iter().rev().find(|posted| posted.tag == tag)
    }
}

/// Only the user's own app posts. Fixtures and tests leave this uninstalled,
/// so they never reach the notification center or prompt for permission.
pub(crate) fn install(cx: &mut App) {
    cx.set_global(Registry::default());
    cx.on_system_notification_response(|response, cx| {
        // No actions are offered: any activation opens the target.
        let Some((window, endpoint, generation, inbox, id)) =
            cx.try_global::<Registry>().and_then(|registry| {
                let posted = registry.find(&response.tag)?;
                Some((
                    posted.window,
                    posted.endpoint.clone(),
                    posted.generation,
                    posted.inbox.clone(),
                    posted.id,
                ))
            })
        else {
            return;
        };
        cx.activate(true);
        let _ = window.update(cx, |view, window, cx| {
            view.open_system_notification(&endpoint, generation, &inbox, id, window, cx);
        });
    });
}

fn body(label: Option<&str>, body: Option<&str>) -> SharedString {
    match (label, body) {
        (Some(label), Some(body)) => format!("{label}\n{body}").into(),
        (Some(text), None) | (None, Some(text)) => SharedString::from(text.to_owned()),
        (None, None) => SharedString::default(),
    }
}

impl HerdrWindow {
    /// Posts what the last tick made ready. Runs from the poll loop only.
    pub(crate) fn post_system_notifications(&mut self, window: &Window, cx: &mut Context<Self>) {
        let posts =
            crate::notifications::take_system(&mut self.endpoints, self.config.notifications);
        if posts.is_empty() {
            return;
        }
        let Some(handle) = window.window_handle().downcast::<HerdrWindow>() else {
            return;
        };
        let now = Instant::now();
        for post in posts {
            if cx
                .try_global::<Registry>()
                .is_some_and(|registry| registry.duplicate(&post.tag, handle, now))
            {
                continue;
            }
            self.show_system_notification(handle, post, now, cx);
        }
    }

    /// Hands one notice to the OS and records where its click goes. A no-op
    /// without the registry, which only normal launches install.
    fn show_system_notification(
        &self,
        handle: WindowHandle<HerdrWindow>,
        post: SystemPost,
        now: Instant,
        cx: &mut Context<Self>,
    ) {
        let SystemPost {
            endpoint,
            id,
            tag,
            title,
            body: text,
        } = post;
        let Some(source) = self.endpoints.get(endpoint) else {
            return;
        };
        let Some(registry) = cx.try_global::<Registry>() else {
            return;
        };
        // Windows needs an AppUserModelID to show toasts, and setting one
        // changes taskbar grouping, so only users of system delivery get it.
        if !registry.identity {
            cx.set_app_identity(crate::constants::APP_ID, crate::constants::WINDOW_TITLE);
            cx.global_mut::<Registry>().identity = true;
        }
        let label =
            (self.endpoints.len() > 1).then(|| crate::notifications::safe_text(&source.label, 80));
        let tag = SharedString::from(tag);
        let notification = SystemNotification {
            tag: tag.clone(),
            title: title.into(),
            body: body(label.as_deref(), text.as_deref()),
            actions: Vec::new(),
        };
        cx.global_mut::<Registry>().record(Posted {
            tag,
            window: handle,
            endpoint: source.id.clone(),
            generation: source.generation,
            inbox: std::sync::Arc::downgrade(&source.connection.inbox),
            id,
            at: now,
        });
        cx.show_system_notification(notification);
    }

    /// QA: after a delay long enough to switch away, posts a NeedsAttention
    /// preview for the selected host's focused pane, whatever the delivery
    /// setting, so the banner and its click can be checked by hand.
    pub(crate) fn show_system_notification_preview(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let Some(handle) = window.window_handle().downcast::<HerdrWindow>() else {
            return;
        };
        let timer = cx.background_executor().timer(PREVIEW_DELAY);
        cx.spawn(async move |this, cx| {
            timer.await;
            let _ = this.update(cx, |view, cx| {
                view.post_system_notification_preview(handle, cx)
            });
        })
        .detach();
    }

    fn post_system_notification_preview(
        &mut self,
        handle: WindowHandle<HerdrWindow>,
        cx: &mut Context<Self>,
    ) {
        let index = self.selected_endpoint;
        let snapshot = self.endpoints[index].live.snapshot.clone();
        let mut notice = crate::notifications::Notice::new(
            herdr_client::protocol::SemanticNotification {
                kind: herdr_client::protocol::SemanticNotificationKind::NeedsAttention,
                title: "Needs attention".into(),
                body: Some("QA preview: an agent is waiting for your input.".into()),
                sound: None,
                agent: None,
                workspace_id: snapshot
                    .as_ref()
                    .and_then(|s| s.focused_workspace_id.clone()),
                tab_id: snapshot.as_ref().and_then(|s| s.focused_tab_id.clone()),
                pane_id: snapshot.as_ref().and_then(|s| s.focused_pane_id.clone()),
                position: None,
            },
            Instant::now(),
        )
        .with_snapshot(snapshot.as_deref())
        .preview();
        // Retained like a real post, so a click resolves through the same path.
        notice.posted = true;
        let post = SystemPost {
            endpoint: index,
            id: 0,
            tag: format!("herdr-preview:{}", self.endpoints[index].id),
            title: notice.title.clone(),
            body: notice.body.clone(),
        };
        let toasts = &mut self.endpoints[index].toasts;
        toasts.receive([notice]);
        let Some((id, _)) = toasts.entries.back() else {
            return;
        };
        let post = SystemPost { id: *id, ..post };
        self.show_system_notification(handle, post, Instant::now(), cx);
    }

    /// A click brings this window forward, then navigates like a toast click
    /// when the posting connection is still the current one.
    pub(crate) fn open_system_notification(
        &mut self,
        endpoint_id: &str,
        generation: u64,
        inbox: &Weak<Mutex<LiveState>>,
        id: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.activate_window();
        if self.menu.page.is_some() {
            return;
        }
        let Some(inbox) = inbox.upgrade() else {
            return;
        };
        let Some(index) = self.endpoints.iter().position(|e| {
            e.id == endpoint_id
                && e.generation == generation
                && std::sync::Arc::ptr_eq(&e.connection.inbox, &inbox)
        }) else {
            return;
        };
        self.open_notice(index, id, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::{PREVIEW_DELAY, body};
    use gpui::TestAppContext;

    #[gpui::test]
    #[allow(clippy::unwrap_used)]
    fn qa_preview_posts_for_the_focused_pane_after_the_delay(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        cx.update(|_, cx| super::install(cx));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| window.focus(&view.focus, cx));
            window.draw(cx).clear(cx);
            window.dispatch_action(Box::new(crate::actions::ShowSystemNotificationPreview), cx);
        });
        cx.run_until_parked();
        // Delivery is off in the fixture: the preview ignores it, but waits.
        assert!(cx.shown_system_notifications().is_empty());
        cx.executor().advance_clock(PREVIEW_DELAY);
        cx.run_until_parked();
        let shown = cx.shown_system_notifications();
        let [shown] = shown.as_slice() else {
            panic!("expected one notification: {shown:?}");
        };
        assert_eq!(shown.tag, "herdr-preview:local");
        assert_eq!(shown.title, "Needs attention");
        assert!(shown.body.starts_with("QA preview"));
        view.read_with(cx, |view, _| {
            let (_, notice) = view.endpoints[0].toasts.entries.back().unwrap();
            assert!(notice.posted && !notice.visible);
            assert_eq!(
                notice.pane_id,
                view.live.snapshot.as_ref().unwrap().focused_pane_id
            );
        });
    }

    #[test]
    fn host_label_leads_the_body_only_when_given() {
        assert_eq!(body(None, None), "");
        assert_eq!(body(None, Some("Review")), "Review");
        assert_eq!(body(Some("build box"), None), "build box");
        assert_eq!(body(Some("build box"), Some("Review")), "build box\nReview");
    }
}
