//! Bounded, read-only rediscovery. A new daemon authorizes an old server generation
//! only for a local restart with the identical live session, and recovery never
//! repeats owner mutations.
use super::*;

pub(super) struct Recovery {
    target: Target,
    pane: Option<String>,
    attempts: u8,
    due: Option<Instant>,
    started: Instant,
    others: u8,
    /// The private local record recovery began on; `None` for any remote source.
    local_record: Option<PathBuf>,
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
            local_record: self.current_local_record(),
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
    fn current_local_record(&self) -> Option<PathBuf> {
        match self.sources.observation_source().ok()? {
            CatalogSource::Local(record) if self.selected_profile.is_none() => Some(record),
            _ => None,
        }
    }
    /// Select an exact generation/session match in the newly verified catalog. A
    /// restarted local daemon has a new generation; its live session id hashes the
    /// tmux server pid, session id and creation time, so an identical id on the
    /// same server and the same private record is the same tmux session.
    pub(super) fn reconnect_catalog(&mut self) -> Result<bool, Error> {
        let Some(recovery) = self.recovery.take() else {
            return Ok(false);
        };
        let same_local_daemon =
            recovery.local_record.is_some() && recovery.local_record == self.current_local_record();
        let key = self
            .targets
            .iter()
            .find(|(_, target)| {
                target.scope == recovery.target.scope && target.live == recovery.target.live
            })
            .or_else(|| {
                self.targets.iter().find(|(_, target)| {
                    same_local_daemon
                        && target.scope.server_id == recovery.target.scope.server_id
                        && target.live == recovery.target.live
                })
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
                events: events.into(),
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
    fn restarted(local: &mut Local, mut target: Target, server: &str, live: &str) {
        target.scope.generation = "replacement".into();
        target.scope.server_id = server.into();
        target.live = live.into();
        local.targets.insert("new-token".into(), target);
    }
    fn fell_back(local: &Local) {
        assert!(local.stage.is_none());
        assert!(local.recovery.is_none());
        assert!(local.state.home_phase == HomePhase::Unavailable);
        assert_eq!(
            local.state.status,
            "Previous session identity changed or disappeared — select a session"
        );
    }
    #[test]
    fn local_restart_with_the_same_live_id_reopens_that_session() {
        let (mut local, _events) = fixture();
        let target = local.active.as_ref().unwrap().target.clone();
        local.reconnect_start().unwrap();
        restarted(&mut local, target, "server", "$1");
        local.reconnect_catalog().unwrap();
        assert!(
            matches!(&local.stage, Some(Stage::Open { preferred, .. }) if preferred.as_deref() == Some("%2"))
        );
        assert!(local.recovery.is_some());
    }
    #[test]
    fn same_generation_with_another_live_session_falls_back() {
        let (mut local, _events) = fixture();
        let mut target = local.active.as_ref().unwrap().target.clone();
        local.reconnect_start().unwrap();
        local.targets.clear();
        target.live = "$9".into();
        local.targets.insert("other-token".into(), target);
        local.reconnect_catalog().unwrap();
        fell_back(&local);
    }
    #[test]
    fn local_restart_with_a_recreated_session_falls_back() {
        let (mut local, _events) = fixture();
        let target = local.active.as_ref().unwrap().target.clone();
        local.reconnect_start().unwrap();
        restarted(&mut local, target, "server", "$9");
        local.reconnect_catalog().unwrap();
        fell_back(&local);
    }
    #[test]
    fn local_restart_on_another_server_falls_back() {
        let (mut local, _events) = fixture();
        let target = local.active.as_ref().unwrap().target.clone();
        local.reconnect_start().unwrap();
        restarted(&mut local, target, "other-server", "$1");
        local.reconnect_catalog().unwrap();
        fell_back(&local);
    }
    #[test]
    fn replacement_generation_cannot_reopen_same_session_id() {
        // SSH: a saved profile is selected, so recovery has no local record.
        let (mut local, _events) = fixture();
        local.selected_profile = Some(herdr_client::tmux_daemon::SavedMachine {
            id: uuid::Uuid::new_v4().to_string(),
            label: "Build".into(),
            ssh_target: "fixture.invalid".into(),
            expected_environment_id: None,
            enabled: true,
        });
        let target = local.active.as_ref().unwrap().target.clone();
        local.reconnect_start().unwrap();
        assert!(local.recovery.as_ref().unwrap().local_record.is_none());
        restarted(&mut local, target, "server", "$1");
        local.reconnect_catalog().unwrap();
        fell_back(&local);
    }
    #[test]
    fn a_different_local_record_cannot_reopen_across_generations() {
        let (mut local, _events) = fixture();
        let target = local.active.as_ref().unwrap().target.clone();
        local.reconnect_start().unwrap();
        local.recovery.as_mut().unwrap().local_record =
            Some(PathBuf::from("/nonexistent-reconnect-test/other.json"));
        restarted(&mut local, target, "server", "$1");
        local.reconnect_catalog().unwrap();
        fell_back(&local);
    }
    #[test]
    fn a_pane_action_in_flight_across_a_restart_is_not_replayed() {
        let (mut local, _events) = fixture();
        let route = local.active.as_ref().unwrap();
        let operation_id = uuid::Uuid::new_v4();
        let request = browser_native_owner::Request {
            version: 1,
            id: route.id.clone(),
            request: route.request,
            sequence: 1,
            operation_id: operation_id.to_string(),
            live_session_id: route.target.live.clone(),
            generation: route.target.scope.generation.clone(),
            pane: "%2".into(),
            action: browser_native_owner::Action::NewWindow,
        };
        local.stage = Some(Stage::Owner {
            scope: route.target.scope.clone(),
            operation_id,
            creation: herdr_client::tmux_daemon::PaneCreation {
                workspace_name: route.workspace.clone(),
                live_session_id: route.target.live.clone(),
                source_pane: "%2".into(),
                kind: herdr_client::tmux_daemon::NewPane::Terminal,
            },
            request,
        });
        local.submitted = true;
        let target = local.active.as_ref().unwrap().target.clone();
        local.reconnect_start().unwrap();
        assert!(local.recovery.is_none());
        assert!(local.stage.is_none());
        assert_eq!(
            local.state.status,
            "Connection lost during an action — refresh to inspect its outcome"
        );
        restarted(&mut local, target, "server", "$1");
        assert!(!local.reconnect_catalog().unwrap());
        assert!(local.stage.is_none());
    }
    #[test]
    fn a_mutation_in_flight_across_a_restart_is_not_replayed() {
        let (mut local, _events) = fixture();
        let operation_id = uuid::Uuid::new_v4();
        local.stage = Some(Stage::Create {
            scope: local.active.as_ref().unwrap().target.scope.clone(),
            operation_id,
            name: "never replay".into(),
        });
        local.submitted = true;
        let target = local.active.as_ref().unwrap().target.clone();
        local.reconnect_start().unwrap();
        restarted(&mut local, target, "server", "$1");
        assert!(!local.reconnect_catalog().unwrap());
        assert!(local.stage.is_none());
        assert!(local.recovery.is_none());
        assert_eq!(local.uncertain_create, Some(operation_id));
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
    fn other_failures_get_exactly_three_retries() {
        let (mut local, _events) = fixture();
        local.reconnect_start().unwrap();
        assert_eq!(local.recovery.as_ref().unwrap().others, 1);
        local.reconnect_retry(Failure::Other).unwrap();
        local.reconnect_retry(Failure::Other).unwrap();
        assert_eq!(local.recovery.as_ref().unwrap().others, 3);
        assert!(local.recovery.as_ref().unwrap().waiting());
        assert_eq!(local.state.status, "Connection lost. Reconnecting…");
        local.reconnect_retry(Failure::Other).unwrap();
        assert!(local.recovery.is_none());
        assert_eq!(
            local.state.status,
            "Couldn't reconnect. Refresh sessions to try again."
        );
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
            local_record: None,
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

    /// A pane's rejected update (`Error::Terminal`) reaches the catalog as this
    /// reconnect. A full event queue at that moment must not end the catalog.
    #[test]
    fn reconnect_survives_a_full_event_queue() {
        let (mut local, _unused) = fixture();
        let (events, receiver) = mpsc::sync_channel(1);
        events.try_send(Incoming::Closed).unwrap();
        local.events = events.into();
        local.reconnect_start().unwrap();
        assert_eq!(local.state.status, "Connection lost. Reconnecting…");
        assert!(local.recovery.is_some());
        assert!(matches!(receiver.try_recv().unwrap(), Incoming::Closed));
        // Each later publication first delivers what waited, in order.
        local.publish().unwrap();
        assert!(matches!(
            receiver.try_recv().unwrap(),
            Incoming::Handoff(Event::Close { request: 7, .. })
        ));
        local.publish().unwrap();
        let Incoming::Catalog(state) = receiver.try_recv().unwrap() else {
            panic!("expected the reconnecting snapshot");
        };
        assert_eq!(state.status, "Connection lost. Reconnecting…");
        assert!(receiver.try_recv().is_err());
    }
    /// The transport turns a poll error into `NativeTerminalInterrupted`
    /// (browser_native_transport.rs). The actor must survive it while the
    /// terminal loop is behind, and show that it is reconnecting.
    #[test]
    fn the_actor_survives_a_terminal_interruption_while_the_event_queue_is_full() {
        let (mut local, _unused) = fixture();
        let (events, receiver) = mpsc::sync_channel(1);
        local.events = events.into();
        let (commands, input) = mpsc::sync_channel(32);
        let actor = std::thread::spawn(move || local.run(input));
        // Startup's publication stays unread, so the queue is full.
        std::thread::sleep(Duration::from_millis(200));
        commands
            .send(Command::NativeTerminalInterrupted {
                version: 1,
                id: "old-route".into(),
                request: 7,
                pane: "%2".into(),
                live_session_id: "$1".into(),
                generation: "generation".into(),
                presence_revision: 0,
            })
            .unwrap();
        actor.thread().unpark();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!actor.is_finished(), "the catalog actor exited");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut reconnecting = false;
        while !reconnecting && Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(Incoming::Catalog(state)) => {
                    reconnecting = state.status == "Connection lost. Reconnecting…";
                }
                // Never unpark here: the actor must wake itself while events wait.
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(reconnecting, "no reconnecting status was published");
        assert!(!actor.is_finished(), "the catalog actor exited");
        drop(commands);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !actor.is_finished() && Instant::now() < deadline {
            actor.thread().unpark();
            while receiver.try_recv().is_ok() {}
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(actor.is_finished(), "the actor did not stop with its owner");
    }

    #[test]
    fn a_catalog_error_on_an_open_session_becomes_a_reconnect() {
        let (mut local, _events) = fixture();
        local
            .survive(Error::Invalid(
                "native catalog result did not match its request",
            ))
            .unwrap();
        assert!(local.active.is_none());
        assert!(local.recovery.is_some());
        assert_eq!(local.state.status, "Connection lost. Reconnecting…");
        // A second error while recovering is one more retry, not a new recovery.
        local
            .survive(Error::Invalid(
                "native catalog result did not match its request",
            ))
            .unwrap();
        assert_eq!(local.recovery.as_ref().unwrap().others, 2);
    }
    #[test]
    fn a_catalog_error_at_home_becomes_a_refresh_notice() {
        let (mut local, _events) = fixture();
        local.active = None;
        local
            .survive(Error::Invalid("picker catalog identity changed"))
            .unwrap();
        assert!(local.state.home_phase == HomePhase::Unavailable);
        assert_eq!(
            local.state.status,
            "Something went wrong. Refresh sessions to try again."
        );
    }
    #[test]
    fn only_a_gone_terminal_loop_ends_the_actor() {
        let (mut local, events) = fixture();
        drop(events);
        let error = local.survive(Error::Invalid("picker catalog identity changed"));
        assert!(error.is_err_and(|error| outbox::closed(&error)));
    }

    #[test]
    fn a_full_command_queue_waits_for_the_actor_instead_of_failing() {
        let (sender, input) = mpsc::sync_channel(1);
        let commands = watch::Commands::new(sender, std::thread::current());
        commands.send(Command::Refresh { request: 1 }).unwrap();
        let drain = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let first = input.recv_timeout(Duration::from_secs(5)).unwrap();
            let second = input.recv_timeout(Duration::from_secs(5)).unwrap();
            (first, second, input)
        });
        commands.send(Command::Refresh { request: 2 }).unwrap();
        let (first, second, input) = drain.join().unwrap();
        assert!(matches!(first, Command::Refresh { request: 1 }));
        assert!(matches!(second, Command::Refresh { request: 2 }));
        drop(input);
        assert!(commands.send(Command::Refresh { request: 3 }).is_err());
    }

    /// An idle actor parks. Events still waiting for room must not wait for a wake
    /// that never comes: the terminal loop reading its queue does not unpark it.
    #[test]
    fn an_idle_actor_delivers_waiting_events_without_being_woken() {
        let (mut local, _unused) = fixture();
        local.active = None;
        let (events, receiver) = mpsc::sync_channel(1);
        local.events = events.into();
        let (commands, input) = mpsc::sync_channel(32);
        let actor = std::thread::spawn(move || local.run(input));
        // Startup's publication stays unread, so the queue is full.
        std::thread::sleep(Duration::from_millis(200));
        commands
            .send(Command::Presence {
                active: true,
                revision: 5,
            })
            .unwrap();
        // The one wake a command brings, as `watch::Commands::send` gives it.
        actor.thread().unpark();
        std::thread::sleep(Duration::from_millis(200));
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(5)),
            Ok(Incoming::Catalog(_))
        ));
        let next = receiver.recv_timeout(Duration::from_secs(2));
        assert!(
            matches!(&next, Ok(Incoming::Catalog(state)) if state.presence_revision == 5),
            "the waiting publication was not delivered"
        );
        drop(commands);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !actor.is_finished() && Instant::now() < deadline {
            actor.thread().unpark();
            while receiver.try_recv().is_ok() {}
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(actor.is_finished(), "the actor did not stop with its owner");
    }

    /// Review round 1, item 1: a turn that fails inside a running actor becomes a
    /// published recovery status, and the actor keeps running.
    #[test]
    fn a_failing_turn_is_survived_by_the_running_actor() {
        let (mut local, _unused) = fixture();
        let (events, receiver) = mpsc::sync_channel(64);
        local.events = events.into();
        let owner = local.sources.clone();
        let (commands, input) = mpsc::sync_channel(32);
        let actor = std::thread::spawn(move || local.run(input));
        std::thread::sleep(Duration::from_millis(200));
        while receiver.try_recv().is_ok() {}
        // A stopped owner makes `switch_source` fail on `sources.replace` mid-turn.
        owner.shutdown().unwrap();
        commands
            .send(Command::Machine {
                request: 8,
                ssh_target: None,
            })
            .unwrap();
        actor.thread().unpark();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut recovered = false;
        while !recovered && Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(Incoming::Catalog(state)) => {
                    recovered = matches!(
                        state.status.as_str(),
                        "Something went wrong. Refresh sessions to try again."
                            | "Connection lost. Reconnecting…"
                    );
                }
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => actor.thread().unpark(),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(recovered, "no recovery status was published");
        std::thread::sleep(Duration::from_millis(200));
        assert!(!actor.is_finished(), "the catalog actor exited");
        drop(commands);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !actor.is_finished() && Instant::now() < deadline {
            actor.thread().unpark();
            while receiver.try_recv().is_ok() {}
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(actor.is_finished(), "the actor did not stop with its owner");
    }

    /// Review note N1: an idle actor parks with no timeout, so only the wake in
    /// `watch::Commands::send` lets it see a command.
    #[test]
    fn a_command_wakes_a_parked_actor() {
        let (mut local, _unused) = fixture();
        local.active = None;
        let (events, receiver) = mpsc::sync_channel(64);
        local.events = events.into();
        let (sender, input) = mpsc::sync_channel(32);
        let actor = std::thread::spawn(move || local.run(input));
        // Startup settles and the actor parks.
        std::thread::sleep(Duration::from_millis(300));
        while receiver.try_recv().is_ok() {}
        let commands = watch::Commands::new(sender, actor.thread().clone());
        commands
            .send(Command::Presence {
                active: true,
                revision: 9,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut woke = false;
        while !woke && Instant::now() < deadline {
            if let Ok(Incoming::Catalog(state)) = receiver.recv_timeout(Duration::from_millis(20)) {
                woke = state.presence_revision == 9;
            }
        }
        assert!(woke, "the parked actor never saw the command");
        drop(commands);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !actor.is_finished() && Instant::now() < deadline {
            actor.thread().unpark();
            while receiver.try_recv().is_ok() {}
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(actor.is_finished(), "the actor did not stop with its owner");
    }
}
