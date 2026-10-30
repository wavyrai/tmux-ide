//! Bounded, read-only rediscovery. A new daemon never authorizes an old server
//! generation, and recovery never repeats owner mutations.
use super::*;

pub(super) struct Recovery {
    target: Target,
    pane: Option<String>,
    attempts: u8,
    due: Option<Instant>,
    started: Instant,
    others: u8,
}
impl Recovery {
    pub(super) fn waiting(&self) -> bool {
        self.due.is_some()
    }
}
/// A daemon restart refuses connections or removes its record for a few seconds.
const BUDGET: Duration = Duration::from_secs(30);
const GIVE_UP: &str = "Couldn't reconnect. Refresh sessions to try again.";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    /// Retried with backoff until the budget ends.
    Unreachable,
    /// A different daemon answered; never retried.
    Identity,
    /// Retried at most three times.
    Other,
}
impl Failure {
    pub(super) fn of(error: &herdr_client::tmux_daemon::Error) -> Self {
        use herdr_client::tmux_daemon::Error as E;
        match error {
            E::Network(_) | E::RecordChanged => Self::Unreachable,
            E::RecordIo(error) if error.kind() == std::io::ErrorKind::NotFound => Self::Unreachable,
            E::IdentityFormat | E::IdentityChanged | E::Incompatible(_) => Self::Identity,
            _ => Self::Other,
        }
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
            started: Instant::now(),
            others: 0,
        });
        self.cancel()?;
        self.recovery = Some(recovery);
        self.reconnect_retry(Failure::Other)
    }
    /// Backoff doubles from 250 ms to a 4 s cap; only an unreachable daemon outlasts three tries.
    pub(super) fn reconnect_retry(&mut self, failure: Failure) -> Result<(), Error> {
        let Some(recovery) = self.recovery.as_mut() else {
            return Ok(());
        };
        let delay = Duration::from_millis(
            250u64
                .checked_shl(u32::from(recovery.attempts))
                .unwrap_or(u64::MAX)
                .min(4000),
        );
        if failure == Failure::Other {
            recovery.others += 1;
        }
        if failure == Failure::Identity
            || recovery.others > 3
            || recovery.started.elapsed() + delay > BUDGET
        {
            return self.unavailable(GIVE_UP);
        }
        recovery.due = Some(Instant::now() + delay);
        self.stage = None;
        self.submitted = false;
        self.state.status = "Connection lost. Reconnecting…".into();
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
        self.state.status = "Connection lost. Reconnecting…".into();
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
                browser_controls: Default::default(),
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
    /// The scheduled delay, floored to the 250 ms step so a slow runner cannot change it.
    fn delay(local: &Local, before: Instant) -> u128 {
        let due = local.recovery.as_ref().unwrap().due.unwrap();
        due.duration_since(before).as_millis() / 250 * 250
    }
    #[test]
    fn an_unreachable_daemon_backs_off_to_a_four_second_cap() {
        let (mut local, _events) = fixture();
        let before = Instant::now();
        local.reconnect_start().unwrap();
        let mut delays = vec![delay(&local, before)];
        for _ in 0..6 {
            local.recovery.as_mut().unwrap().due = Some(Instant::now());
            local.reconnect_tick().unwrap();
            assert_eq!(local.state.status, "Connection lost. Reconnecting…");
            let before = Instant::now();
            local.reconnect_retry(Failure::Unreachable).unwrap();
            assert_eq!(local.state.status, "Connection lost. Reconnecting…");
            delays.push(delay(&local, before));
        }
        assert_eq!(delays, [250, 500, 1000, 2000, 4000, 4000, 4000]);
    }
    #[test]
    fn an_unreachable_daemon_past_the_budget_ends_on_the_refresh_message() {
        let (mut local, _events) = fixture();
        local.reconnect_start().unwrap();
        local.recovery.as_mut().unwrap().attempts = 9;
        local.reconnect_retry(Failure::Unreachable).unwrap();
        assert!(
            local.recovery.is_some(),
            "attempts alone never end an unreachable wait"
        );
        local.recovery.as_mut().unwrap().started =
            Instant::now().checked_sub(Duration::from_secs(27)).unwrap();
        local.reconnect_retry(Failure::Unreachable).unwrap();
        assert!(local.recovery.is_none());
        assert_eq!(
            local.state.status,
            "Couldn't reconnect. Refresh sessions to try again."
        );
    }
    #[test]
    fn an_identity_failure_never_retries() {
        let (mut local, _events) = fixture();
        local.reconnect_start().unwrap();
        local.reconnect_retry(Failure::Identity).unwrap();
        assert!(local.recovery.is_none());
        assert_eq!(
            local.state.status,
            "Couldn't reconnect. Refresh sessions to try again."
        );
    }
    #[test]
    fn daemon_errors_are_classified_for_recovery() {
        use herdr_client::tmux_daemon::Error as E;
        let missing = E::RecordIo(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(Failure::of(&missing), Failure::Unreachable);
        assert_eq!(Failure::of(&E::RecordChanged), Failure::Unreachable);
        let refused = E::Network(ureq::Error::Io(std::io::Error::from(
            std::io::ErrorKind::ConnectionRefused,
        )));
        assert_eq!(Failure::of(&refused), Failure::Unreachable);
        for identity in [E::IdentityChanged, E::IdentityFormat, E::Incompatible(3)] {
            assert_eq!(Failure::of(&identity), Failure::Identity);
        }
        let denied = E::RecordIo(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(Failure::of(&denied), Failure::Other);
        assert_eq!(Failure::of(&E::RequestStatus(500)), Failure::Other);
    }
    #[test]
    fn retry_budget_stops() {
        let (mut local, _events) = fixture();
        local.reconnect_start().unwrap();
        local.recovery.as_mut().unwrap().others = 3;
        local.reconnect_retry(Failure::Other).unwrap();
        assert!(local.recovery.is_none());
        assert!(local.stage.is_none());
        assert_eq!(
            local.state.status,
            "Couldn't reconnect. Refresh sessions to try again."
        );
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
            started: Instant::now(),
            others: 1,
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
