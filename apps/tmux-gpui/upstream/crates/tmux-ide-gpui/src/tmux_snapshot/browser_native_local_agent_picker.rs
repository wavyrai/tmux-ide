//! One visible picker shares the roster's bounded read pool. Query replacement
//! changes projection only; no terminal authority exists until explicit selection.
use super::*;
use crate::tmux_snapshot::picker::attention::{Publication, Rejected};
use herdr_client::tmux_daemon::ObservedHarness;
const MAX: u64 = 9_007_199_254_740_991;
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Palette,
    Attention,
}
#[derive(Clone)]
struct Subscription {
    kind: Kind,
    request: u64,
    scope: u64,
    query: String,
}
struct Observation {
    kind: Kind,
    request: u64,
    scope: u64,
    active: bool,
    query: String,
}
#[derive(Default)]
pub(super) struct Picker {
    active: Option<Subscription>,
    palette_scope: u64,
    attention_scope: u64,
    attempt: u64,
    pub(super) dirty: bool,
    pub(super) failed: bool,
}
impl Picker {
    pub(super) fn active(&self, request: u64) -> bool {
        self.active.as_ref().is_some_and(|s| s.request == request)
    }
    pub(super) fn cancel(&mut self) -> bool {
        let changed = self.active.take().is_some();
        self.failed = false;
        self.dirty |= changed;
        changed
    }
    fn observe(&mut self, observation: Observation, current: u64, foreground: bool) -> bool {
        let Observation {
            kind,
            request,
            scope,
            active,
            query,
        } = observation;
        if request != current
            || request > MAX
            || scope == 0
            || scope > MAX
            || query.chars().count() > 256
        {
            return false;
        }
        if !active {
            return self
                .active
                .as_ref()
                .is_some_and(|s| s.kind == kind && s.request == request && s.scope == scope)
                && self.cancel();
        }
        let highest = match kind {
            Kind::Palette => &mut self.palette_scope,
            Kind::Attention => &mut self.attention_scope,
        };
        if !foreground || scope <= *highest {
            return false;
        }
        *highest = scope;
        self.active = Some(Subscription {
            kind,
            request,
            scope,
            query,
        });
        self.failed = false;
        self.dirty = true;
        true
    }
    fn admit(&mut self, kind: Kind, command: Rejected, current: u64, foreground: bool) -> bool {
        if !command.valid() || command.request <= current || command.request <= self.attempt {
            return false;
        }
        self.attempt = command.request;
        foreground
            && !self.failed
            && command.from_request == current
            && self
                .active
                .as_ref()
                .is_some_and(|s| s.kind == kind && s.request == current && s.scope == command.scope)
    }
}
fn matches_query(
    context: &Context,
    result: &AgentObservation,
    agent: &ObservedAgent,
    query: &str,
) -> bool {
    let harness = match agent.harness {
        ObservedHarness::Codex => "codex",
        ObservedHarness::ClaudeCode => "claude-code",
        ObservedHarness::Custom => "custom",
    };
    let fields: Vec<_> = [
        Some("jump to agent workspace"),
        Some(agent.name.as_str()),
        Some(context.session_label.as_str()),
        Some(context.machine_label.as_str()),
        context.server_label.as_deref(),
        Some(result.project_name.as_str()),
        Some(harness),
        agent.team.as_ref().map(|t| t.name.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(|s| projection::display(s, 160).to_lowercase())
    .collect();
    query
        .to_lowercase()
        .split_whitespace()
        .all(|term| fields.iter().any(|s| s.contains(term)))
}
impl Gate {
    pub(super) fn picker_publication(&mut self, state: &mut State) {
        self.picker.dirty = false;
        state.palette_agents = None;
        state.attention_agents = None;
        let Some(subscription) = self
            .picker
            .active
            .clone()
            .filter(|s| s.request == state.request)
        else {
            return;
        };
        let mut roster =
            self.publication_matching(|context, result, agent| match subscription.kind {
                Kind::Attention => agent.attention,
                Kind::Palette => matches_query(context, result, agent, &subscription.query),
            });
        if self.picker.failed {
            roster.rows.clear();
            roster.phase = home_agents::Phase::Unavailable;
            roster.note = Some("Agent catalog changed — close and reopen the picker.".into());
        }
        let publication = Some(Publication {
            scope: subscription.scope,
            roster,
        });
        match subscription.kind {
            Kind::Palette => state.palette_agents = publication,
            Kind::Attention => state.attention_agents = publication,
        }
    }
}
impl Local {
    pub(in super::super) fn picker_observing(&self) -> bool {
        self.agents.picker.active(self.state.request) && !self.agents.picker.failed
    }
    pub(in super::super) fn picker_catalog(
        &mut self,
        snapshot: &FleetCatalog,
    ) -> Result<(), Error> {
        if self.catalog_identity.as_ref() != Some(&snapshot.identity) {
            return Err(Error::Invalid("picker catalog identity changed"));
        }
        self.agents
            .seed(snapshot, &self.machine_id, &self.machine_label);
        self.seed_tabs(snapshot);
        // Only fresh catalog entries create private targets; opening still performs
        // exact agent/session/pane verification before acquiring a terminal lease.
        self.targets.retain(|_, target| {
            snapshot.sessions.iter().any(|g| {
                g.scope == target.scope
                    && g.sessions.iter().any(|s| s.live_session_id == target.live)
            }) || self
                .active
                .as_ref()
                .is_some_and(|r| r.target.scope == target.scope && r.target.live == target.live)
        });
        for group in &snapshot.sessions {
            for session in &group.sessions {
                if !self
                    .targets
                    .values()
                    .any(|t| t.scope == group.scope && t.live == session.live_session_id)
                {
                    self.targets.insert(
                        uuid::Uuid::new_v4().to_string(),
                        Target {
                            scope: group.scope.clone(),
                            live: session.live_session_id.clone(),
                        },
                    );
                }
            }
        }
        Ok(())
    }
    pub(in super::super) fn picker_catalog_failed(&mut self) -> Result<(), Error> {
        self.agents.suspend();
        self.agents.picker.failed = true;
        self.agents.picker.dirty = true;
        self.agent_tick()
    }
    pub(in super::super) fn observe_picker(&mut self, command: Command) -> Result<(), Error> {
        let (kind, request, scope, active, query) = match command {
            Command::PaletteObserve {
                request,
                scope,
                active,
                query,
            } => (Kind::Palette, request, scope, active, query),
            Command::AttentionObserve {
                request,
                scope,
                active,
            } => (Kind::Attention, request, scope, active, String::new()),
            _ => return Ok(()),
        };
        let was_active = self.agents.picker.active(self.state.request);
        let ready = self.state.surface == Surface::Home && self.state.home_phase == HomePhase::Live
            || self.state.surface == Surface::Workspace && self.active.is_some();
        if !self.agents.picker.observe(
            Observation {
                kind,
                request,
                scope,
                active,
                query,
            },
            self.state.request,
            self.foreground && ready,
        ) {
            return Ok(());
        }
        self.agents.published.clear();
        self.state.palette_selection_rejected = None;
        self.state.attention_selection_rejected = None;
        if active && !was_active && self.state.surface == Surface::Workspace {
            let snapshot = self.sources.catalog_snapshot()?;
            if let Some(snapshot) =
                snapshot.filter(|s| self.catalog_identity.as_ref() == Some(&s.identity))
            {
                self.picker_catalog(&snapshot)?;
            } else {
                return self.picker_catalog_failed();
            }
        }
        self.agent_tick()
    }
    pub(in super::super) fn open_picker_agent(&mut self, command: Command) -> Result<(), Error> {
        let (kind, attempt, revision, key) = match command {
            Command::OpenPaletteAgent {
                request,
                from_request,
                scope,
                roster_revision,
                key,
            } => (
                Kind::Palette,
                Rejected {
                    request,
                    from_request,
                    scope,
                },
                roster_revision,
                key,
            ),
            Command::OpenAttentionAgent {
                request,
                from_request,
                scope,
                roster_revision,
                key,
            } => (
                Kind::Attention,
                Rejected {
                    request,
                    from_request,
                    scope,
                },
                roster_revision,
                key,
            ),
            _ => return Ok(()),
        };
        if !attempt.valid() {
            return Ok(());
        }
        let admitted = self
            .agents
            .picker
            .admit(kind, attempt, self.state.request, self.foreground)
            && self.stage.is_none();
        if admitted
            && let Some((context, agent)) = self.agents.resolve(&key, revision)
            && self.open_agent_target(attempt.request, context, agent)?
        {
            return Ok(());
        }
        match kind {
            Kind::Palette => self.state.palette_selection_rejected = Some(attempt),
            Kind::Attention => self.state.attention_selection_rejected = Some(attempt),
        }
        self.publish()
    }
}

#[cfg(test)]
#[path = "browser_native_local_agent_picker_tests.rs"]
mod tests;
