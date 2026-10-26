//! Add/import saved routes through the verified local owner. Saving and connecting
//! are separate: a cancelled worker may have saved, but never opens an SSH route.
use super::{Error, LocalDaemon, SavedMachine, SavedMachineRegistry};
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use unicode_normalization::UnicodeNormalization;

pub struct PreparedMachine {
    pub profile: SavedMachine,
    pub registry: SavedMachineRegistry,
    pub persisted: bool,
}
impl SavedMachineRegistry {
    /// Add-only merge, matching the canonical daemon: identical IDs are idempotent;
    /// conflicting IDs, labels or capacity never overwrite an existing route.
    pub fn merged(&self, incoming: &Self) -> Result<Self, Error> {
        let mut next = self.clone().validated()?;
        for machine in incoming.clone().validated()?.machines {
            if let Some(existing) = next.machines.iter().find(|m| m.id == machine.id) {
                if existing != &machine {
                    return Err(Error::MachineRegistryChanged);
                }
            } else {
                next.machines.push(machine);
            }
        }
        next.validated()
    }
    pub fn prepare_machine(&self, target: &str) -> Result<SavedMachine, Error> {
        let registry = self.clone().validated()?;
        super::machines::target(target).map_err(|_| Error::ActionInput)?;
        let mut matching = registry.machines.iter().filter(|m| m.ssh_target == target);
        if let Some(existing) = matching.next() {
            if !existing.enabled || matching.next().is_some() {
                return Err(Error::MachineRegistryChanged);
            }
            return Ok(existing.clone());
        }
        let mut labels = HashSet::from(["local".into(), "this mac".into(), "this machine".into()]);
        labels.extend(
            registry
                .machines
                .iter()
                .map(|m| m.label.nfkc().collect::<String>().to_lowercase()),
        );
        // SSH target syntax is ASCII, so byte slicing agrees with JS slice here.
        let base = &target[..target.len().min(70)];
        let mut label = base.to_owned();
        let mut suffix = 2;
        while labels.contains(&label.to_lowercase()) {
            label = format!("{base} ({suffix})");
            suffix += 1;
        }
        Ok(SavedMachine {
            id: uuid::Uuid::new_v4().to_string(),
            label,
            ssh_target: target.into(),
            expected_environment_id: None,
            enabled: true,
        })
    }
}
impl LocalDaemon {
    pub fn import_saved_machines(
        &self,
        expected: &SavedMachineRegistry,
        incoming: &SavedMachineRegistry,
    ) -> Result<SavedMachineRegistry, Error> {
        self.import_machines_cancellable(expected, incoming, &AtomicBool::new(false))
    }
    fn import_machines_cancellable(
        &self,
        expected: &SavedMachineRegistry,
        incoming: &SavedMachineRegistry,
        cancelled: &AtomicBool,
    ) -> Result<SavedMachineRegistry, Error> {
        let expected = expected
            .clone()
            .validated()
            .map_err(|_| Error::ActionInput)?;
        let incoming = incoming
            .clone()
            .validated()
            .map_err(|_| Error::ActionInput)?;
        expected.merged(&incoming)?;
        if self.saved_machines()? != expected {
            return Err(Error::MachineRegistryChanged);
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "expectedInstanceId": self.instance_id(), "registry": incoming
        }))
        .map_err(|_| Error::ActionInput)?;
        if body.len() > 64 * 1024 {
            return Err(Error::ActionInput);
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(Error::Retired);
        }
        let result = (|| {
            let bytes = self.post_resource_with_options(
                "api/resources/saved-machines",
                &body,
                &[],
                Duration::from_millis(2500),
            )?;
            self.verify_current()?;
            self.machine_resource(&bytes)
        })();
        result.map_err(|error| Error::MachineMutationUncertain(Box::new(error)))
    }
    pub fn prepare_machine_connection(
        &self,
        target: &str,
        cancelled: &AtomicBool,
    ) -> Result<PreparedMachine, Error> {
        if cancelled.load(Ordering::Acquire) {
            return Err(Error::Retired);
        }
        let before = self.saved_machines()?;
        let profile = before.prepare_machine(target)?;
        if before.machines.iter().any(|m| m.id == profile.id) {
            return Ok(PreparedMachine {
                profile,
                registry: before,
                persisted: true,
            });
        }
        let incoming = SavedMachineRegistry {
            version: 1,
            machines: vec![profile.clone()],
        };
        match self.import_machines_cancellable(&before, &incoming, cancelled) {
            Ok(_) | Err(Error::MachineMutationUncertain(_)) => {}
            Err(error) => return Err(error),
        }
        // A save response can be lost after commit. Read, never replay the POST.
        if cancelled.load(Ordering::Acquire) {
            return Err(Error::Retired);
        }
        let after = self.saved_machines()?;
        let persisted = after.select(&profile.id).is_some_and(|m| {
            m.ssh_target == profile.ssh_target
                && m.expected_environment_id == profile.expected_environment_id
        });
        if !persisted
            && after
                .machines
                .iter()
                .any(|m| m.id == profile.id || m.ssh_target == target)
        {
            return Err(Error::MachineRegistryChanged);
        }
        Ok(PreparedMachine {
            profile,
            registry: after,
            persisted,
        })
    }
}
#[cfg(test)]
#[path = "machine_add_tests.rs"]
mod tests;
