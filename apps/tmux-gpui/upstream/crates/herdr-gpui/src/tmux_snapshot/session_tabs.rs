//! Retained session targets belong to the bridge; this owner only correlates commands.
use super::{SnapshotView, browser};
use gpui::{Context, KeyDownEvent, Keystroke, ScrollHandle, Window};
use serde::Deserialize;
use std::collections::HashSet;
mod focus;
mod render;
mod selection;
#[cfg(test)]
mod tests;
const MAX: u64 = 9_007_199_254_740_991;
fn token(s: &str) -> bool {
    s.len() == 36 && uuid::Uuid::parse_str(s).is_ok()
}
fn label(s: &str) -> bool {
    s.chars().count() <= 160 && !s.chars().any(char::is_control)
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Row {
    pub id: String,
    pub label: String,
    pub host_label: String,
    pub server_label: Option<String>,
    pub available: bool,
    pub unread: bool,
    pub activity: Option<Activity>,
    pub activate: String,
    pub close: String,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Activity {
    Failed,
    Waiting,
    Running,
    Idle,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Publication {
    pub request: u64,
    pub revision: u64,
    pub rows: Vec<Row>,
    pub active: Option<String>,
    pub pending: Option<String>,
    pub next: Option<String>,
    pub previous: Option<String>,
    pub close_active: Option<String>,
}
impl Publication {
    pub(super) fn valid(&self) -> bool {
        let mut ids = HashSet::new();
        let mut actions = HashSet::new();
        self.request <= MAX
            && self.revision > 0
            && self.revision <= MAX
            && self.rows.len() <= 8
            && self.rows.iter().all(|r| {
                token(&r.id)
                    && ids.insert(&r.id)
                    && label(&r.label)
                    && label(&r.host_label)
                    && r.server_label.as_ref().is_none_or(|v| label(v))
                    && token(&r.activate)
                    && token(&r.close)
                    && actions.insert(&r.activate)
                    && actions.insert(&r.close)
            })
            && [&self.active, &self.pending]
                .into_iter()
                .all(|id| id.as_ref().is_none_or(|id| ids.contains(id)))
            && [&self.next, &self.previous].into_iter().all(|action| {
                action
                    .as_ref()
                    .is_none_or(|a| self.rows.iter().any(|r| &r.activate == a))
            })
            && self.close_active.as_ref().is_none_or(|a| {
                self.rows
                    .iter()
                    .any(|r| Some(&r.id) == self.active.as_ref() && &r.close == a)
            })
    }
    fn has_action(&self, action: &str) -> bool {
        self.rows
            .iter()
            .any(|r| r.activate == action || r.close == action)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Result {
    pub request: u64,
    pub from_request: u64,
    pub revision: u64,
    pub action: String,
    pub outcome: Outcome,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Outcome {
    Rejected,
    Closed,
}
impl Result {
    pub(super) fn valid(&self) -> bool {
        self.request > self.from_request
            && self.request <= MAX
            && self.revision > 0
            && self.revision <= MAX
            && token(&self.action)
    }
}
#[derive(Clone)]
pub(super) struct Pending {
    closing: bool,
    request: u64,
    from_request: u64,
    revision: u64,
    action: String,
}
#[derive(Default)]
pub(super) struct Owner {
    pub pending: Option<Pending>,
    pub last_request: u64,
    pub(super) focus: focus::Focus,
    pub(super) selections: selection::Selections,
    scroll: ScrollHandle,
}
pub(super) fn shortcut(key: &Keystroke) -> bool {
    key.key == "f9" && !key.modifiers.platform && !key.modifiers.alt
}
impl SnapshotView {
    fn session_tabs_allowed(&self, window: &Window, cx: &Context<Self>) -> bool {
        self.presence.ready()
            && self.browser_state.request == self.browser_request
            && self.marked.is_empty()
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
            && self.divider.is_none()
            && !self.home_search_composing(window, cx)
            && self.session_tabs.pending.is_none()
            && self.session_history.pending.is_none()
            && self.palette.pending.is_none()
            && self.attention.pending.is_none()
            && self.workspace_fleet_agents.pending.is_none()
    }
    pub(super) fn session_tabs_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !shortcut(&event.keystroke) {
            return false;
        }
        cx.stop_propagation();
        window.prevent_default();
        if event.is_held
            || (event.keystroke.modifiers.control && event.keystroke.modifiers.shift)
            || !self.session_tabs_allowed(window, cx)
        {
            return true;
        }
        if let Some(p) = &self.browser_state.session_tabs {
            let action = if event.keystroke.modifiers.control {
                &p.close_active
            } else if event.keystroke.modifiers.shift {
                &p.previous
            } else {
                &p.next
            };
            if let Some(action) = action.clone() {
                self.choose_session_tab(p.request, p.revision, &action, window, cx);
            }
        }
        true
    }
    pub(super) fn choose_session_tab(
        &mut self,
        request: u64,
        revision: u64,
        action: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if request != self.browser_request
            || !self.session_tabs_allowed(window, cx)
            || !self.browser_state.session_tabs.as_ref().is_some_and(|p| {
                p.request == request && p.revision == revision && p.valid() && p.has_action(action)
            })
        {
            return;
        }
        let Some(next) = self.next_navigation_request() else {
            return;
        };
        self.session_tabs.last_request = next;
        if self.browser_commands.as_ref().is_some_and(|s| {
            s.try_send(browser::Command::SessionTab {
                request: next,
                from_request: request,
                revision,
                action: action.into(),
            })
            .is_ok()
        }) {
            self.remember_tab_focus(window);
            self.remember_tab_selection();
            let closing = self
                .browser_state
                .session_tabs
                .as_ref()
                .is_some_and(|p| p.rows.iter().any(|r| r.close == action));
            self.session_tabs.pending = Some(Pending {
                closing,
                request: next,
                from_request: request,
                revision,
                action: action.into(),
            });
        } else {
            self.browser_state.status = "Session tab queue unavailable — try again".into();
        }
        cx.notify();
    }
    pub(super) fn accept_session_tabs_state(
        &mut self,
        state: &browser::State,
        cx: &mut Context<Self>,
    ) {
        let Some(pending) = &self.session_tabs.pending else {
            return;
        };
        if self.browser_request != pending.from_request
            || (state.request == pending.from_request
                && state.session_tab_result.as_ref().is_some_and(|r| {
                    (r.outcome == Outcome::Rejected
                        || (r.outcome == Outcome::Closed && pending.closing))
                        && r.request == pending.request
                        && r.from_request == pending.from_request
                        && r.revision == pending.revision
                        && r.action == pending.action
                }))
        {
            self.session_tabs.pending = None;
            self.cancel_tab_focus_restore();
            self.cancel_tab_selection_restore();
        } else if state.request == pending.request {
            self.browser_request = pending.request;
            self.pending_session_open = (!pending.closing
                && state.surface == browser::Surface::Workspace
                && state.selected_pane.is_none()
                && (state.frame.is_none() || state.retained_preview)
                && !state.input_ready)
                .then(|| super::session_open::Intent::admitted(state.request));
            self.session_tabs.pending = None;
            self.header_controls = Default::default();
            self.sidebar_keyboard.active = false;
            self.cancel_attention();
            self.cancel_palette();
            self.picker = None;
            self.new_session = None;
            self.pane_actions = None;
            self.divider = None;
            let restore_selection = self.session_tabs.selections.restore;
            self.clear_selection(cx);
            self.session_tabs.selections.restore = restore_selection;
            self.discard_composition(cx);
            self.wheel = Default::default();
            self.last_resize = None;
        }
    }
}
