//! Home's keyboard and its per-window controls: the top bar's focus ring,
//! queued recovery and preference requests, and the left list and session
//! table's selection (#684, #705). Home has no agent list of its own any more
//! (#705, Option A): agents show on their sessions' rows.
use super::*;

pub(in crate::tmux_snapshot) struct Controls {
    pub(super) actions: [FocusHandle; 5],
    pub(super) recovery_queued: Option<(u64, u64)>,
    pub(super) recovery_error: bool,
    pub(super) preference_queued: Option<(u64, u64, u64)>,
    pub(super) preference_error: bool,
    pub(super) page_scroll: ScrollHandle,
    /// What the session table shows: the left list's entry.
    pub(in crate::tmux_snapshot) fleet_view: fleet_nav::View,
    /// The left list's focus, for its arrow keys.
    pub(super) fleet_nav: FocusHandle,
    /// The session table's focus, for its arrow keys and Enter.
    pub(in crate::tmux_snapshot) fleet_table: FocusHandle,
    /// The table row the keyboard is on.
    pub(in crate::tmux_snapshot) table_cursor: Option<fleet_nav::RowKey>,
    /// The needs-input pill is on: the table shows waiting sessions only.
    pub(in crate::tmux_snapshot) waiting_only: bool,
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn prepare_home_filter(&mut self, cx: &mut Context<Self>) {
        if self.home_filter.is_none() {
            self.home_filter = Some(Controls {
                actions: std::array::from_fn(|_| cx.focus_handle()),
                recovery_queued: None,
                recovery_error: false,
                preference_queued: None,
                preference_error: false,
                page_scroll: ScrollHandle::new(),
                fleet_view: fleet_nav::View::All,
                fleet_nav: cx.focus_handle(),
                fleet_table: cx.focus_handle(),
                table_cursor: None,
                waiting_only: false,
            });
        }
    }
    pub(in crate::tmux_snapshot) fn home_filter_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.home_action_key(event, window, cx) {
            return true;
        }
        // Enter/Space belong to GPUI's focused-button key-up activation.
        if self.home_action_index(window).is_some() {
            return false;
        }
        if self.home_fleet_nav_key(event, window, cx) {
            return true;
        }
        // R retries agent observation and M loads more: the status line's
        // buttons, from the keyboard.
        let key = &event.keystroke;
        if self.browser_state.surface != browser::Surface::Home
            || self.browser_state.home_agents.is_none()
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || key.modifiers.platform
            || key.modifiers.control
            || key.modifiers.alt
            || key.modifiers.shift
            || !matches!(key.key.as_str(), "r" | "m")
        {
            return false;
        }
        if !event.is_held
            && let Some(capability) = &self.browser_state.home_agent_recovery
        {
            let action = if key.key == "r" {
                recovery::Action::Retry
            } else {
                recovery::Action::LoadMore
            };
            self.recover_home_agents(self.browser_request, capability.revision, action, cx);
        }
        cx.stop_propagation();
        window.prevent_default();
        true
    }
    /// `[` and `]` anywhere on Home move the left list's selection, as do the
    /// arrows, Home and End while the list has focus; there → or Enter moves
    /// into the session table and Esc leaves the list. In the table the same
    /// keys move its cursor, Enter opens the cursor's session, F and D act on
    /// its row, and ← or Esc goes back to the list.
    fn home_fleet_nav_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let key = &event.keystroke;
        if self.browser_state.surface != browser::Surface::Home
            || self.browser_state.fleet.is_none()
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || key.modifiers.platform
            || key.modifiers.control
            || key.modifiers.alt
            || key.modifiers.shift
        {
            return false;
        }
        self.prepare_home_filter(cx);
        let Some(controls) = &mut self.home_filter else {
            return false;
        };
        let list_focused = controls.fleet_nav.is_focused(window);
        let table_focused = controls.fleet_table.is_focused(window);
        let waiting = waiting_sessions(&self.browser_state, controls.waiting_only);
        let only = waiting.as_ref();
        let fleet = self.browser_state.fleet.as_ref();
        let current = fleet_nav::reconcile(&controls.fleet_view, fleet);
        let key = key.key.as_str();
        if table_focused && !matches!(key, "[" | "]") {
            match key {
                "left" | "escape" => controls.fleet_nav.clone().focus(window, cx),
                "enter" | "f" | "d" => {
                    if event.is_held {
                        return true;
                    }
                    let cursor = fleet_nav::step_row(
                        &current,
                        only,
                        fleet,
                        controls.table_cursor.as_ref(),
                        "",
                    );
                    let row = cursor.as_ref().and_then(|(group, session)| {
                        let group = fleet?.groups.iter().find(|g| &g.id == group)?;
                        Some((group, group.sessions.iter().find(|s| &s.id == session)?))
                    });
                    let request = self.browser_request;
                    // Enter opens the row's session, F toggles its favourite and
                    // D sends new sessions to its server: the row's buttons.
                    let act = row.and_then(|(group, session)| match key {
                        "enter" => session.selection.clone().map(RowAct::Open),
                        "f" => Some(RowAct::Favourite {
                            action: session.favorite_action.clone()?,
                            revision: fleet?.preferences.as_ref()?.revision,
                            favourite: !session.favorite,
                        }),
                        _ => group
                            .servers
                            .iter()
                            .find(|s| Some(&s.id) == session.server_id.as_ref())?
                            .selection
                            .clone()
                            .map(RowAct::UseServer),
                    });
                    controls.table_cursor = cursor;
                    match act {
                        Some(RowAct::Open(token)) => {
                            self.open_fleet_session(request, &token, window, cx)
                        }
                        Some(RowAct::Favourite {
                            action,
                            revision,
                            favourite,
                        }) => {
                            self.change_fleet_preference(request, revision, &action, favourite, cx)
                        }
                        Some(RowAct::UseServer(token)) => {
                            self.open_fleet_server(request, &token, window, cx)
                        }
                        None => {}
                    }
                }
                _ => {
                    let Some(next) = fleet_nav::step_row(
                        &current,
                        only,
                        fleet,
                        controls.table_cursor.as_ref(),
                        key,
                    ) else {
                        return false;
                    };
                    controls.table_cursor = Some(next);
                }
            }
        } else if list_focused && matches!(key, "right" | "enter") {
            // An empty table keeps the keyboard on the list; Enter here is
            // never the agent list's Enter.
            if !event.is_held
                && let Some(cursor) =
                    fleet_nav::step_row(&current, only, fleet, controls.table_cursor.as_ref(), "")
            {
                controls.table_cursor = Some(cursor);
                controls.fleet_table.clone().focus(window, cx);
            } else if key == "right" && !event.is_held {
                return false;
            }
        } else if list_focused && key == "escape" {
            self.terminal_focus.focus(window, cx);
        } else {
            if !matches!(key, "[" | "]") && !list_focused {
                return false;
            }
            let Some(next) = fleet_nav::step(&current, fleet, key) else {
                return false;
            };
            controls.fleet_view = next;
            controls.waiting_only = false;
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
        true
    }
}

/// What a table key does to the cursor's row: the row's own controls.
enum RowAct {
    Open(String),
    Favourite {
        action: String,
        revision: u64,
        favourite: bool,
    },
    UseServer(String),
}

/// The live session ids with an agent waiting for input, while the pill's
/// filter is on and any agent waits; otherwise `None`, every row.
pub(in crate::tmux_snapshot) fn waiting_sessions(
    state: &browser::State,
    on: bool,
) -> Option<std::collections::HashSet<String>> {
    let roster = state.home_agents.as_ref().filter(|_| on)?;
    let ids: std::collections::HashSet<String> = roster
        .rows
        .iter()
        .filter(|row| row.attention)
        .map(|row| row.session_id.clone())
        .collect();
    (!ids.is_empty()).then_some(ids)
}
