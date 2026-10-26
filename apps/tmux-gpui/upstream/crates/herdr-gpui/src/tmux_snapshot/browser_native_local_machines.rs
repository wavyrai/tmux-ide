//! Registry UI state. HTTP ownership stays in the local catalog worker.
use super::*;
use herdr_client::tmux_daemon::{MachineChange, MachinePatch, SavedMachineRegistry};
#[derive(Default)]
pub(super) struct Gate {
    snapshot: Option<SavedMachineRegistry>,
    revision: u64,
    pending: bool,
    available: bool,
    error: Option<String>,
    message: Option<String>,
}
impl Gate {
    pub(super) fn begin(&mut self) {
        self.pending = true;
    }
    pub(super) fn publication(&self) -> machines::Registry {
        machines::Registry {
            revision: self.revision,
            available: self.available,
            pending: self.pending,
            error: self.error.clone(),
            message: self.message.clone(),
            machines: self.snapshot.as_ref().map_or_else(Vec::new, |value| {
                value
                    .machines
                    .iter()
                    .map(|m| machines::Profile {
                        id: m.id.clone(),
                        label: m.label.clone(),
                        ssh_target: m.ssh_target.clone(),
                        expected_environment_id: m.expected_environment_id.clone(),
                        enabled: m.enabled,
                    })
                    .collect()
            }),
        }
    }
    pub(super) fn finish(
        &mut self,
        result: Result<SavedMachineRegistry, herdr_client::tmux_daemon::Error>,
    ) {
        self.pending = false;
        match result {
            Ok(value) => {
                if !self.available || self.snapshot.as_ref() != Some(&value) {
                    self.revision += 1;
                }
                self.snapshot = Some(value);
                self.available = true;
                self.error = None;
            }
            Err(error) => {
                self.revision += 1;
                self.available = false;
                self.error = Some(
                    match error {
                        herdr_client::tmux_daemon::Error::MachineMutationUncertain(_) => {
                            "Machine change outcome is unconfirmed. Refresh before trying again."
                        }
                        herdr_client::tmux_daemon::Error::MachineRegistryChanged => {
                            "Saved machines changed. Refresh and select the machine again."
                        }
                        herdr_client::tmux_daemon::Error::LocalAuthorityRequired => {
                            "Saved machines require the local registry owner."
                        }
                        _ => "Saved machines are unavailable. Refresh before trying again.",
                    }
                    .into(),
                );
            }
        }
    }
}
impl Local {
    pub(super) fn add_machine(&mut self, request: u64, target: String) -> Result<(), Error> {
        let refreshing = matches!(self.stage, Some(Stage::Machines { change: None }));
        if request <= self.state.request
            || !self.foreground
            || (self.registry.pending && !refreshing)
        {
            return Ok(());
        }
        self.cancel()?;
        self.state.request = request;
        self.state.surface = Surface::Home;
        self.state.home_phase = HomePhase::Loading;
        self.state.status = "Saving machine".into();
        self.registry.begin();
        self.registry.message = None;
        self.stage = Some(Stage::AddMachine { target });
        self.publish()
    }
    pub(super) fn machine_prepared(
        &mut self,
        value: herdr_client::tmux_daemon::PreparedMachine,
    ) -> Result<(), Error> {
        let herdr_client::tmux_daemon::PreparedMachine {
            profile,
            registry,
            persisted,
        } = value;
        self.registry.finish(Ok(registry));
        self.registry.message =
            (!persisted).then(|| "Machine could not be saved; connected for this run only.".into());
        #[cfg(unix)]
        {
            let target = herdr_client::tmux_ssh::SshTarget::parse(&profile.ssh_target)
                .map_err(|_| Error::Invalid("invalid saved SSH destination"))?;
            let source = CatalogSource::remote(target, profile.expected_environment_id.clone());
            self.switch_source(
                self.state.request,
                source,
                profile.id.clone(),
                profile.label.clone(),
                persisted.then_some(profile),
            )
        }
        #[cfg(not(unix))]
        {
            let _ = profile;
            self.unavailable("Native SSH connections are unavailable on this platform")
        }
    }
    pub(super) fn select_history_machine(&mut self, request: u64, id: String) -> Result<(), Error> {
        self.select_machine(request, id, self.registry.revision)
    }
    pub(super) fn select_machine(
        &mut self,
        request: u64,
        id: String,
        revision: u64,
    ) -> Result<(), Error> {
        let refreshing = matches!(self.stage, Some(Stage::Machines { change: None }));
        if request <= self.state.request
            || !self.foreground
            || (self.registry.pending && !refreshing)
        {
            return Ok(());
        }
        if !self.registry.available
            || revision != self.registry.revision
            || self
                .registry
                .snapshot
                .as_ref()
                .and_then(|r| r.select(&id))
                .is_none()
        {
            self.registry.error = Some(
                "Saved machines changed or this profile is disabled. Refresh and select it again."
                    .into(),
            );
            return self.publish();
        }
        let Some(expected) = self.registry.snapshot.clone() else {
            return Ok(());
        };
        self.cancel()?;
        self.state.request = request;
        self.state.surface = Surface::Home;
        self.state.home_phase = HomePhase::Loading;
        self.state.status = "Verifying saved machine".into();
        self.registry.pending = true;
        self.stage = Some(Stage::MachineSelection { expected, id });
        self.publish()
    }
    pub(super) fn machine_selected(
        &mut self,
        expected: SavedMachineRegistry,
        id: String,
        value: SavedMachineRegistry,
    ) -> Result<(), Error> {
        let profile = value.select(&id).cloned();
        let unchanged = value == expected;
        self.registry.finish(Ok(value));
        let Some(profile) = profile.filter(|_| unchanged) else {
            return self.unavailable("Saved machine changed — select it again");
        };
        #[cfg(unix)]
        {
            let target = herdr_client::tmux_ssh::SshTarget::parse(&profile.ssh_target)
                .map_err(|_| Error::Invalid("invalid saved SSH destination"))?;
            let source = CatalogSource::remote(target, profile.expected_environment_id.clone());
            self.switch_source(
                self.state.request,
                source,
                profile.id.clone(),
                profile.label.clone(),
                Some(profile),
            )
        }
        #[cfg(not(unix))]
        {
            let _ = profile;
            self.unavailable("Native SSH connections are unavailable on this platform")
        }
    }
    pub(super) fn registry_received(&mut self, value: SavedMachineRegistry) -> Result<(), Error> {
        let current = self
            .selected_profile
            .as_ref()
            .and_then(|selected| value.select(&selected.id));
        let changed = self.selected_profile.as_ref().is_some_and(|selected| {
            current.is_none_or(|current| {
                current.ssh_target != selected.ssh_target
                    || current.expected_environment_id != selected.expected_environment_id
            })
        });
        if let Some(current) = current {
            self.machine_label = current.label.clone();
            if let Some(fleet) = &mut self.state.fleet {
                for group in &mut fleet.groups {
                    if group.id == current.id {
                        group.label = current.label.clone();
                    }
                }
            }
            if let Some(server) = &mut self.state.selected_server {
                server.machine_label = current.label.clone();
            }
            self.selected_profile = Some(current.clone());
        }
        self.fleet_reconcile(value.clone())?;
        self.fleet_recovery_fresh()?;
        self.registry.finish(Ok(value.clone()));
        if changed {
            self.fleet_cancel_control();
        } else if self.fleet_apply_control()? {
            self.fleet_reconcile(value)?;
        }
        if changed {
            self.retire_saved_route()?;
        }
        self.publish()
    }
    pub(super) fn registry_failed(
        &mut self,
        error: herdr_client::tmux_daemon::Error,
    ) -> Result<(), Error> {
        if let Some(worker) = &mut self.registry_worker {
            worker.reset();
        }
        self.background_fleet.invalidate()?;
        if self.local_creation.offer.is_some() {
            self.cancel_local_creation();
            self.state.home_phase = HomePhase::Unavailable;
            self.state.status = "Local owner unavailable — refresh sessions".into();
        }
        self.registry.finish(Err(error));
        if self.selected_profile.is_some() {
            self.retire_saved_route()?;
        }
        self.publish()
    }
    fn retire_saved_route(&mut self) -> Result<(), Error> {
        let Some(record) = self.local_record.clone() else {
            return self.unavailable("Local registry owner is unavailable");
        };
        self.switch_source(
            self.state.request,
            CatalogSource::Local(record),
            "local".into(),
            "Local".into(),
            None,
        )
    }

    pub(super) fn read_registry(&mut self) {
        if self.stage.is_none() {
            self.registry.pending = true;
            self.stage = Some(Stage::Machines { change: None });
        }
    }
    pub(super) fn cancel_registry(&mut self) {
        if self.stage.as_ref().is_some_and(Stage::registry) {
            if let Some(worker) = &mut self.registry_worker {
                worker.cancel();
            }
            self.registry.pending = false;
        }
        if matches!(
            self.stage,
            Some(Stage::Machines { change: Some(_) } | Stage::AddMachine { .. })
        ) {
            self.registry.pending = false;
            if self.submitted {
                self.registry.available = false;
                self.registry.error = Some(
                    "Machine change outcome is unconfirmed. Refresh before trying again.".into(),
                );
                self.registry.revision += 1;
            }
        }
    }
    pub(super) fn machine_operation(
        &mut self,
        request: u64,
        operation: machines::Operation,
    ) -> Result<(), Error> {
        if request != self.state.request || self.stage.is_some() || !self.foreground {
            return Ok(());
        }
        match operation {
            machines::Operation::Read => self.read_registry(),
            machines::Operation::Mutate { revision, change } => {
                if revision != self.registry.revision
                    || !self.registry.available
                    || self.registry.pending
                {
                    self.registry.error = Some(
                        "Saved machines changed. Refresh and select the machine again.".into(),
                    );
                    return self.publish();
                }
                let Some(expected) = self.registry.snapshot.clone() else {
                    return Ok(());
                };
                let change = match change {
                    machines::Change::Edit { id, patch } => MachineChange::Edit {
                        id,
                        patch: MachinePatch {
                            label: Some(patch.label),
                            ssh_target: Some(patch.ssh_target),
                        },
                    },
                    machines::Change::Enable { id } => MachineChange::Enable { id },
                    machines::Change::Disable { id } => MachineChange::Disable { id },
                    machines::Change::Remove { id } => MachineChange::Remove { id },
                };
                self.registry.pending = true;
                self.registry.error = None;
                self.stage = Some(Stage::Machines {
                    change: Some((expected, change)),
                });
            }
        }
        self.publish()
    }
}
impl Local {
    pub(super) fn fleet_resync(&mut self) -> Result<(), Error> {
        if let Some(value) = self
            .registry
            .snapshot
            .clone()
            .filter(|_| self.registry.available)
        {
            self.fleet_reconcile(value)?;
        } else {
            self.background_fleet.invalidate()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn uncertain_result_disables_writes_until_a_fresh_read() {
        let mut gate = Gate::default();
        gate.finish(Ok(SavedMachineRegistry {
            version: 1,
            machines: vec![],
        }));
        assert!(gate.publication().available);
        gate.finish(Err(
            herdr_client::tmux_daemon::Error::MachineMutationUncertain(Box::new(
                herdr_client::tmux_daemon::Error::Retired,
            )),
        ));
        let state = gate.publication();
        assert!(!state.available && !state.pending);
        assert!(state.error.unwrap().contains("unconfirmed"));
        gate.finish(Ok(SavedMachineRegistry {
            version: 1,
            machines: vec![],
        }));
        assert!(gate.publication().available);
        assert!(gate.publication().error.is_none());
        assert!(gate.publication().valid());
    }
}
