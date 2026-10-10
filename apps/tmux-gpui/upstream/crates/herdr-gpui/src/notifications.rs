//! Bounded presentation data with snapshot-validated navigation hints.
use crate::navigation::NavigationTarget;
use herdr_client::protocol::ClientShellSnapshot;
use herdr_client::protocol::{SemanticNotification, SemanticNotificationKind, ToastHerdrPosition};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

pub(crate) const PENDING_LIMIT: usize = 8;
pub(crate) const VISIBLE_LIMIT: usize = 1;
const GRACE: Duration = Duration::from_secs(1);
const RECHECK: Duration = Duration::from_millis(50);
static ARRIVAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
mod policy_tests;

#[derive(Clone)]
pub(crate) struct Notice {
    pub title: String,
    pub body: Option<String>,
    pub kind: SemanticNotificationKind,
    pub position: ToastHerdrPosition,
    pub expires: Instant,
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    boot: Option<String>,
    initialized: bool,
    arrived: Instant,
    order: u64,
    explicit_position: bool,
    client_local: bool,
    ready: bool,
    pub(crate) visible: bool,
    checked: Option<Instant>,
    displayed: Option<(Instant, bool)>,
    suppression_target: Option<crate::navigation::OwnedNavigationTarget>,
    /// Handed to the OS notification center. Retained only so a click can
    /// resolve its target through the same boot-fenced validation as a toast.
    pub(crate) posted: bool,
}

pub(crate) fn safe_text(text: &str, limit: usize) -> String {
    // Bound scanning as well as output, even for a payload made entirely of controls.
    text.chars()
        .take(limit)
        .filter(|c| !unsafe_char(*c))
        .collect()
}

/// A control or direction-override character, which untrusted text loses.
pub(crate) fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}' | '\u{061c}' | '\u{2028}' | '\u{2029}')
}

impl Notice {
    pub fn preview(mut self) -> Self {
        self.client_local = true;
        self
    }

    /// Feedback for a user action is not governed by daemon notification mutes,
    /// activity evidence, or focused-pane suppression. It still uses the queue.
    pub fn local_feedback(notification: SemanticNotification, now: Instant) -> Self {
        let mut notice = Self::new(notification, now);
        notice.client_local = true;
        notice
    }

    pub fn promote(&mut self, now: Instant) {
        self.ready = true;
        self.visible = true;
        self.displayed = Some((now, false));
        self.expires = now
            + Duration::from_secs(match self.kind {
                SemanticNotificationKind::NeedsAttention => 8,
                SemanticNotificationKind::Finished | SemanticNotificationKind::Custom => 5,
                SemanticNotificationKind::UpdateInstalled => 3,
            });
    }
    pub fn new(notification: SemanticNotification, now: Instant) -> Self {
        let title = safe_text(&notification.title, 160);
        let suppression_target = notification
            .tab_id
            .clone()
            .map(NavigationTarget::Tab)
            .or_else(|| {
                notification
                    .workspace_id
                    .clone()
                    .map(NavigationTarget::Workspace)
            });
        Self {
            title: if title.trim().is_empty() {
                "Notification".into()
            } else {
                title
            },
            body: notification
                .body
                .map(|body| safe_text(&body, 512))
                .filter(|body| !body.trim().is_empty()),
            kind: notification.kind,
            position: notification
                .position
                .unwrap_or(ToastHerdrPosition::BottomRight),
            expires: now,
            workspace_id: notification.workspace_id,
            tab_id: notification.tab_id,
            pane_id: notification.pane_id,
            boot: None,
            initialized: false,
            arrived: now,
            order: ARRIVAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            explicit_position: notification.position.is_some(),
            client_local: false,
            ready: false,
            visible: false,
            checked: None,
            displayed: None,
            suppression_target,
            posted: false,
        }
    }

    pub fn with_snapshot(mut self, snapshot: Option<&ClientShellSnapshot>) -> Self {
        if let Some(snapshot) = snapshot {
            self.initialize(snapshot);
        }
        self
    }

    fn initialize(&mut self, snapshot: &ClientShellSnapshot) {
        if self.initialized
            || self
                .boot
                .as_ref()
                .is_some_and(|boot| *boot != snapshot.boot_id)
        {
            return;
        }
        self.boot.get_or_insert_with(|| snapshot.boot_id.clone());
        // Retain inferred parents too, so a later reparenting cannot retarget a click.
        if self.resolve_target(snapshot).is_some() {
            if let Some(pane) = snapshot
                .panes
                .iter()
                .find(|p| Some(&p.pane_id) == self.pane_id.as_ref())
            {
                self.tab_id = Some(pane.tab_id.clone());
                self.workspace_id = Some(pane.workspace_id.clone());
            } else if let Some(tab) = snapshot
                .tabs
                .iter()
                .find(|t| Some(&t.tab_id) == self.tab_id.as_ref())
            {
                self.workspace_id = Some(tab.workspace_id.clone());
            }
        }
        self.initialized = self.resolve_target(snapshot).is_some();
    }

    pub fn target<'a>(
        &'a self,
        snapshot: &ClientShellSnapshot,
    ) -> Option<NavigationTarget<&'a str>> {
        if !self.initialized {
            return None;
        }
        self.resolve_target(snapshot)
    }

    fn resolve_target<'a>(
        &'a self,
        snapshot: &ClientShellSnapshot,
    ) -> Option<NavigationTarget<&'a str>> {
        if self.boot.as_deref() != Some(snapshot.boot_id.as_str()) {
            return None;
        }
        let workspace = self.workspace_id.as_deref();
        let tab = self.tab_id.as_deref();
        if let Some(id) = self.pane_id.as_deref() {
            let pane = snapshot.panes.iter().find(|p| p.pane_id == id)?;
            if workspace.is_some_and(|w| w != pane.workspace_id)
                || tab.is_some_and(|t| t != pane.tab_id)
            {
                return None;
            }
            let parent = snapshot
                .tabs
                .iter()
                .find(|t| t.tab_id == pane.tab_id && t.workspace_id == pane.workspace_id)?;
            snapshot
                .workspaces
                .iter()
                .find(|w| w.workspace_id == parent.workspace_id)?;
            return Some(NavigationTarget::Pane(id));
        }
        if let Some(id) = tab {
            let tab = snapshot.tabs.iter().find(|t| t.tab_id == id)?;
            if workspace.is_some_and(|w| w != tab.workspace_id) {
                return None;
            }
            snapshot
                .workspaces
                .iter()
                .find(|w| w.workspace_id == tab.workspace_id)?;
            return Some(NavigationTarget::Tab(id));
        }
        let id = workspace?;
        snapshot.workspaces.iter().find(|w| w.workspace_id == id)?;
        Some(NavigationTarget::Workspace(id))
    }
}

#[derive(Default)]
pub(crate) struct Toasts {
    pub entries: VecDeque<(u64, Notice)>,
    next_id: u64,
    pub(crate) enabled_since: Option<Instant>,
}

impl Toasts {
    pub fn receive(&mut self, notices: impl IntoIterator<Item = Notice>) {
        for notice in notices {
            if !notice.client_local
                && self
                    .enabled_since
                    .is_some_and(|cutoff| notice.arrived <= cutoff)
            {
                continue;
            }
            if let Some(pane) = &notice.pane_id {
                self.entries
                    .retain(|(_, old)| old.pane_id.as_ref() != Some(pane));
            }
            if self.entries.len() == PENDING_LIMIT * 2 + 1
                && let Some(index) = self.entries.iter().position(|(_, n)| !n.visible)
            {
                self.entries.remove(index);
            }
            self.entries.push_back((self.next_id, notice));
            self.next_id = self.next_id.wrapping_add(1);
        }
    }

    pub fn dismiss(&mut self, id: u64) {
        self.entries.retain(|(entry, _)| *entry != id);
    }
}

/// Endpoint ownership retains the existing generation/inbox fences. This single
/// window-wide scheduler imposes ordering and bounds, independent of host order.
///
/// With system delivery, daemon notices that pass the same evidence and delay
/// policy wait for [`take_system`] instead of the in-app queue. Like Herdr, the
/// active tab suppresses them only while this window is `focused`.
pub(crate) fn tick(
    endpoints: &mut [crate::endpoint::Endpoint],
    selected: usize,
    config: crate::config::NotificationConfig,
    hidden: bool,
    focused: bool,
    pending_navigation: Option<u64>,
    now: Instant,
) -> bool {
    use crate::config::NotificationDelivery as Delivery;
    use herdr_client::protocol::{AgentStatus, SemanticNotificationKind as Kind};
    let delivery = config.delivery();
    let system = delivery == Delivery::System;
    let mut changed = false;
    for (index, endpoint) in endpoints.iter_mut().enumerate() {
        let snapshot = endpoint.live.snapshot.as_deref();
        endpoint.toasts.entries.retain_mut(|(id, n)| {
            let keep = (|| {
                if !n.client_local
                    && (delivery == Delivery::Off
                        || endpoint
                            .toasts
                            .enabled_since
                            .is_some_and(|cutoff| n.arrived <= cutoff))
                {
                    return false;
                }
                if !n.explicit_position {
                    n.position = config.position;
                }
                if let Some(s) = snapshot {
                    if n.boot.as_ref().is_some_and(|boot| *boot != s.boot_id) {
                        return false;
                    }
                    if !n.initialized && now <= n.arrived + GRACE {
                        n.initialize(s);
                    }
                }
                if n.posted {
                    return true;
                }
                if n.visible {
                    let paused = hidden || (index == selected && pending_navigation == Some(*id));
                    if let Some((last, was_hidden)) = n.displayed.replace((now, paused))
                        && (paused || was_hidden)
                    {
                        n.expires += now.saturating_duration_since(last);
                    }
                    return paused || now < n.expires;
                }
                if n.ready {
                    return true;
                }
                if !n.client_local {
                    let delay = if n.kind == Kind::Custom {
                        0
                    } else {
                        config.delay_seconds
                    };
                    if now < n.arrived + Duration::from_secs(delay)
                        || n.checked
                            .is_some_and(|last| now < (last + RECHECK).min(n.arrived + GRACE))
                    {
                        return true;
                    }
                    n.checked = Some(now);
                    if delay > 0 || n.kind == Kind::Finished {
                        if let Some(pane) = n.pane_id.as_deref() {
                            let status = snapshot
                                .and_then(|s| s.agents.iter().find(|a| a.pane_id == pane))
                                .map(|a| a.agent_status);
                            let awaiting = status.is_none()
                                || (n.kind == Kind::Finished
                                    && status == Some(AgentStatus::Working));
                            if awaiting {
                                return now < n.arrived + GRACE;
                            }
                            match n.kind {
                                Kind::NeedsAttention if status != Some(AgentStatus::Blocked) => {
                                    return false;
                                }
                                Kind::Finished if status != Some(AgentStatus::Done) => {
                                    return false;
                                }
                                _ => {}
                            }
                        } else if n.kind == Kind::Finished {
                            return false;
                        }
                    }
                    if index == selected
                        && (!system || focused)
                        && snapshot.is_some_and(|s| match n.suppression_target.as_ref() {
                            Some(NavigationTarget::Tab(tab)) => {
                                s.focused_tab_id.as_ref() == Some(tab)
                            }
                            Some(NavigationTarget::Workspace(w)) => {
                                s.focused_workspace_id.as_ref() == Some(w)
                            }
                            _ => false,
                        })
                    {
                        return false;
                    }
                }
                n.ready = true;
                true
            })();
            changed |= !keep;
            keep
        });
    }
    // Only scalar keys are collected; notification payloads remain endpoint-owned.
    for ready in [false, true] {
        let mut queued: Vec<_> = endpoints
            .iter()
            .enumerate()
            .flat_map(|(index, e)| {
                e.toasts
                    .entries
                    .iter()
                    .filter(move |(_, n)| {
                        n.ready == ready && !n.visible && !n.posted && (n.client_local || !system)
                    })
                    .map(move |(id, n)| (n.arrived, n.order, index, *id))
            })
            .collect();
        queued.sort_unstable();
        let visible = endpoints
            .iter()
            .any(|e| e.toasts.entries.iter().any(|(_, n)| n.visible));
        if ready && !visible && !hidden && !queued.is_empty() {
            let (_, _, index, id) = queued.remove(0);
            if let Some((_, n)) = endpoints[index]
                .toasts
                .entries
                .iter_mut()
                .find(|(entry, _)| *entry == id)
            {
                n.promote(now);
                changed = true;
            }
        }
        let limit = PENDING_LIMIT;
        let overflow = queued.len().saturating_sub(limit);
        for &(_, _, index, id) in queued.iter().take(overflow) {
            endpoints[index].toasts.dismiss(id);
            changed = true;
        }
    }
    changed
}

/// A ready daemon notice for the OS notification center, already sanitized
/// and bounded by [`Notice::new`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SystemPost {
    pub endpoint: usize,
    pub id: u64,
    /// Stable per host, boot, and pane, so a newer event replaces the older
    /// one where the platform supports it, as Herdr's TUI does.
    pub tag: String,
    pub title: String,
    pub body: Option<String>,
}

/// Marks every notice [`tick`] made ready for system delivery as posted and
/// returns them in global arrival order. Call only from the poll loop: render
/// also ticks, but must never post.
pub(crate) fn take_system(
    endpoints: &mut [crate::endpoint::Endpoint],
    config: crate::config::NotificationConfig,
) -> Vec<SystemPost> {
    if config.delivery() != crate::config::NotificationDelivery::System {
        return Vec::new();
    }
    let mut posts = Vec::new();
    for (index, endpoint) in endpoints.iter_mut().enumerate() {
        for (id, n) in &mut endpoint.toasts.entries {
            if !n.ready || n.posted || n.visible || n.client_local {
                continue;
            }
            n.posted = true;
            let boot = n.boot.as_deref().unwrap_or_default();
            let tag = match &n.pane_id {
                Some(pane) => format!("herdr:{}:{boot}:{pane}", endpoint.id),
                None => format!("herdr:{}:{boot}:#{}", endpoint.id, n.order),
            };
            posts.push((
                (n.arrived, n.order),
                SystemPost {
                    endpoint: index,
                    id: *id,
                    tag,
                    title: n.title.clone(),
                    body: n.body.clone(),
                },
            ));
        }
        // Posted notices only answer clicks; keep the newest few per host.
        let posted = endpoint
            .toasts
            .entries
            .iter()
            .filter(|(_, n)| n.posted)
            .count();
        let mut excess = posted.saturating_sub(PENDING_LIMIT);
        endpoint.toasts.entries.retain(|(_, n)| {
            let drop = excess > 0 && n.posted;
            excess -= usize::from(drop);
            !drop
        });
    }
    posts.sort_unstable_by_key(|(key, _)| *key);
    posts.into_iter().map(|(_, post)| post).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn notification(title: &str) -> SemanticNotification {
        SemanticNotification {
            kind: SemanticNotificationKind::NeedsAttention,
            title: title.into(),
            body: Some("Review needed".into()),
            sound: Some(herdr_client::protocol::SemanticNotificationSound::Request),
            agent: Some("untrusted".into()),
            workspace_id: Some("duplicate-id".into()),
            tab_id: None,
            pane_id: None,
            position: Some(ToastHerdrPosition::TopLeft),
        }
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn targets_validate_specificity_membership_and_boot_without_fallback() {
        let snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
            "../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap();
        for (tab, pane, expected) in [
            (None, None, NavigationTarget::Workspace("w1")),
            (Some("w1:t1"), None, NavigationTarget::Tab("w1:t1")),
            (
                Some("w1:t1"),
                Some("w1:p1"),
                NavigationTarget::Pane("w1:p1"),
            ),
        ] {
            let mut wire = notification("target");
            wire.workspace_id = Some("w1".into());
            wire.tab_id = tab.map(str::to_owned);
            wire.pane_id = pane.map(str::to_owned);
            let notice = Notice::new(wire, Instant::now()).with_snapshot(Some(&snapshot));
            assert_eq!(notice.target(&snapshot), Some(expected));
            let mut stale = snapshot.clone();
            stale.boot_id = "new-boot".into();
            assert!(notice.target(&stale).is_none());
            stale = snapshot.clone();
            stale.workspaces.clear();
            assert!(notice.target(&stale).is_none());
            if tab.is_some() {
                stale = snapshot.clone();
                stale.tabs.clear();
                assert!(notice.target(&stale).is_none());
            }
            if pane.is_some() {
                stale = snapshot.clone();
                stale.panes.clear();
                assert!(notice.target(&stale).is_none());
            }
        }
        let mut wire = notification("pane only");
        wire.workspace_id = None;
        wire.pane_id = Some("w1:p1".into());
        let notice = Notice::new(wire.clone(), Instant::now()).with_snapshot(Some(&snapshot));
        assert_eq!(notice.workspace_id.as_deref(), Some("w1"));
        assert_eq!(notice.tab_id.as_deref(), Some("w1:t1"));
        let mut moved = snapshot.clone();
        moved.panes[0].tab_id = "other".into();
        assert!(notice.target(&moved).is_none());
        wire.tab_id = Some("wrong-parent".into());
        assert!(
            Notice::new(wire, Instant::now())
                .with_snapshot(Some(&snapshot))
                .target(&snapshot)
                .is_none()
        );
        let mut custom = notification("custom");
        custom.kind = SemanticNotificationKind::Custom;
        custom.workspace_id = None;
        assert!(
            Notice::new(custom, Instant::now())
                .with_snapshot(Some(&snapshot))
                .target(&snapshot)
                .is_none()
        );
    }

    #[test]
    fn notifications_bound_untrusted_text_and_preserve_position() {
        let mut wire = notification(&"\u{1b}\n\u{202e}\u{2066}界".repeat(1000));
        wire.body = Some("界".repeat(1000));
        let notice = Notice::new(wire, Instant::now());
        assert!(notice.title.chars().count() <= 160);
        assert!(notice.title.chars().all(|c| c == '界'));
        assert_eq!(notice.body.as_ref().map(|b| b.chars().count()), Some(512));
        assert_eq!(notice.position, ToastHerdrPosition::TopLeft);
        assert_eq!(safe_text(&"\0".repeat(10000), 160), "");
        assert_eq!(
            Notice::new(notification("\n\u{202e}"), Instant::now()).title,
            "Notification"
        );
    }

    #[test]
    fn ingress_is_bounded_and_same_pane_replaces_without_coalescing_targetless() {
        let now = Instant::now();
        let mut toasts = Toasts::default();
        toasts.receive((0..20).map(|id| Notice::new(notification(&id.to_string()), now)));
        assert_eq!(toasts.entries.len(), PENDING_LIMIT * 2 + 1);
        assert_eq!(toasts.entries[0].1.title, "3");
        toasts.dismiss(18);
        assert_eq!(toasts.entries.len(), 16);
        let mut wire = notification("pane");
        wire.pane_id = Some("p".into());
        toasts.receive([Notice::new(wire.clone(), now), Notice::new(wire, now)]);
        assert_eq!(toasts.entries.len(), 17);
    }
}
