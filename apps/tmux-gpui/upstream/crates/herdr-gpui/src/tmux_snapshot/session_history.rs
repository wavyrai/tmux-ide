//! Bridge-owned visited-session navigation; no native history ledger.
use super::{SnapshotView, browser};
use gpui::{Context, KeyDownEvent, Keystroke, Window};
use serde::Deserialize;
const MAX: u64 = 9_007_199_254_740_991;
fn token(value: &str) -> bool {
    value.len() == 36 && uuid::Uuid::parse_str(value).is_ok()
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Capability {
    pub revision: u64,
    pub back: Option<String>,
    pub forward: Option<String>,
}
impl Capability {
    pub(super) fn valid(&self) -> bool {
        self.revision > 0
            && self.revision <= MAX
            && self.back.as_ref().is_none_or(|v| token(v))
            && self.forward.as_ref().is_none_or(|v| token(v))
            && (self.back.is_none() || self.back != self.forward)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Rejected {
    pub request: u64,
    pub from_request: u64,
    pub revision: u64,
    pub action: String,
}
impl Rejected {
    pub(super) fn valid(&self) -> bool {
        self.request > self.from_request
            && self.request <= MAX
            && self.revision > 0
            && self.revision <= MAX
            && token(&self.action)
    }
}
#[derive(Default)]
pub(super) struct Owner {
    pub pending: Option<Rejected>,
    last_request: u64,
}
pub(super) fn shortcut(key: &Keystroke) -> bool {
    key.key == "f8" && !key.modifiers.platform && !key.modifiers.control && !key.modifiers.alt
}
impl SnapshotView {
    /// Include rejected/queued attempts, not only the last committed publication.
    pub(super) fn next_navigation_request(&self) -> Option<u64> {
        self.browser_request
            .max(self.attention.last_request)
            .max(self.palette.last_request)
            .max(self.session_history.last_request)
            .max(self.session_tabs.last_request)
            .max(self.workspace_fleet_agents.last_request)
            .checked_add(1)
            .filter(|v| *v <= MAX)
    }
    pub(super) fn session_history_key(
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
            || !self.presence.ready()
            || self.browser_state.request != self.browser_request
            || !self.marked.is_empty()
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || self.divider.is_some()
            || self.home_search_composing(window, cx)
            || self.workspace_fleet_agents.pending.is_some()
            || self.session_history.pending.is_some()
            || self.session_tabs.pending.is_some()
            || self.attention.pending.is_some()
            || self.palette.pending.is_some()
        {
            return true;
        }
        let Some(capability) = self
            .browser_state
            .session_history
            .as_ref()
            .filter(|c| c.valid())
        else {
            return true;
        };
        let action = if event.keystroke.modifiers.shift {
            &capability.forward
        } else {
            &capability.back
        };
        let Some(action) = action.clone() else {
            return true;
        };
        let revision = capability.revision;
        let Some(request) = self.next_navigation_request() else {
            return true;
        };
        self.session_history.last_request = request;
        let pending = Rejected {
            request,
            from_request: self.browser_request,
            revision,
            action,
        };
        if self.browser_commands.as_ref().is_some_and(|s| {
            s.try_send(browser::Command::SessionHistory {
                request,
                from_request: pending.from_request,
                revision,
                action: pending.action.clone(),
            })
            .is_ok()
        }) {
            self.session_history.pending = Some(pending);
        } else {
            self.browser_state.status = "History navigation queue unavailable — try again".into();
        }
        cx.notify();
        true
    }
    pub(super) fn accept_session_history_state(
        &mut self,
        state: &browser::State,
        cx: &mut Context<Self>,
    ) {
        let Some(pending) = self.session_history.pending.as_ref() else {
            return;
        };
        if self.browser_request != pending.from_request
            || (state.request == pending.from_request
                && state.session_history_rejected.as_ref() == Some(pending))
        {
            self.session_history.pending = None;
            // The old-request publication supplies the owner's truthful rejection status.
        } else if state.request == pending.request {
            self.browser_request = pending.request;
            self.session_history.pending = None;
            self.pending_session_open = (state.surface == browser::Surface::Workspace
                && state.selected_pane.is_none()
                && (state.frame.is_none() || state.retained_preview)
                && !state.input_ready)
                .then(|| super::session_open::Intent::admitted(state.request));
            self.header_controls = Default::default();
            self.sidebar_keyboard.active = false;
            self.cancel_attention();
            self.cancel_palette();
            self.picker = None;
            self.new_session = None;
            self.pane_actions = None;
            self.divider = None;
            self.clear_selection(cx);
            self.discard_composition(cx);
            self.wheel = Default::default();
            self.last_resize = None;
        }
    }
}
