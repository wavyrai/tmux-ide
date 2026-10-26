//! One bounded, read-only catalog result per machine. The owning worker retains
//! transport authority; this result contains only display data and server scopes.
use super::{CatalogIdentity, Error, ServerRegistration, Session, owner::Owner};
use crate::tmux_handoff::ServerScope;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FleetCatalog {
    pub identity: CatalogIdentity,
    pub servers: Vec<ServerRegistration>,
    pub sessions: Vec<FleetCatalogSessions>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FleetCatalogSessions {
    pub scope: ServerScope,
    pub sessions: Vec<Session>,
}
impl Owner {
    pub(super) fn fleet_catalog(&self, cancelled: &Arc<AtomicBool>) -> Result<FleetCatalog, Error> {
        let current = || {
            if cancelled.load(Ordering::Acquire) {
                Err(Error::Retired)
            } else {
                Ok(())
            }
        };
        current()?;
        let catalog = self.catalog()?;
        let mut sessions = Vec::new();
        let mut count = 0;
        // Match the native Home publication limit, including offline entries.
        for entry in catalog.servers.iter().take(32) {
            current()?;
            let ServerRegistration::Online { scope, .. } = entry else {
                continue;
            };
            let mut client = self.select_server(scope)?;
            client.bind_request(Arc::clone(cancelled));
            let result = client.sessions();
            client.retire();
            let values = result?;
            count += values.len();
            if count > 4096 {
                return Err(Error::ResourceFormat);
            }
            sessions.push(FleetCatalogSessions {
                scope: scope.clone(),
                sessions: values,
            });
        }
        current()?;
        // No partially gathered data is published if an owner or registration
        // changed during traversal. Session lists are observations, not a lock or
        // a reusable selection grant; opening still verifies the selected scope.
        let end = self.catalog()?;
        current()?;
        if end.identity != catalog.identity {
            return Err(Error::IdentityChanged);
        }
        if end.servers != catalog.servers {
            return Err(Error::ServerChanged);
        }
        Ok(FleetCatalog {
            identity: catalog.identity,
            servers: catalog.servers,
            sessions,
        })
    }
}
