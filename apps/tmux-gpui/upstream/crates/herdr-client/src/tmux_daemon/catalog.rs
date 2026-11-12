//! Public, credential-free catalog identity. Stable display/preference keys never
//! grant selection authority; native callers retain fresh request-scoped tokens.
use super::{Error, ServerRegistration, owner::Owner};
use crate::tmux_handoff::ServerScope;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogIdentity {
    pub instance_id: String,
    pub environment_id: Option<String>,
}
pub struct CatalogSnapshot {
    pub identity: CatalogIdentity,
    pub servers: Vec<ServerRegistration>,
}
impl CatalogIdentity {
    /// Match machine-catalog.ts's environment key, or its route-scoped fallback.
    /// A conflicting environment must use the fallback until resolved by the fleet.
    pub fn session_key(
        &self,
        machine: &str,
        scope: &ServerScope,
        live: &str,
        conflict: bool,
    ) -> Result<String, Error> {
        if !conflict && let Some(environment) = &self.environment_id {
            return serde_json::to_string(&(
                environment,
                "session",
                &scope.server_id,
                &scope.generation,
                live,
            ))
            .map_err(|_| Error::ResourceFormat);
        }
        let source = serde_json::to_string(&(&scope.server_id, &scope.generation, live))
            .map_err(|_| Error::ResourceFormat)?;
        serde_json::to_string(&(machine, "session", source)).map_err(|_| Error::ResourceFormat)
    }
    pub fn group_key<'a>(&'a self, machine: &'a str) -> &'a str {
        self.environment_id.as_deref().unwrap_or(machine)
    }
}
impl Owner {
    /// Always asks the daemon for its servers.
    pub(super) fn catalog(&self) -> Result<CatalogSnapshot, Error> {
        self.catalog_with(Self::list_servers)
    }
    /// The catalog a traversal starts from: the remembered server list when
    /// nothing has dropped it. The traversal ends on [`Self::catalog`], which
    /// asks, so a list that was stale never reaches a publication.
    pub(super) fn known_catalog(&self) -> Result<CatalogSnapshot, Error> {
        self.catalog_with(Self::known_servers)
    }
    fn catalog_with(
        &self,
        list: fn(&Self) -> Result<Vec<ServerRegistration>, Error>,
    ) -> Result<CatalogSnapshot, Error> {
        match self {
            Self::Local(daemon) => {
                daemon.verify_current()?;
                let servers = list(self)?;
                daemon.verify_current()?;
                Ok(CatalogSnapshot {
                    identity: CatalogIdentity {
                        instance_id: daemon.record.instance_id.clone(),
                        environment_id: daemon.record.environment_id.clone(),
                    },
                    servers,
                })
            }
            #[cfg(unix)]
            Self::Remote(remote) => {
                // The transport proves its captured descriptor on every socket;
                // resource I/O cannot cross into a newly discovered owner.
                let servers = list(self)?;
                Ok(CatalogSnapshot {
                    identity: CatalogIdentity {
                        instance_id: remote.instance_id().into(),
                        environment_id: remote.environment_id().map(str::to_owned),
                    },
                    servers,
                })
            }
        }
    }
}
#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
