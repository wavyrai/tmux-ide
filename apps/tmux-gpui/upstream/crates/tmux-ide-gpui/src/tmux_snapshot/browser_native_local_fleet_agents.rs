//! Borrow authenticated background routes; selection re-enters the fresh registry
//! and catalog continuation rather than promoting a metadata connection.
use super::*;
use herdr_client::tmux_daemon::AgentSelection;
pub(in super::super) struct AgentRoute<'a> {
    pub machine: &'a str,
    pub label: &'a str,
    pub incarnation: uuid::Uuid,
    pub catalog: Option<&'a FleetCatalog>,
    pub source: Option<CatalogSource>,
}
impl Gate {
    pub(in super::super) fn agent_routes(&self) -> Result<Vec<AgentRoute<'_>>, Error> {
        #[cfg(unix)]
        {
            let registry = self
                .registry
                .as_ref()
                .map(|r| r.lock())
                .transpose()
                .map_err(|_| Error::Invalid("fleet owner closed"))?;
            Ok(self
                .labels
                .iter()
                .map(|(machine, (label, incarnation))| {
                    let catalog = self.catalogs.get(machine);
                    let source = if self.agent_group(machine) != Some(true)
                        || self.conflict
                        || self.failed.contains(machine)
                        || self.disconnected.contains(machine)
                    {
                        None
                    } else {
                        registry.as_ref().and_then(|registry| {
                            catalog.and_then(|catalog| {
                                registry.agent_observation_source(
                                    machine,
                                    *incarnation,
                                    &catalog.identity,
                                )
                            })
                        })
                    };
                    AgentRoute {
                        machine,
                        label,
                        incarnation: *incarnation,
                        catalog,
                        source,
                    }
                })
                .collect())
        }
        #[cfg(not(unix))]
        {
            Ok(Vec::new())
        }
    }
}
impl Local {
    pub(in super::super) fn open_fleet_agent(
        &mut self,
        request: u64,
        machine: String,
        incarnation: uuid::Uuid,
        scope: ServerScope,
        selection: AgentSelection,
    ) -> Result<(), Error> {
        // Revalidate the published route before starting navigation; its shared
        // source is used only for observations, never transferred into a terminal.
        let current = self.background_fleet.agent_routes()?.into_iter().any(|r| {
            r.machine == machine
                && r.incarnation == incarnation
                && r.source.is_some()
                && r.catalog
                    .is_some_and(|c| c.identity == selection.catalog_identity)
        });
        if !current {
            return Ok(());
        }
        self.select_fleet_route(
            request,
            Selection {
                machine,
                incarnation,
                target: CatalogTarget::Agent {
                    scope,
                    selection: Box::new(selection),
                },
            },
        )
    }
    pub(in super::super) fn open_observed_agent(
        &mut self,
        request: u64,
        scope: ServerScope,
        selection: AgentSelection,
    ) -> Result<bool, Error> {
        if !self.foreground || self.catalog_identity.as_ref() != Some(&selection.catalog_identity) {
            return Ok(false);
        }
        let token = self
            .targets
            .iter()
            .find(|(_, t)| t.scope == scope && t.live == selection.live_session_id)
            .map(|(key, _)| key.clone());
        let Some(token) = token else {
            return Ok(false);
        };
        self.open(request, token, selection.agent.pane_id.clone())?;
        if matches!(self.stage, Some(Stage::Open { .. })) {
            self.stage = Some(Stage::AgentOpen {
                target: Target {
                    scope,
                    live: selection.live_session_id.clone(),
                },
                selection: Box::new(selection),
            });
            return Ok(true);
        }
        Ok(false)
    }
}
