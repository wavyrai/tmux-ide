//! Default-local creation keeps a one-use proof off the wire and never replays it.
use super::*;
use herdr_client::tmux_daemon::{CreatedSession, FleetCatalog, LocalSessionProof};
#[derive(Default)]
pub(super) struct Gate {
    pub(super) offer: Option<(String, LocalSessionProof)>,
}
impl Local {
    pub(super) fn cancel_local_creation(&mut self) {
        self.local_creation.offer = None;
        self.state.local_session_create = None;
        if self.submitted
            && let Some(Stage::LocalCreate { operation_id, .. }) = &self.stage
        {
            self.uncertain_create = Some(*operation_id);
        }
        if let Some(Stage::LocalCatalog { receipt, .. }) = &self.stage {
            self.uncertain_create = uuid::Uuid::parse_str(&receipt.operation_id).ok();
        }
    }
    pub(super) fn local_creation_presence(&mut self, active: bool) -> Result<(), Error> {
        if !active {
            let had_offer = self.local_creation.offer.is_some();
            self.cancel_local_creation();
            if matches!(
                self.stage,
                Some(Stage::LocalProve | Stage::LocalCreate { .. } | Stage::LocalCatalog { .. })
            ) {
                if let Some(worker) = &mut self.registry_worker {
                    worker.cancel();
                }
                self.stage = None;
                self.submitted = false;
                self.state.home_phase = HomePhase::Unavailable;
                self.state.status =
                    "Local creation interrupted — refresh to inspect sessions".into();
                self.publish()?;
            } else if had_offer {
                self.state.home_phase = HomePhase::Unavailable;
                self.publish()?;
            }
        }
        Ok(())
    }
    pub(super) fn local_creation_proved(&mut self, proof: LocalSessionProof) -> Result<(), Error> {
        if !self.foreground
            || self.machine_id != "local"
            || self.state.surface != Surface::Home
            || self.uncertain_create.is_some()
        {
            return Ok(());
        }
        let action = uuid::Uuid::new_v4().to_string();
        self.local_creation.offer = Some((action.clone(), proof));
        self.state.local_session_create = Some(local_session::Capability { action });
        self.state.local_setup = None;
        self.state.selected_server = None;
        self.state.sessions.clear();
        self.state.panes.clear();
        self.state.home_phase = HomePhase::Live;
        self.state.session_catalog_complete = true;
        self.state.status = "Create a local session to begin".into();
        self.publish()?;
        self.read_registry();
        Ok(())
    }
    pub(super) fn create_local_session(
        &mut self,
        request: u64,
        action: String,
        name: String,
    ) -> Result<(), Error> {
        if request != self.state.request
            || !self.foreground
            || self.machine_id != "local"
            || self.state.surface != Surface::Home
            || self.state.home_phase != HomePhase::Live
            || !matches!(self.stage, None | Some(Stage::Machines { change: None }))
            || self.uncertain_create.is_some()
            || self
                .local_creation
                .offer
                .as_ref()
                .is_none_or(|(token, _)| token != &action)
        {
            return Ok(());
        }
        let name = name.trim();
        if name.is_empty()
            || name.encode_utf16().count() > 100
            || name.starts_with('-')
            || name.chars().any(char::is_control)
        {
            self.state.status = "Enter a valid session name".into();
            return self.publish();
        }
        // A read-only registry refresh must not swallow a valid foreground click.
        if matches!(self.stage, Some(Stage::Machines { change: None })) {
            self.cancel_registry();
            self.stage = None;
            self.submitted = false;
        }
        let Some((_, proof)) = self.local_creation.offer.take() else {
            return Ok(());
        };
        self.state.local_session_create = None;
        self.state.home_phase = HomePhase::Loading;
        self.state.status = "Creating local session".into();
        self.stage = Some(Stage::LocalCreate {
            proof,
            operation_id: uuid::Uuid::new_v4(),
            name: name.into(),
        });
        self.publish()
    }
    pub(super) fn local_creation_failed(
        &mut self,
        stage: Stage,
        error: herdr_client::tmux_daemon::Error,
    ) -> Result<(), Error> {
        match stage {
            Stage::LocalCreate { operation_id, .. }
                if matches!(
                    error,
                    herdr_client::tmux_daemon::Error::ActionUncertain { .. }
                ) =>
            {
                self.uncertain_create = Some(operation_id)
            }
            Stage::LocalCatalog { receipt, .. } => {
                self.uncertain_create = uuid::Uuid::parse_str(&receipt.operation_id).ok()
            }
            _ => {}
        }
        self.unavailable(if self.uncertain_create.is_some() {
            "Local creation outcome unconfirmed — inspect sessions before creating another"
        } else {
            "Local session creation unavailable — refresh sessions"
        })
    }
    pub(super) fn local_creation_catalog(
        &mut self,
        receipt: CreatedSession,
        snapshot: FleetCatalog,
    ) -> Result<(), Error> {
        let matches: Vec<_> = snapshot
            .sessions
            .iter()
            .flat_map(|group| {
                group
                    .sessions
                    .iter()
                    .filter(|s| Some(&s.live_session_id) == receipt.live_session_id.as_ref())
                    .map(|s| Target {
                        scope: group.scope.clone(),
                        live: s.live_session_id.clone(),
                    })
            })
            .collect();
        if snapshot.identity.instance_id != receipt.daemon_instance_id || matches.len() != 1 {
            self.uncertain_create = uuid::Uuid::parse_str(&receipt.operation_id).ok();
            return self.unavailable("Created session could not be verified — inspect sessions");
        }
        let target = &matches[0];
        if !snapshot.servers.iter().any(
            |server| matches!(server,ServerRegistration::Online {scope,..} if scope==&target.scope),
        ) {
            self.uncertain_create = uuid::Uuid::parse_str(&receipt.operation_id).ok();
            return self.unavailable("Created session server is unavailable — inspect sessions");
        }
        self.receive_catalog(snapshot, false)?;
        let token = self
            .targets
            .iter()
            .find(|(_, t)| t.scope == target.scope && t.live == target.live)
            .map(|(token, _)| token.clone());
        if let Some(token) = token {
            self.open(self.state.request, token, None)?;
        } else {
            self.uncertain_create = uuid::Uuid::parse_str(&receipt.operation_id).ok();
            self.unavailable("Created session was not found — inspect sessions")?;
        }
        Ok(())
    }
}
