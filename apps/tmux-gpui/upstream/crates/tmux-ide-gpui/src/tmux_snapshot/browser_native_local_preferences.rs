//! Revision-bound preference capabilities. Persistence always uses the separate
//! local registry worker, regardless of the viewed terminal's SSH source.
use super::*;
use herdr_client::tmux_daemon::{FleetClientState, FleetPreferenceChange, LocalOwnerStamp};
use std::collections::HashMap;
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Kind {
    Favorite,
    Collapse,
}
pub(super) struct Gate {
    state: Option<FleetClientState>,
    owner: Option<LocalOwnerStamp>,
    pending_cache: Option<herdr_client::tmux_daemon::FleetCachedRoute>,
    phase: fleet::PreferencePhase,
    error: Option<String>,
    revision: u64,
    actions: HashMap<String, (Kind, String)>,
    pub(super) needs_read: bool,
    pub(super) visits: visits::Visits,
}
impl Default for Gate {
    fn default() -> Self {
        Self {
            state: None,
            owner: None,
            pending_cache: None,
            phase: fleet::PreferencePhase::Unavailable,
            error: None,
            revision: 0,
            actions: HashMap::new(),
            needs_read: true,
            visits: Default::default(),
        }
    }
}
impl Gate {
    pub(super) fn refresh(&mut self) {
        self.pending_cache = None;
        self.visits.retire();
        self.owner = None;
        self.actions.clear();
        self.phase = fleet::PreferencePhase::Unavailable;
        self.needs_read = true;
    }
    fn begin(&mut self, writing: bool) {
        self.actions.clear();
        self.error = None;
        self.needs_read = false;
        self.phase = if writing {
            fleet::PreferencePhase::Saving
        } else {
            fleet::PreferencePhase::Loading
        };
    }
    fn failed(&mut self) {
        self.pending_cache = None;
        self.visits.retire();
        self.actions.clear();
        self.owner = None;
        self.state = None;
        self.phase = fleet::PreferencePhase::Failed;
        self.error =
            Some("Could not confirm fleet preferences. Refresh before trying again.".into());
        self.needs_read = false;
    }
    fn action(
        &mut self,
        kind: Kind,
        key: &str,
        previous: &mut HashMap<(Kind, String), String>,
    ) -> Option<String> {
        if self.phase != fleet::PreferencePhase::Ready || self.owner.is_none() {
            return None;
        }
        let target = (kind, key.to_owned());
        let token = previous
            .remove(&target)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        self.actions.insert(token.clone(), target);
        Some(token)
    }
    fn project(&mut self, value: &mut fleet::Fleet, group_key: &str, active: Option<&str>) {
        self.actions.clear();
        if self.revision == 9_007_199_254_740_991 {
            self.failed();
        } else {
            self.revision += 1;
        }
        let keys = value
            .groups
            .iter()
            .map(|group| (group.id.clone(), group_key.to_owned()))
            .collect();
        self.project_published(value, &keys, active);
    }
    /// Extend the same preference revision to the final bounded fleet projection.
    /// Reuse tokens for unchanged visible controls, revoke removed controls, and
    /// never mint authority while a read/write or owner verification is pending.
    fn project_published(
        &mut self,
        value: &mut fleet::Fleet,
        keys: &BTreeMap<String, String>,
        active: Option<&str>,
    ) {
        let mut previous = std::mem::take(&mut self.actions)
            .into_iter()
            .map(|(token, target)| (target, token))
            .collect();
        value.preferences = Some(fleet::Preferences {
            revision: self.revision,
            phase: self.phase,
            error: self.error.clone(),
        });
        for group in &mut value.groups {
            let key = keys.get(&group.id).map(String::as_str).unwrap_or(&group.id);
            group.collapsed = self
                .state
                .as_ref()
                .is_some_and(|s| s.collapsed.iter().any(|k| k == key));
            group.collapse_action = if group.conflict {
                None
            } else {
                self.action(Kind::Collapse, key, &mut previous)
            };
            for session in &mut group.sessions {
                session.favorite = self
                    .state
                    .as_ref()
                    .is_some_and(|s| s.favorites.contains(&session.id));
                session.active = active == Some(session.id.as_str());
                session.favorite_action = if group.conflict {
                    None
                } else {
                    self.action(Kind::Favorite, &session.id, &mut previous)
                };
            }
            group.sessions.sort_by_key(|s| {
                if s.active {
                    0
                } else if s.favorite {
                    1
                } else {
                    2
                }
            });
        }
    }
    fn consume(
        &mut self,
        revision: u64,
        token: &str,
        enabled: bool,
    ) -> Option<(LocalOwnerStamp, FleetPreferenceChange)> {
        if revision != self.revision || self.phase != fleet::PreferencePhase::Ready {
            return None;
        }
        let owner = self.owner.clone()?;
        let (kind, key) = self.actions.get(token)?.clone();
        let change = match kind {
            Kind::Favorite => FleetPreferenceChange::Favorite { key, enabled },
            Kind::Collapse => FleetPreferenceChange::Collapse { key, enabled },
        };
        self.begin(true);
        Some((owner, change))
    }
}
impl Local {
    pub(super) fn published_preferences(&mut self, state: &mut State) {
        let Some(fleet) = &mut state.fleet else {
            self.preferences.actions.clear();
            return;
        };
        let keys = fleet
            .groups
            .iter()
            .map(|group| {
                (
                    group.id.clone(),
                    self.background_fleet.preference_key(
                        &group.id,
                        group.conflict,
                        &self.machine_id,
                        self.catalog_identity.as_ref(),
                    ),
                )
            })
            .collect();
        let active = self.preferences.visits.active_key().map(str::to_owned);
        self.preferences
            .project_published(fleet, &keys, active.as_deref());
    }
    pub(super) fn preempt_background_preference(&mut self, command: &Command) -> Result<(), Error> {
        let foreground = matches!(
            command,
            Command::OpenAgent { .. }
                | Command::OpenWorkspaceFleetAgent { .. }
                | Command::OpenPaletteAgent { .. }
                | Command::OpenAttentionAgent { .. }
                | Command::OpenWorkspaceAgent { .. }
                | Command::FleetServer { .. }
                | Command::FleetDisconnect { .. }
                | Command::FleetRetry { .. }
                | Command::CreateSession { .. }
                | Command::CreateLocalSession { .. }
                | Command::NativeOwnerAction { .. }
                | Command::NativeEditorOpen { .. }
                | Command::NativeHistory { .. }
        );
        if !foreground {
            return Ok(());
        }
        // Read-only registry refreshes must not swallow foreground commands.
        // A registry mutation is deliberately not eligible for preemption.
        if matches!(self.stage, Some(Stage::Machines { change: None })) {
            self.cancel_registry();
            self.stage = None;
            self.submitted = false;
        }
        // Foreground work may retire a background visit write. If already
        // submitted, its outcome remains uncertain and is never replayed.
        if matches!(
            self.stage,
            Some(Stage::Preferences {
                change: None
                    | Some((
                        _,
                        FleetPreferenceChange::Visit { .. } | FleetPreferenceChange::Cache { .. }
                    ))
            })
        ) {
            self.cancel_preferences()?;
            self.stage = None;
            self.submitted = false;
        }
        Ok(())
    }
    pub(super) fn preference_projection(&mut self) -> Result<(), Error> {
        let Some(identity) = &self.catalog_identity else {
            return Ok(());
        };
        let active = self.preferences.visits.active_key().map(str::to_owned);
        if let Some(fleet) = &mut self.state.fleet {
            self.preferences.project(
                fleet,
                identity.group_key(&self.machine_id),
                active.as_deref(),
            );
        }
        Ok(())
    }
    pub(super) fn preference_tick(&mut self) -> Result<(), Error> {
        if self.stage.is_none()
            && let Some(change) = self.preferences.next_visit()
        {
            self.stage = Some(Stage::Preferences {
                change: Some(change),
            });
            self.preference_projection()?;
            return self.publish();
        }
        if self.stage.is_none()
            && let Some(change) = self.preferences.next_cache()
        {
            self.stage = Some(Stage::Preferences {
                change: Some(change),
            });
            self.preference_projection()?;
            return self.publish();
        }
        if !self.preferences.needs_read || self.stage.is_some() {
            return Ok(());
        }
        if self.local_record.is_none() {
            self.preferences.needs_read = false;
        } else {
            self.preferences.begin(false);
            self.stage = Some(Stage::Preferences { change: None });
        }
        self.preference_projection()?;
        self.publish()
    }
    pub(super) fn preference_command(
        &mut self,
        request: u64,
        revision: u64,
        action: String,
        enabled: bool,
    ) -> Result<(), Error> {
        if request != self.state.request || !self.foreground || self.stage.is_some() {
            return Ok(());
        }
        let Some(change) = self.preferences.consume(revision, &action, enabled) else {
            return Ok(());
        };
        self.stage = Some(Stage::Preferences {
            change: Some(change),
        });
        self.preference_projection()?;
        self.publish()
    }
    pub(super) fn preference_received(
        &mut self,
        state: FleetClientState,
        owner: LocalOwnerStamp,
    ) -> Result<(), Error> {
        if self
            .preferences
            .owner
            .as_ref()
            .is_some_and(|previous| previous != &owner)
        {
            self.preferences.visits.retire();
        }
        self.navigation.seed(&state.recent);
        self.navigation.cache_routes(&state.catalog);
        if let (Some(route), Some(key)) = (&self.active, self.preferences.visits.active_key()) {
            self.navigation.accept(route.request, key);
            self.navigation.remember(key, &self.machine_id);
        }
        self.preferences.state = Some(state);
        self.preferences.owner = Some(owner);
        self.preferences.phase = fleet::PreferencePhase::Ready;
        self.preferences.error = None;
        // Finish initial cache persistence before exposing Ready preference
        // tokens, so a following cache write cannot immediately stale a click.
        if let Some(change) = self.preferences.next_cache() {
            self.stage = Some(Stage::Preferences {
                change: Some(change),
            });
        }
        self.preference_projection()?;
        self.publish()
    }
    pub(super) fn preference_failed(&mut self) -> Result<(), Error> {
        self.preferences.failed();
        if let Some(worker) = &mut self.registry_worker {
            worker.reset();
        }
        self.preference_projection()?;
        self.publish()
    }
    pub(super) fn cancel_preferences(&mut self) -> Result<(), Error> {
        if let Some(Stage::Preferences { change }) = &self.stage {
            if let Some(worker) = &mut self.registry_worker {
                worker.cancel();
            }
            if change.is_some() && self.submitted {
                self.preferences.failed();
            } else {
                self.preferences.refresh();
            }
            self.preference_projection()?;
        }
        Ok(())
    }
}
#[cfg(test)]
#[path = "browser_native_local_preferences_tests.rs"]
mod tests;

#[path = "browser_native_local_visits.rs"]
mod visits;

#[path = "browser_native_local_cache.rs"]
mod cache;
