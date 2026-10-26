//! Single-use local default-server creation. A remote owner cannot mint this proof.
use super::{CreatedSession, Error, LocalDaemon, LocalOwnerStamp, ServerRegistration};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use uuid::Uuid;
#[derive(Clone)]
pub struct LocalSessionProof {
    owner: LocalOwnerStamp,
    generation: String,
    consumed: Arc<AtomicBool>,
}
impl LocalSessionProof {
    fn claim(&self, owner: &LocalOwnerStamp) -> Result<(), Error> {
        if self.consumed.swap(true, Ordering::AcqRel) {
            return Err(Error::Retired);
        }
        if &self.owner != owner {
            return Err(Error::RecordChanged);
        }
        Ok(())
    }
}
fn current(cancelled: &AtomicBool) -> Result<(), Error> {
    if cancelled.load(Ordering::Acquire) {
        Err(Error::Retired)
    } else {
        Ok(())
    }
}
impl LocalDaemon {
    fn no_online_servers(&self, cancelled: &AtomicBool) -> Result<(), Error> {
        current(cancelled)?;
        self.verify_current()?;
        if self
            .list_servers()?
            .iter()
            .any(|s| matches!(s, ServerRegistration::Online { .. }))
        {
            return Err(Error::ServerChanged);
        }
        current(cancelled)?;
        self.verify_current()
    }
    /// Read-only authorization to offer creation when no local server is online.
    pub fn prove_local_session_create(
        &self,
        cancelled: &AtomicBool,
    ) -> Result<LocalSessionProof, Error> {
        self.no_online_servers(cancelled)?;
        Ok(LocalSessionProof {
            owner: self.owner_stamp(),
            generation: self.instance_id().into(),
            consumed: Arc::new(AtomicBool::new(false)),
        })
    }
    /// Send once. Every clone shares consumption; failures after submission are
    /// uncertain and must be reconciled, never retried automatically.
    pub fn create_local_session(
        &self,
        proof: &LocalSessionProof,
        operation_id: Uuid,
        name: &str,
        cancelled: &AtomicBool,
    ) -> Result<CreatedSession, Error> {
        let name = name.trim();
        if !super::create_session::valid_display(name) {
            return Err(Error::ActionInput);
        }
        current(cancelled)?;
        proof.claim(&self.owner_stamp())?;
        self.no_online_servers(cancelled)?;
        current(cancelled)?;
        let body=serde_json::json!({"displayName":name,"includeLiveSessionId":true,"expectedDaemonInstanceId":proof.generation}).to_string();
        let operation = operation_id.to_string();
        let principal = format!("gpui-native-local-create:{operation}");
        let result = self
            .post_resource_with_options(
                "api/v2/action/workspace.session.create",
                body.as_bytes(),
                &[
                    ("X-Tmux-Ide-Operation-Id", &operation),
                    ("X-Tmux-Ide-Host-Client-Id", &principal),
                ],
                std::time::Duration::from_secs(10),
            )
            .and_then(|bytes| {
                current(cancelled)?;
                self.verify_current()?;
                let receipt = parse(&bytes, operation_id, &proof.generation)?;
                self.verify_current()?;
                Ok(receipt)
            });
        result.map_err(|source| Error::ActionUncertain {
            operation_id,
            source: Box::new(source),
        })
    }
    /// Post-create rediscovery checks owner continuity without requiring the
    /// server list to remain empty after the successful creation.
    pub fn verify_local_session_owner(&self, proof: &LocalSessionProof) -> Result<(), Error> {
        if self.owner_stamp() != proof.owner {
            return Err(Error::RecordChanged);
        }
        self.verify_current()
    }
}
fn parse(bytes: &[u8], operation_id: Uuid, generation: &str) -> Result<CreatedSession, Error> {
    if bytes.len() > 256 * 1024 {
        return Err(Error::ResourceFormat);
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope<'a> {
        ok: bool,
        #[serde(borrow)]
        result: &'a serde_json::value::RawValue,
    }
    let envelope: Envelope<'_> =
        serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if !envelope.ok {
        return Err(Error::ResourceFormat);
    }
    super::create_session::parse(envelope.result.get().as_bytes(), operation_id, generation)
}
#[cfg(test)]
#[path = "local_session_tests.rs"]
mod tests;
