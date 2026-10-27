//! One foreground attention subscription; it never changes the terminal selection.
use super::*;
use browser::home_agents::{Phase, Roster};
use serde::Deserialize;

#[derive(Clone)]
pub(in crate::tmux_snapshot) struct Publication {
    pub scope: u64,
    pub roster: Roster,
}
impl<'de> Deserialize<'de> for Publication {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        use serde::de::Error as _;
        let mut value = serde_json::Value::deserialize(deserializer)?;
        let scope = value
            .as_object_mut()
            .and_then(|o| o.remove("scope"))
            .and_then(|v| v.as_u64())
            .ok_or_else(|| D::Error::custom("missing attention scope"))?;
        Ok(Self {
            scope,
            roster: serde_json::from_value(value).map_err(D::Error::custom)?,
        })
    }
}
impl Publication {
    pub(in crate::tmux_snapshot) fn valid(&self) -> bool {
        self.scope > 0 && self.scope <= 9_007_199_254_740_991 && self.roster.valid()
    }
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Rejected {
    pub request: u64,
    pub from_request: u64,
    pub scope: u64,
}
impl Rejected {
    pub(in crate::tmux_snapshot) fn valid(&self) -> bool {
        self.request > self.from_request
            && self.request <= 9_007_199_254_740_991
            && self.scope > 0
            && self.scope <= 9_007_199_254_740_991
    }
}
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Owner {
    next: u64,
    pub(in crate::tmux_snapshot) last_request: u64,
    pub(in crate::tmux_snapshot) pending: Option<Rejected>,
    pub(super) active: Option<(u64, u64)>,
    pending_close: Option<(u64, u64, u16)>,
}
impl Owner {
    pub(super) fn queue_cancel(&mut self, request: u64, scope: u64) {
        self.pending_close = Some((request, scope, 0));
    }
}
pub(super) fn rows(state: &browser::State, active: Option<(u64, u64)>, query: &str) -> Vec<Row> {
    let Some((request, scope)) = active else {
        return Vec::new();
    };
    let Some(publication) = state
        .attention_agents
        .as_ref()
        .filter(|p| state.request == request && p.scope == scope)
    else {
        return Vec::new();
    };
    let query = query.trim().to_lowercase();
    publication
        .roster
        .rows
        .iter()
        .filter(|r| r.attention)
        .filter(|r| r.matches_query(&query))
        .map(|r| Row {
            target: Target::Attention {
                scope,
                revision: publication.roster.revision,
                key: r.key.clone(),
            },
            label: format!("{} · {} · {}", r.name, r.context_label(), r.status.label()),
        })
        .collect()
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn attention_picker_open(&self) -> bool {
        self.picker
            .as_ref()
            .is_some_and(|p| p.mode == Mode::Attention)
    }
    pub(in crate::tmux_snapshot) fn flush_attention(&mut self) {
        let Some((request, scope, tries)) = self.attention.pending_close else {
            return;
        };
        let Some(sender) = self.browser_commands.as_ref() else {
            self.attention.pending_close = None;
            return;
        };
        // One bounded slot, at most 300 existing browser ticks. If delivery remains
        // blocked, refuse another subscription rather than forgetting its close.
        if tries >= 300 {
            return;
        }
        match sender.try_send(browser::Command::AttentionObserve {
            request,
            scope,
            active: false,
        }) {
            Ok(()) | Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                self.attention.pending_close = None;
            }
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                self.attention.pending_close = Some((request, scope, tries + 1))
            }
        }
    }
    pub(in crate::tmux_snapshot) fn cancel_attention(&mut self) {
        // Dismissal cancels observation, not an already queued navigation.
        if let Some((request, scope)) = self.attention.active.take() {
            self.attention.queue_cancel(request, scope);
        }
        self.flush_attention();
    }
    pub(super) fn choose_attention(
        &mut self,
        scope: u64,
        revision: u64,
        key: &str,
        cx: &mut Context<Self>,
    ) {
        if !self.presence.ready()
            || self.attention.pending.is_some()
            || self.workspace_fleet_agents.pending.is_some()
            || self.session_tabs.pending.is_some()
            || self.attention.active != Some((self.browser_request, scope))
        {
            return;
        }
        let Some(request) = self.next_navigation_request() else {
            return;
        };
        self.attention.last_request = request;
        let pending = Rejected {
            request,
            from_request: self.browser_request,
            scope,
        };
        if self.browser_commands.as_ref().is_some_and(|s| {
            s.try_send(browser::Command::OpenAttentionAgent {
                request,
                from_request: pending.from_request,
                scope,
                roster_revision: revision,
                key: key.into(),
            })
            .is_ok()
        }) {
            self.attention.pending = Some(pending);
        } else {
            self.cancel_attention();
            if let Some(p) = &mut self.picker {
                p.error = Some("Attention selection queue unavailable — reopen to try again");
            }
        }
        cx.notify();
    }
    /// Only this one pending navigation can authorize a newer mailbox request.
    pub(in crate::tmux_snapshot) fn accept_attention_state(
        &mut self,
        state: &browser::State,
    ) -> bool {
        let Some(pending) = self.attention.pending else {
            return false;
        };
        if self.browser_request != pending.from_request {
            return false;
        }
        if state.request == pending.from_request
            && state.attention_selection_rejected == Some(pending)
        {
            self.attention.pending = None;
            if let Some(p) = self.picker.as_mut().filter(|p| p.mode == Mode::Attention) {
                p.error =
                    Some("Attention target changed — refresh observations or choose another agent");
            }
            return false;
        }
        if state.request != pending.request {
            return false;
        }
        self.attention.pending = None;
        self.attention.active = None;
        self.picker = None;
        self.browser_request = pending.request;
        true
    }
    pub(super) fn open_attention(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_picker_mode(Mode::Attention, window, cx);
        let error = if self.attention.pending.is_some() {
            Some("Attention navigation pending — wait or choose another destination")
        } else if !self.browser_state.attention_supported {
            Some("Attention overview is unavailable with this helper")
        } else if !self.presence.ready() {
            Some("Activate the window and reopen attention")
        } else if self.attention.pending_close.is_some() {
            Some("Attention queue unavailable — restart the preview")
        } else if self.attention.next >= 9_007_199_254_740_991 {
            Some("Attention scope exhausted — restart the preview")
        } else {
            self.attention.next += 1;
            let scope = self.attention.next;
            if self.browser_commands.as_ref().is_some_and(|sender| {
                sender
                    .try_send(browser::Command::AttentionObserve {
                        request: self.browser_request,
                        scope,
                        active: true,
                    })
                    .is_ok()
            }) {
                self.attention.active = Some((self.browser_request, scope));
                None
            } else {
                Some("Attention queue unavailable — reopen to try again")
            }
        };
        if let Some(picker) = &mut self.picker {
            picker.error = error;
        }
        cx.notify();
    }
    pub(super) fn attention_heading(&self) -> AnyElement {
        let publication = self.attention.active.and_then(|(request, scope)| {
            self.browser_state
                .attention_agents
                .as_ref()
                .filter(|p| request == self.browser_request && p.scope == scope)
        });
        let mut heading = div().flex().flex_col().child("Agent attention · F7");
        if let Some(p) = publication {
            let phase = match p.roster.phase {
                Phase::Loading => "Loading observations…",
                Phase::Unavailable => "Attention observations unavailable",
                Phase::Partial => "Partial observations",
                Phase::Live => {
                    if p.roster.rows.iter().any(|r| r.attention) {
                        "Observed attention"
                    } else {
                        "No observed attention"
                    }
                }
            };
            heading = heading.child(phase).child(format!(
                "{} of {} sessions observed · {} sessions and {} rows omitted",
                p.roster.observed_sessions,
                p.roster.total_sessions,
                p.roster.truncated_sessions,
                p.roster.truncated_rows
            ));
            if let Some(note) = &p.roster.note {
                heading = heading.child(note.clone());
            }
        } else if self.attention.active.is_some() {
            heading = heading.child("Loading attention observations…");
        }
        heading.text_sm().into_any_element()
    }
}
