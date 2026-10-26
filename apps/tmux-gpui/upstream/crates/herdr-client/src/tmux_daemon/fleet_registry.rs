//! Saved-registry policy around concurrent catalogs. Background-owner-only like
//! FleetCatalogPool; this object owns its sources, never the active terminal route.
use super::{
    CatalogSource, FleetCatalogEvent, FleetCatalogPool, FleetPoolError, SavedMachineRegistry,
};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum FleetRegistryError {
    #[error("fleet registry is invalid")]
    Registry(#[source] super::Error),
    #[error("fleet source could not be configured")]
    Target(#[source] crate::tmux_ssh::Error),
    #[error("fleet catalog ownership failed")]
    Pool(#[from] FleetPoolError),
}
#[derive(Clone, PartialEq, Eq)]
enum Binding {
    Local(PathBuf),
    Remote {
        target: String,
        expected_environment: Option<String>,
    },
}
impl Binding {
    fn source(&self) -> Result<CatalogSource, FleetRegistryError> {
        match self {
            Self::Local(record) => Ok(CatalogSource::Local(record.clone())),
            Self::Remote {
                target,
                expected_environment,
            } => Ok(CatalogSource::remote(
                crate::tmux_ssh::SshTarget::parse(target).map_err(FleetRegistryError::Target)?,
                expected_environment.clone(),
            )),
        }
    }
}
struct Route {
    label: String,
    binding: Binding,
    disconnected: Option<uuid::Uuid>,
}
pub struct FleetRegistry {
    cleanup_pending: bool,
    local_record: PathBuf,
    pool: FleetCatalogPool,
    routes: BTreeMap<String, Route>,
}
impl FleetRegistry {
    /// Background owner with push notifications. At most one watch socket per
    /// route (65 total); the existing four-operation catalog limit still applies.
    pub fn new_watched(local_record: PathBuf) -> Self {
        let mut registry = Self::new(local_record);
        registry.pool.enable_notifications();
        registry
    }

    pub fn new(local_record: PathBuf) -> Self {
        Self {
            cleanup_pending: false,
            local_record,
            pool: FleetCatalogPool::default(),
            routes: BTreeMap::new(),
        }
    }
    /// Reread/validate the registry at the caller's local-owner boundary. Exclude
    /// the active route because its foreground owner already has a catalog and
    /// terminal lifetime. This never adopts or shuts down that foreground source.
    pub fn reconcile(
        &mut self,
        registry: SavedMachineRegistry,
        selected: &str,
    ) -> Result<bool, FleetRegistryError> {
        if self.cleanup_pending {
            self.invalidate()?;
        }
        let registry = match registry.validated() {
            Ok(value) => value,
            Err(error) => {
                self.invalidate()?;
                return Err(FleetRegistryError::Registry(error));
            }
        };
        let mut wanted = BTreeMap::new();
        if selected != "local" {
            wanted.insert(
                "local".into(),
                Route {
                    disconnected: None,
                    label: "Local".into(),
                    binding: Binding::Local(self.local_record.clone()),
                },
            );
        }
        for profile in registry
            .machines
            .into_iter()
            .filter(|profile| profile.enabled && profile.id != selected)
        {
            wanted.insert(
                profile.id,
                Route {
                    disconnected: None,
                    label: profile.label,
                    binding: Binding::Remote {
                        target: profile.ssh_target,
                        expected_environment: profile.expected_environment_id,
                    },
                },
            );
        }
        let mut changed = false;
        let retired: Vec<_> = self
            .routes
            .iter()
            .filter(|(id, route)| {
                wanted
                    .get(*id)
                    .is_none_or(|next| next.binding != route.binding)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in retired {
            // Remove display ownership first, even if OS shutdown must be retried.
            self.routes.remove(&id);
            if let Err(error) = self.pool.remove(&id) {
                self.cleanup_pending = true;
                return Err(error.into());
            }
            changed = true;
        }
        for (id, route) in wanted {
            if let Some(current) = self.routes.get_mut(&id) {
                changed |= current.label != route.label;
                current.label = route.label;
                continue;
            }
            // A previously failed shutdown may still own this ID. Retry it before
            // a replacement can be inserted or become visible.
            if self.pool.incarnation(&id).is_some() {
                self.pool.remove(&id)?;
            }
            self.pool.insert(id.clone(), route.binding.source()?)?;
            self.routes.insert(id, route);
            changed = true;
        }
        Ok(changed)
    }
    /// Loss of local registry authority revokes all background routes. Do not
    /// retain stale rows as live/selectable while waiting for owner recovery.
    pub fn invalidate(&mut self) -> Result<(), FleetRegistryError> {
        self.routes.clear();
        self.cleanup_pending = true;
        self.pool.shutdown()?;
        self.cleanup_pending = false;
        Ok(())
    }
    pub fn routes(&self) -> impl Iterator<Item = (&str, &str, uuid::Uuid)> {
        self.routes.iter().filter_map(|(id, route)| {
            route
                .disconnected
                .or_else(|| self.pool.incarnation(id))
                .map(|incarnation| (id.as_str(), route.label.as_str(), incarnation))
        })
    }
    pub fn current(&self, id: &str, incarnation: uuid::Uuid) -> bool {
        self.routes.get(id).is_some_and(|route| {
            route.disconnected.or_else(|| self.pool.incarnation(id)) == Some(incarnation)
        })
    }
    /// Read-only agent discovery can share a catalog source without creating an
    /// independent SSH owner. The borrower must not reset or shut it down, and
    /// must discard observations once this captured route is no longer current.
    pub fn agent_observation_source(
        &self,
        id: &str,
        incarnation: uuid::Uuid,
        identity: &super::CatalogIdentity,
    ) -> Option<CatalogSource> {
        if self.cleanup_pending || !self.current(id, incarnation) || self.disconnected(id) {
            return None;
        }
        self.pool.observation_source(id, incarnation, identity)
    }
    pub fn poll(&mut self) -> Result<Vec<FleetCatalogEvent>, FleetRegistryError> {
        let events = self.pool.poll()?;
        Ok(events
            .into_iter()
            .filter(|event| {
                self.current(&event.route_id, event.incarnation)
                    && !self.disconnected(&event.route_id)
            })
            .collect())
    }
    /// Explicit recovery after the caller rereads the local registry. Retire the
    /// captured transport and discovery state before issuing any new catalog IO.
    /// An old row's incarnation cannot reset a replacement route.
    pub fn retry(
        &mut self,
        id: &str,
        expected: uuid::Uuid,
    ) -> Result<Option<uuid::Uuid>, FleetRegistryError> {
        if self.cleanup_pending || !self.current(id, expected) {
            return Ok(None);
        }
        let Some(route) = self.routes.get(id) else {
            return Ok(None);
        };
        let source = route.binding.source()?;
        if let Err(error) = self.pool.remove(id) {
            self.routes.remove(id);
            self.cleanup_pending = true;
            return Err(error.into());
        }
        match self.pool.insert(id.into(), source) {
            Ok(incarnation) => {
                if let Some(route) = self.routes.get_mut(id) {
                    route.disconnected = None;
                }
                Ok(Some(incarnation))
            }
            Err(error) => {
                self.routes.remove(id);
                Err(error.into())
            }
        }
    }
    /// Disconnect only this owner's background source. Keep a new inert
    /// incarnation for an explicit retry; ordinary refresh/reconciliation must
    /// not silently reconnect a route the user disconnected.
    pub fn disconnect(
        &mut self,
        id: &str,
        expected: uuid::Uuid,
    ) -> Result<Option<uuid::Uuid>, FleetRegistryError> {
        if self.cleanup_pending || !self.current(id, expected) || self.disconnected(id) {
            return Ok(None);
        }
        if let Err(error) = self.pool.remove(id) {
            self.routes.remove(id);
            self.cleanup_pending = true;
            return Err(error.into());
        }
        let incarnation = uuid::Uuid::new_v4();
        if let Some(route) = self.routes.get_mut(id) {
            route.disconnected = Some(incarnation);
        }
        Ok(Some(incarnation))
    }
    pub fn disconnected(&self, id: &str) -> bool {
        self.routes
            .get(id)
            .is_some_and(|route| route.disconnected.is_some())
    }
    pub fn refresh(&mut self) -> Result<(), FleetRegistryError> {
        for (id, route) in &self.routes {
            if route.disconnected.is_none() {
                self.pool.refresh(id)?;
            }
        }
        Ok(())
    }
    pub fn busy(&self) -> bool {
        self.pool.busy()
    }
}

#[cfg(test)]
#[path = "fleet_registry_tests.rs"]
mod tests;
