//! F5 uses only published navigation capabilities. Workspace agents are session-scoped.
use super::*;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Destination {
    Session(String),
    FleetSession {
        selection: String,
        session_id: String,
    },
    PaletteAgent {
        scope: u64,
        revision: u64,
        key: String,
    },
    HomeAgent {
        revision: u64,
        key: String,
    },
    WorkspaceAgent {
        revision: u64,
        key: String,
        session: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) struct Captured {
    request: u64,
    picker: Option<EntityId>,
    destination: Destination,
}
impl Captured {
    pub(super) fn current(&self, state: &browser::State) -> bool {
        if state.request != self.request {
            return false;
        }
        match &self.destination {
            Destination::Session(id) => state.sessions.iter().any(|s| &s.id == id),
            Destination::FleetSession {
                selection,
                session_id,
            } => state
                .fleet
                .as_ref()
                .and_then(|f| f.session(selection))
                .is_some_and(|s| s.session_id.as_ref() == Some(session_id)),
            Destination::PaletteAgent {
                scope,
                revision,
                key,
            } => state.palette_agents.as_ref().is_some_and(|p| {
                p.scope == *scope && p.roster.revision == *revision && p.roster.available(key)
            }),
            Destination::HomeAgent { revision, key } => {
                state.surface == browser::Surface::Home
                    && state
                        .home_agents
                        .as_ref()
                        .is_some_and(|r| r.revision == *revision && r.available(key))
            }
            Destination::WorkspaceAgent {
                revision,
                key,
                session,
            } => {
                state.surface == browser::Surface::Workspace
                    && state.selected_session.as_ref() == Some(session)
                    && state.workspace_agents.as_ref().is_some_and(|w| {
                        &w.session_id == session
                            && w.roster.revision == *revision
                            && w.roster.available(key)
                    })
            }
        }
    }
}
pub(super) fn rows(state: &browser::State, query: &str) -> Vec<Row> {
    let query = query.chars().take(256).collect::<String>().to_lowercase();
    let mut candidates = Vec::new();
    if let Some(fleet) = &state.fleet {
        for group in &fleet.groups {
            for session in &group.sessions {
                if let (Some(selection), Some(session_id)) =
                    (&session.selection, &session.session_id)
                {
                    candidates.push((
                        format!(
                            "Open session · {} · {} · {}",
                            session.name,
                            group.label,
                            session
                                .server_id
                                .as_ref()
                                .and_then(|id| group.servers.iter().find(|server| &server.id == id))
                                .map_or("Unscoped server", |server| server.label.as_str())
                        ),
                        Destination::FleetSession {
                            selection: selection.clone(),
                            session_id: session_id.clone(),
                        },
                    ));
                }
            }
        }
    } else {
        candidates.extend(state.sessions.iter().map(|s| {
            (
                format!("Open session · {}", s.label),
                Destination::Session(s.id.clone()),
            )
        }));
    }
    if state.fleet.is_some() && state.palette_supported {
        if let Some(p) = &state.palette_agents {
            for row in &p.roster.rows {
                candidates.push((
                    format!("Jump to agent · {} · {}", row.name, row.context_label()),
                    Destination::PaletteAgent {
                        scope: p.scope,
                        revision: p.roster.revision,
                        key: row.key.clone(),
                    },
                ));
            }
        }
    } else {
        match state.surface {
            browser::Surface::Home => {
                if let Some(roster) = &state.home_agents {
                    for row in &roster.rows {
                        candidates.push((
                            format!("Jump to agent · {} · {}", row.name, row.context_label()),
                            Destination::HomeAgent {
                                revision: roster.revision,
                                key: row.key.clone(),
                            },
                        ));
                    }
                }
            }
            browser::Surface::Workspace => {
                if let Some(w) = &state.workspace_agents {
                    for row in &w.roster.rows {
                        candidates.push((
                            format!(
                                "Jump to workspace agent · {} · {}",
                                row.name,
                                row.context_label()
                            ),
                            Destination::WorkspaceAgent {
                                revision: w.roster.revision,
                                key: row.key.clone(),
                                session: w.session_id.clone(),
                            },
                        ));
                    }
                }
            }
        }
    }
    candidates
        .into_iter()
        .filter(|(label, destination)| {
            query.split_whitespace().all(|term| {
                label.to_lowercase().contains(term)
                    || match destination {
                        // The bridge applies the complete query before its row cap.
                        // Current palette scope is separately checked before display
                        // and dispatch, so do not reinterpret its matching vocabulary.
                        Destination::PaletteAgent { .. } => true,
                        Destination::HomeAgent { key, .. } => state
                            .home_agents
                            .as_ref()
                            .and_then(|r| r.rows.iter().find(|r| &r.key == key))
                            .is_some_and(|r| r.matches_query(term)),
                        Destination::WorkspaceAgent { key, .. } => state
                            .workspace_agents
                            .as_ref()
                            .and_then(|w| w.roster.rows.iter().find(|r| &r.key == key))
                            .is_some_and(|r| r.matches_query(term)),
                        _ => false,
                    }
            })
        })
        .take(32)
        .map(|(label, destination)| Row {
            label,
            target: Target::DirectNavigation(Captured {
                request: state.request,
                picker: None,
                destination,
            }),
        })
        .collect()
}
pub(super) fn retain_palette_scope(rows: &mut Vec<Row>, active: Option<(u64, u64)>) {
    rows.retain(|row| !matches!(&row.target, Target::DirectNavigation(Captured {request, destination: Destination::PaletteAgent {scope,..},..})
        if active != Some((*request,*scope))));
}
pub(super) fn bind(rows: &mut [Row], identity: EntityId) {
    for row in rows {
        if let Target::DirectNavigation(target) = &mut row.target {
            target.picker = Some(identity);
        }
    }
}
impl SnapshotView {
    pub(super) fn choose_direct_navigation(
        &mut self,
        captured: Captured,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.presence.ready()
            || self.browser_request != captured.request
            || !captured.current(&self.browser_state)
            || !self.marked.is_empty()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || self.picker.as_ref().is_none_or(|p| {
                captured.picker != Some(p.search.entity_id())
                    || p.mode != Mode::Commands
                    || p.pane_scope.is_some()
                    || p.closing.is_some()
                    || p.agent.is_some()
                    || p.edit.is_some()
                    || p.removal.is_some()
                    || p.search.read(cx).is_composing()
            })
        {
            return;
        }
        if let Destination::PaletteAgent {
            scope,
            revision,
            key,
        } = &captured.destination
        {
            self.choose_palette(*scope, *revision, key, cx);
            return;
        }
        self.close_picker(window, cx);
        match captured.destination {
            Destination::PaletteAgent { .. } => {}
            Destination::Session(id) => self.select(Selection::Session(id), window, cx),
            Destination::FleetSession {
                selection,
                session_id,
            } => self.select(
                Selection::FleetSession {
                    selection,
                    session_id,
                },
                window,
                cx,
            ),
            Destination::HomeAgent { revision, key } => {
                self.home_agent_select(captured.request, revision, &key, window, cx)
            }
            Destination::WorkspaceAgent {
                revision,
                key,
                session,
            } => {
                self.workspace_agent_select(captured.request, revision, &session, &key, window, cx)
            }
        }
    }
}
