//! Bounded, read-only rediscovery. A new daemon never authorizes an old server
//! generation, and recovery never repeats owner mutations.
use super::*;

pub(super) struct Recovery {
    target: Target,
    pane: Option<String>,
    attempts: u8,
    due: Option<Instant>,
}
impl Recovery {
    pub(super) fn waiting(&self) -> bool {
        self.due.is_some()
    }
}
impl Local {
    pub(super) fn reconnect_start(&mut self) -> Result<(), Error> {
        let Some(route) = self.active.as_ref() else {
            return Ok(());
        };
        if matches!(self.stage, Some(Stage::Owner { .. } | Stage::Create { .. })) {
            return self
                .unavailable("Connection lost during an action — refresh to inspect its outcome");
        }
        let recovery = self.recovery.take().unwrap_or_else(|| Recovery {
            target: route.target.clone(),
            pane: self.state.selected_pane.clone(),
            attempts: 0,
            due: None,
        });
        self.cancel()?;
        self.recovery = Some(recovery);
        self.reconnect_retry()
    }
    pub(super) fn reconnect_retry(&mut self) -> Result<(), Error> {
        let Some(recovery) = self.recovery.as_mut() else {
            return Ok(());
        };
        if recovery.attempts >= 3 {
            return self.unavailable("Reconnect attempts exhausted — refresh to try again");
        }
        recovery.due = Some(Instant::now() + Duration::from_millis(250u64 << recovery.attempts));
        self.stage = None;
        self.submitted = false;
        self.state.status = "Connection lost — reconnecting".into();
        self.publish()
    }
    pub(super) fn reconnect_tick(&mut self) -> Result<(), Error> {
        if !self.foreground
            || self
                .recovery
                .as_ref()
                .is_none_or(|r| r.due.is_none_or(|due| Instant::now() < due))
        {
            return Ok(());
        }
        let Some(mut recovery) = self.recovery.take() else {
            return Ok(());
        };
        recovery.attempts += 1;
        recovery.due = None;
        let request = self.state.request;
        self.home(request)?;
        self.state.status = "Reconnecting terminal".into();
        self.recovery = Some(recovery);
        Ok(())
    }
    /// Select only an exact generation/session match in the newly verified catalog.
    pub(super) fn reconnect_catalog(&mut self) -> Result<bool, Error> {
        let Some(recovery) = self.recovery.take() else {
            return Ok(false);
        };
        let key = self
            .targets
            .iter()
            .find(|(_, target)| {
                target.scope == recovery.target.scope && target.live == recovery.target.live
            })
            .map(|(key, _)| key.clone());
        let Some(key) = key else {
            self.unavailable(
                "Previous session identity changed or disappeared — select a session",
            )?;
            return Ok(true);
        };
        self.open(self.state.request, key, recovery.pane.clone())?;
        self.recovery = Some(recovery);
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    fn fixture() -> (Local, mpsc::Receiver<Incoming>) {
        let path = PathBuf::from("/nonexistent-reconnect-test/daemon.json");
        let (events, receiver) = mpsc::sync_channel(32);
        let target = Target {
            scope: ServerScope {
                server_id: "server".into(),
                generation: "generation".into(),
            },
            live: "$1".into(),
        };
        (
            Local {
                machine_id: "local".into(),
                machine_label: "Local".into(),
                catalog_identity: None,
                worker: CatalogWorker::spawn(path.clone()).unwrap(),
                events,
                state: State {
                    request: 7,
                    selected_session: Some("$1".into()),
                    selected_pane: Some("%2".into()),
                    ..State::default()
                },
                targets: BTreeMap::new(),
                stage: None,
                submitted: false,
                active: Some(Route {
                    id: "old-route".into(),
                    request: 7,
                    target,
                    workspace: "fixture".into(),
                }),
                split: split::Reader::new(path.clone()).unwrap(),
                foreground: true,
                presence_revision: 0,
                editor: Default::default(),
                owner: Default::default(),
                uncertain_create: None,
                local_creation: Default::default(),
                agents: Default::default(),
                appearance: None,
                recovery: None,
                background_fleet: Default::default(),
                registry: Default::default(),
                preferences: Default::default(),
                navigation: Default::default(),
                registry_worker: Some(CatalogWorker::spawn(path.clone()).unwrap()),
                registry_dirty: false,
                local_record: Some(path.clone()),
                sources: NativeOwner::new(CatalogSource::Local(path.clone())),
                selected_profile: None,
            },
            receiver,
        )
    }
    #[test]
    fn reconnect_preserves_exact_identity_and_pane_but_reissues_read_actions() {
        let (mut local, _events) = fixture();
        let target = local.active.as_ref().unwrap().target.clone();
        local.reconnect_start().unwrap();
        assert!(local.active.is_none());
        local.recovery.as_mut().unwrap().due = Some(Instant::now());
        local.reconnect_tick().unwrap();
        assert!(matches!(local.stage, Some(Stage::Servers)));
        local.targets.insert("new-token".into(), target);
        local.reconnect_catalog().unwrap();
        assert!(
            matches!(&local.stage, Some(Stage::Open { preferred, .. }) if preferred.as_deref() == Some("%2"))
        );
        assert_eq!(local.state.request, 7);
        assert_eq!(local.recovery.as_ref().unwrap().attempts, 1);
    }
    #[test]
    fn replacement_generation_cannot_reopen_same_session_id() {
        let (mut local, _events) = fixture();
        let mut target = local.active.as_ref().unwrap().target.clone();
        target.scope.generation = "replacement".into();
        local.reconnect_start().unwrap();
        local.targets.insert("new-token".into(), target);
        local.reconnect_catalog().unwrap();
        assert!(local.stage.is_none());
        assert!(local.recovery.is_none());
        assert!(local.state.home_phase == HomePhase::Unavailable);
    }
    #[test]
    fn background_defers_reconnect_and_user_navigation_cancels_it() {
        let (mut local, _events) = fixture();
        local.reconnect_start().unwrap();
        local.recovery.as_mut().unwrap().due = Some(Instant::now());
        local.foreground = false;
        local.reconnect_tick().unwrap();
        assert!(local.stage.is_none());
        assert_eq!(local.recovery.as_ref().unwrap().attempts, 0);
        local.home(8).unwrap();
        assert!(local.recovery.is_none());
    }
    #[test]
    fn retry_budget_stops() {
        let (mut local, _events) = fixture();
        local.reconnect_start().unwrap();
        local.recovery.as_mut().unwrap().attempts = 3;
        local.reconnect_retry().unwrap();
        assert!(local.recovery.is_none());
        assert!(local.stage.is_none());
        assert!(local.state.status.contains("exhausted"));
    }
    #[test]
    fn mutation_interruption_retains_uncertain_id_without_retry() {
        let (mut local, _events) = fixture();
        let operation_id = uuid::Uuid::new_v4();
        local.stage = Some(Stage::Create {
            scope: local.active.as_ref().unwrap().target.scope.clone(),
            operation_id,
            name: "never replay".into(),
        });
        local.submitted = true;
        local.reconnect_start().unwrap();
        assert_eq!(local.uncertain_create, Some(operation_id));
        assert!(local.recovery.is_none());
        assert!(local.stage.is_none());
    }
    #[test]
    fn visits_require_current_foreground_coherent_ready_attachment() {
        for invalid in 0..7 {
            let (mut local, _events) = fixture();
            local.catalog_identity = Some(herdr_client::tmux_daemon::CatalogIdentity {
                instance_id: "instance".into(),
                environment_id: Some("environment".into()),
            });
            assert!(local.preferences.visits.active_key().is_none());
            if invalid == 5 {
                local.foreground = false;
            }
            let ready = Command::NativeTerminalReady {
                version: 1,
                id: if invalid == 0 { "stale" } else { "old-route" }.into(),
                request: if invalid == 1 { 6 } else { 7 },
                pane: "%2".into(),
                live_session_id: "$1".into(),
                generation: if invalid == 2 { "stale" } else { "generation" }.into(),
                presence_revision: u64::from(invalid == 6),
                input_ready: invalid != 3,
                coherent: invalid != 4,
            };
            local.command(ready).unwrap();
            assert!(local.preferences.visits.active_key().is_none());
        }
        let (mut local, _events) = fixture();
        local.catalog_identity = Some(herdr_client::tmux_daemon::CatalogIdentity {
            instance_id: "instance".into(),
            environment_id: Some("environment".into()),
        });
        local
            .command(Command::NativeTerminalReady {
                version: 1,
                id: "old-route".into(),
                request: 7,
                pane: "%2".into(),
                live_session_id: "$1".into(),
                generation: "generation".into(),
                presence_revision: 0,
                input_ready: true,
                coherent: true,
            })
            .unwrap();
        assert!(local.preferences.visits.active_key().is_some());
        local.close().unwrap();
        assert!(local.preferences.visits.active_key().is_none());
    }
    #[test]
    fn stale_ready_does_not_clear_recovery() {
        let (mut local, _events) = fixture();
        let target = local.active.as_ref().unwrap().target.clone();
        local.recovery = Some(Recovery {
            target,
            pane: Some("%2".into()),
            attempts: 1,
            due: None,
        });
        local
            .command(Command::NativeTerminalReady {
                version: 1,
                id: "old-route".into(),
                request: 7,
                pane: "%2".into(),
                live_session_id: "$1".into(),
                generation: "different-generation".into(),
                presence_revision: 0,
                input_ready: true,
                coherent: true,
            })
            .unwrap();
        assert!(local.recovery.is_some());
    }
    #[test]
    fn saved_profile_recovery_revalidates_before_remote_discovery() {
        use herdr_client::tmux_daemon::{SavedMachine, SavedMachineRegistry};
        let (mut local, _events) = fixture();
        let profile = SavedMachine {
            id: uuid::Uuid::new_v4().to_string(),
            label: "Build".into(),
            ssh_target: "fixture.invalid".into(),
            expected_environment_id: None,
            enabled: true,
        };
        local.selected_profile = Some(profile.clone());
        local.reconnect_start().unwrap();
        local.recovery.as_mut().unwrap().due = Some(Instant::now());
        local.reconnect_tick().unwrap();
        assert!(matches!(local.stage, Some(Stage::VerifyProfile)));
        assert!(!local.submitted);
        local.stage = None;
        local
            .completed(
                Stage::VerifyProfile,
                CatalogResult::SavedMachines(SavedMachineRegistry {
                    version: 1,
                    machines: vec![profile],
                }),
            )
            .unwrap();
        assert!(matches!(local.stage, Some(Stage::Servers)));
        assert!(local.recovery.is_some());
    }
    #[test]
    fn disabled_profile_cancels_recovery_before_reconnecting() {
        use herdr_client::tmux_daemon::{SavedMachine, SavedMachineRegistry};
        let (mut local, _events) = fixture();
        let mut profile = SavedMachine {
            id: uuid::Uuid::new_v4().to_string(),
            label: "Build".into(),
            ssh_target: "fixture.invalid".into(),
            expected_environment_id: None,
            enabled: true,
        };
        local.selected_profile = Some(profile.clone());
        local.reconnect_start().unwrap();
        local.recovery.as_mut().unwrap().due = Some(Instant::now());
        local.reconnect_tick().unwrap();
        profile.enabled = false;
        local.stage = None;
        local
            .completed(
                Stage::VerifyProfile,
                CatalogResult::SavedMachines(SavedMachineRegistry {
                    version: 1,
                    machines: vec![profile],
                }),
            )
            .unwrap();
        assert!(local.selected_profile.is_none());
        assert!(local.recovery.is_none());
        assert_eq!(local.machine_id, "local");
    }
    #[test]
    fn manual_refresh_also_checks_saved_profile_before_discovery() {
        use herdr_client::tmux_daemon::SavedMachine;
        let (mut local, _events) = fixture();
        local.selected_profile = Some(SavedMachine {
            id: uuid::Uuid::new_v4().to_string(),
            label: "Build".into(),
            ssh_target: "fixture.invalid".into(),
            expected_environment_id: None,
            enabled: true,
        });
        local.home(8).unwrap();
        assert!(matches!(local.stage, Some(Stage::VerifyProfile)));
        assert!(local.registry.publication().pending);
        assert!(!local.submitted);
    }
}
