//! F5 shares the fleet observation owner, with one query-scoped projection at a time.
use super::*;
use attention::Rejected;
use std::time::{Duration, Instant};
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Owner {
    next: u64,
    pub(in crate::tmux_snapshot) last_request: u64,
    pub(in crate::tmux_snapshot) pending: Option<Rejected>,
    pub(super) active: Option<(u64, u64)>,
    remote_observed: Option<(u64, u64)>,
    pending_close: Option<(u64, u64, u16)>,
    query: Option<String>,
    due: Option<Instant>,
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn cancel_palette(&mut self) {
        self.palette.active = None;
        if let Some((request, scope)) = self.palette.remote_observed.take() {
            self.palette.pending_close = Some((request, scope, 0));
        }
        self.palette.query = None;
        self.palette.due = None;
        self.flush_palette_close();
    }
    fn flush_palette_close(&mut self) {
        let Some((request, scope, tries)) = self.palette.pending_close else {
            return;
        };
        let Some(sender) = &self.browser_commands else {
            self.palette.pending_close = None;
            return;
        };
        if tries >= 300 {
            return;
        }
        match sender.try_send(browser::Command::PaletteObserve {
            request,
            scope,
            active: false,
            query: String::new(),
        }) {
            Ok(()) | Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                self.palette.pending_close = None
            }
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                self.palette.pending_close = Some((request, scope, tries + 1))
            }
        }
    }
    pub(super) fn reopen_palette(&mut self) {
        if let Some((request, scope, _)) = self.palette.pending_close {
            self.palette.pending_close = Some((request, scope, 0));
            self.flush_palette_close();
        }
    }
    pub(super) fn sync_palette_query(&mut self, cx: &mut Context<Self>) {
        let query = self
            .picker
            .as_ref()
            .filter(|p| {
                p.mode == Mode::Commands
                    && p.pane_scope.is_none()
                    && p.closing.is_none()
                    && p.agent.is_none()
                    && p.edit.is_none()
                    && p.removal.is_none()
                    && p.request == self.browser_request
                    && !p.search.read(cx).is_composing()
            })
            .filter(|_| {
                self.browser_state.palette_supported
                    && self.browser_state.fleet.is_some()
                    && self.presence.ready()
            })
            .map(|p| p.search.read(cx).text().to_owned());
        if query == self.palette.query {
            return;
        }
        // Query replacement invalidates local targets immediately but keeps the
        // sole fleet subscription alive until the higher scope updates its query.
        if query.as_ref().is_some_and(|q| q.chars().count() <= 256)
            && self
                .palette
                .remote_observed
                .is_some_and(|(request, _)| request == self.browser_request)
        {
            self.palette.active = None;
        } else {
            self.cancel_palette();
        }
        if query.as_ref().is_some_and(|q| q.chars().count() > 256)
            && let Some(picker) = &mut self.picker
        {
            picker.error = Some("Fleet search is limited to 256 characters");
        }
        if let Some(query) = query.filter(|q| q.chars().count() <= 256) {
            self.palette.query = Some(query);
            self.palette.due = Some(Instant::now() + Duration::from_millis(120));
        }
    }
    pub(in crate::tmux_snapshot) fn flush_palette(&mut self, cx: &mut Context<Self>) {
        self.sync_palette_query(cx);
        self.flush_palette_close();
        if self.palette.pending.is_some()
            || self.palette.pending_close.is_some()
            || self.palette.due.is_none_or(|due| due > Instant::now())
        {
            return;
        }
        let Some(query) = self.palette.query.clone() else {
            return;
        };
        self.palette.due = None;
        if self.palette.next >= 9_007_199_254_740_991 {
            return;
        }
        self.palette.next += 1;
        let scope = self.palette.next;
        if self.browser_commands.as_ref().is_some_and(|sender| {
            sender
                .try_send(browser::Command::PaletteObserve {
                    request: self.browser_request,
                    scope,
                    active: true,
                    query,
                })
                .is_ok()
        }) {
            self.palette.active = Some((self.browser_request, scope));
            self.palette.remote_observed = self.palette.active;
        } else if let Some(picker) = &mut self.picker {
            picker.error = Some("Fleet search queue unavailable — reopen to try again");
        }
        self.refresh_picker(cx);
        cx.notify();
    }
    pub(super) fn palette_status(&self) -> String {
        if self.palette.pending.is_some() {
            return "Opening fleet agent…".into();
        }
        if self
            .palette
            .pending_close
            .is_some_and(|(_, _, tries)| tries >= 300)
        {
            return "Fleet search close queue unavailable — reopen Commands to retry".into();
        }
        if !self.browser_state.palette_supported {
            return "Context agents only — global fleet search unavailable with this helper".into();
        }
        let publication = self.palette.active.and_then(|(request, scope)| {
            self.browser_state
                .palette_agents
                .as_ref()
                .filter(|p| request == self.browser_request && p.scope == scope)
        });
        match publication {
            Some(p) => format!(
                "{} · {} sessions observed · {} sessions and {} matching rows omitted",
                match p.roster.phase {
                    browser::home_agents::Phase::Loading => "Loading fleet agents",
                    browser::home_agents::Phase::Unavailable => "Fleet agents unavailable",
                    browser::home_agents::Phase::Partial => "Partial fleet observations",
                    browser::home_agents::Phase::Live => "Fleet agents",
                },
                p.roster.observed_sessions,
                p.roster.truncated_sessions,
                p.roster.truncated_rows
            ),
            None => "Loading fleet search…".into(),
        }
    }
    pub(super) fn choose_palette(
        &mut self,
        scope: u64,
        revision: u64,
        key: &str,
        cx: &mut Context<Self>,
    ) {
        if !self.presence.ready()
            || self.palette.pending.is_some()
            || self.workspace_fleet_agents.pending.is_some()
            || self.session_tabs.pending.is_some()
            || self.palette.active != Some((self.browser_request, scope))
        {
            return;
        }
        let Some(request) = self.next_navigation_request() else {
            return;
        };
        self.palette.last_request = request;
        let pending = Rejected {
            request,
            from_request: self.browser_request,
            scope,
        };
        if self.browser_commands.as_ref().is_some_and(|s| {
            s.try_send(browser::Command::OpenPaletteAgent {
                request,
                from_request: pending.from_request,
                scope,
                roster_revision: revision,
                key: key.into(),
            })
            .is_ok()
        }) {
            self.palette.pending = Some(pending);
        } else {
            self.cancel_palette();
            if let Some(p) = &mut self.picker {
                p.error = Some("Fleet selection queue unavailable — reopen to try again");
            }
        }
        cx.notify();
    }
    pub(in crate::tmux_snapshot) fn accept_palette_state(&mut self, state: &browser::State) {
        let Some(pending) = self.palette.pending else {
            return;
        };
        if self.browser_request != pending.from_request {
            self.palette.pending = None;
            return;
        }
        if state.request == pending.from_request
            && state.palette_selection_rejected == Some(pending)
        {
            self.palette.pending = None;
            if let Some(p) = self
                .picker
                .as_mut()
                .filter(|p| p.mode == Mode::Commands && p.pane_scope.is_none())
            {
                p.error = Some("Fleet target changed — search again or choose another agent");
            }
        } else if state.request == pending.request {
            self.palette.pending = None;
            self.palette.active = None;
            self.palette.remote_observed = None;
            self.palette.query = None;
            self.palette.due = None;
            self.picker = None;
            self.browser_request = pending.request;
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod workspace_pending_tests;
