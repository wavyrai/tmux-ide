//! Persist completed catalog display data. Never retain selection tokens, SSH
//! targets, credentials or issued capabilities in the local fleet cache.
use super::*;
use herdr_client::tmux_daemon::{CatalogIdentity, FleetCachedRoute, FleetCachedSession};

fn project(
    machine: &str,
    identity: &CatalogIdentity,
    group: &fleet::Group,
    now: u64,
) -> Option<FleetCachedRoute> {
    // Run-only SSH entries cannot be resolved from the saved registry next run.
    if machine != "local" && uuid::Uuid::parse_str(machine).is_err() {
        return None;
    }
    if group.id != machine || group.conflict || now > 9_007_199_254_740_991 {
        return None;
    }
    let sessions = group
        .sessions
        .iter()
        .take(64)
        .filter_map(|session| {
            let server = group
                .servers
                .iter()
                .find(|server| session.server_id.as_ref() == Some(&server.id))?;
            let generation = server.generation.clone()?;
            let live = session.session_id.clone()?;
            let scope = ServerScope {
                server_id: server.id.clone(),
                generation,
            };
            // Store only a key reconstructed from this completed catalog's identity.
            let key = identity.session_key(machine, &scope, &live, false).ok()?;
            if key != session.id {
                return None;
            }
            Some(FleetCachedSession {
                id: key,
                live_session_id: Some(live),
                server: Some(scope),
                server_label: Some(server.label.clone()),
                name: session.name.clone(),
                pane_count: u16::try_from(session.pane_count).ok()?,
            })
        })
        .collect();
    let route = FleetCachedRoute {
        route_id: machine.into(),
        environment_id: identity.environment_id.clone(),
        generation: Some(identity.instance_id.clone()),
        seen_at: now,
        sessions,
    };
    // The persistent contract is stricter than some live display fields. Bad
    // optional cache data must not turn healthy preference controls into errors.
    FleetClientState {
        version: 1,
        favorites: vec![],
        collapsed: vec![],
        recent: vec![],
        catalog: vec![route],
    }
    .validated()
    .ok()?
    .catalog
    .pop()
}
fn unchanged(left: &FleetCachedRoute, right: &FleetCachedRoute) -> bool {
    left.route_id == right.route_id
        && left.environment_id == right.environment_id
        && left.generation == right.generation
        && left.sessions == right.sessions
}
impl Gate {
    pub(super) fn next_cache(&mut self) -> Option<(LocalOwnerStamp, FleetPreferenceChange)> {
        if self.phase != fleet::PreferencePhase::Ready || self.needs_read {
            return None;
        }
        let owner = self.owner.clone()?;
        let route = self.pending_cache.take()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.catalog.iter().any(|saved| unchanged(saved, &route)))
        {
            return None;
        }
        // Take before submission. A failure or cancellation never replays it.
        self.begin(true);
        Some((owner, FleetPreferenceChange::Cache { route }))
    }
}
impl Local {
    pub(in super::super) fn cache_catalog(&mut self) {
        let Some(identity) = &self.catalog_identity else {
            return;
        };
        let Some(group) = self.state.fleet.as_ref().and_then(|fleet| {
            fleet
                .groups
                .iter()
                .find(|group| group.id == self.machine_id)
        }) else {
            return;
        };
        let Some(now) = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        else {
            return;
        };
        self.preferences.pending_cache = project(&self.machine_id, identity, group, now);
    }
}

#[cfg(test)]
#[path = "browser_native_local_cache_tests.rs"]
mod tests;
