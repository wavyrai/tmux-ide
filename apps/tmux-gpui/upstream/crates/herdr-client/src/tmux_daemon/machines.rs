//! Local saved-machine registry; remote routing never supplies registry authority.
use super::{Error, LocalDaemon};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::LazyLock, time::Duration};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SavedMachine {
    pub id: String,
    pub label: String,
    pub ssh_target: String,
    #[serde(
        default,
        deserialize_with = "super::optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub expected_environment_id: Option<String>,
    #[serde(default = "enabled")]
    pub enabled: bool,
}
fn enabled() -> bool {
    true
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedMachineRegistry {
    pub version: u8,
    pub machines: Vec<SavedMachine>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
pub enum MachineChange {
    Edit { id: String, patch: MachinePatch },
    Enable { id: String },
    Disable { id: String },
    Remove { id: String },
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MachinePatch {
    #[serde(
        default,
        deserialize_with = "super::optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub label: Option<String>,
    #[serde(
        default,
        deserialize_with = "super::optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub ssh_target: Option<String>,
}
fn uuid(value: &str) -> Result<String, Error> {
    if value.len() != 36 {
        return Err(Error::ResourceFormat);
    }
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| Error::ResourceFormat)
}
fn label(value: &str) -> Result<String, Error> {
    static FORBIDDEN: LazyLock<Result<regex::Regex, regex::Error>> =
        LazyLock::new(|| regex::Regex::new(r"[\p{Cc}\p{Cf}]"));
    // Match ECMAScript trim used by the canonical Zod schema (Rust also
    // trims NEL, which the schema must reject as a control character).
    let value = value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'));
    if value.is_empty()
        || value.encode_utf16().count() > 80
        || FORBIDDEN
            .as_ref()
            .map_err(|_| Error::ResourceFormat)?
            .is_match(value)
    {
        return Err(Error::ResourceFormat);
    }
    Ok(value.into())
}
pub(super) fn target(value: &str) -> Result<(), Error> {
    static TARGET: LazyLock<Result<regex::Regex, regex::Error>> = LazyLock::new(|| {
        regex::Regex::new(
            r"^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:]+\])$",
        )
    });
    if value.len() > 255
        || !TARGET
            .as_ref()
            .map_err(|_| Error::ResourceFormat)?
            .is_match(value)
    {
        return Err(Error::ResourceFormat);
    }
    Ok(())
}
impl SavedMachineRegistry {
    pub fn validated(mut self) -> Result<Self, Error> {
        if self.version != 1 || self.machines.len() > 64 {
            return Err(Error::ResourceFormat);
        }
        let mut ids = HashSet::new();
        let mut labels = HashSet::from([String::from("local")]);
        for machine in &mut self.machines {
            machine.id = uuid(&machine.id)?;
            machine.label = label(&machine.label)?;
            target(&machine.ssh_target)?;
            machine.expected_environment_id = machine
                .expected_environment_id
                .as_deref()
                .map(uuid)
                .transpose()?;
            if !ids.insert(machine.id.clone())
                || !labels.insert(machine.label.nfkc().collect::<String>().to_lowercase())
            {
                return Err(Error::ResourceFormat);
            }
        }
        Ok(self)
    }
    pub fn select(&self, id: &str) -> Option<&SavedMachine> {
        self.machines.iter().find(|m| m.id == id && m.enabled)
    }
}
impl MachineChange {
    fn validate(&self, registry: &SavedMachineRegistry) -> Result<(), Error> {
        let id = match self {
            Self::Edit { id, .. }
            | Self::Enable { id }
            | Self::Disable { id }
            | Self::Remove { id } => id,
        };
        let id = uuid(id).map_err(|_| Error::ActionInput)?;
        let mut next = registry.clone();
        let machine = next
            .machines
            .iter_mut()
            .find(|m| m.id == id)
            .ok_or(Error::MachineRegistryChanged)?;
        if let Self::Edit { patch, .. } = self {
            if patch.label.is_none() && patch.ssh_target.is_none() {
                return Err(Error::ActionInput);
            }
            if let Some(label) = &patch.label {
                machine.label = label.clone();
            }
            if let Some(target) = &patch.ssh_target {
                machine.ssh_target = target.clone();
            }
        }
        next.validated().map_err(|_| Error::ActionInput)?;
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Identity {
    protocol_version: u32,
    product_version: String,
    instance_id: String,
    started_at: String,
    #[serde(default, deserialize_with = "super::optional_string")]
    environment_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    daemon: Identity,
    registry: SavedMachineRegistry,
}
impl LocalDaemon {
    pub(super) fn machine_resource(&self, bytes: &[u8]) -> Result<SavedMachineRegistry, Error> {
        if bytes.len() > 64 * 1024 {
            return Err(Error::ResourceFormat);
        }
        let resource: Resource =
            serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
        let identity = resource.daemon;
        self.machine_identity(&identity)?;
        resource.registry.validated()
    }
    pub(super) fn machine_identity(&self, identity: &Identity) -> Result<(), Error> {
        if identity.protocol_version != self.record.protocol_version
            || identity.product_version != self.record.product_version
            || identity.instance_id != self.record.instance_id
            || identity.started_at != self.record.started_at
            || identity.environment_id != self.record.environment_id
        {
            return Err(Error::IdentityChanged);
        }
        Ok(())
    }
    pub fn saved_machines(&self) -> Result<SavedMachineRegistry, Error> {
        self.verify_current()?;
        let bytes = self.get_resource("api/resources/saved-machines")?;
        self.verify_current()?;
        self.machine_resource(&bytes)
    }
    /// Re-read immediately before mutation. The existing daemon API has no atomic
    /// registry CAS; this matches its client-side stale-snapshot check, not a lock.
    /// Any failure after send is uncertain and must never trigger an automatic retry.
    pub fn mutate_saved_machine(
        &self,
        expected: &SavedMachineRegistry,
        change: &MachineChange,
    ) -> Result<SavedMachineRegistry, Error> {
        let expected = expected
            .clone()
            .validated()
            .map_err(|_| Error::ActionInput)?;
        change.validate(&expected)?;
        if self.saved_machines()? != expected {
            return Err(Error::MachineRegistryChanged);
        }
        let body = serde_json::to_vec(
            &serde_json::json!({"expectedInstanceId": self.instance_id(), "change": change}),
        )
        .map_err(|_| Error::ActionInput)?;
        if body.len() > 1024 {
            return Err(Error::ActionInput);
        }
        let result = (|| {
            let bytes = self.write_resource_with_options(
                "api/resources/saved-machines",
                &body,
                &[],
                Duration::from_millis(2500),
                true,
            )?;
            self.verify_current()?;
            self.machine_resource(&bytes)
        })();
        result.map_err(|error| Error::MachineMutationUncertain(Box::new(error)))
    }
}

#[cfg(test)]
#[path = "machines_tests.rs"]
mod tests;
