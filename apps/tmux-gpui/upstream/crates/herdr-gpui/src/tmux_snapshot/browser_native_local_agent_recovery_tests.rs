use super::*;
use crate::tmux_snapshot::home::recovery::Action;
#[test]
fn recovery_consumes_the_exact_publication_and_revokes_its_rows() {
    let mut gate = ready();
    gate.total = 40;
    let roster = gate.publication();
    assert!(!gate.recover(roster.revision + 1, Action::LoadMore));
    assert_eq!(gate.session_limit(), 32);
    assert!(gate.resolve(&roster.rows[0].key, roster.revision).is_some());
    assert!(gate.recover(roster.revision, Action::LoadMore));
    assert_eq!(gate.session_limit(), 64);
    assert!(gate.resolve(&roster.rows[0].key, roster.revision).is_none());
    assert!(!gate.recover(roster.revision, Action::LoadMore));
    gate.cancel();
    assert_eq!(gate.session_limit(), 32);
}
#[test]
fn load_more_expands_by_pages_to_a_hard_limit_and_reports_remaining_sessions() {
    let mut gate = Gate::default();
    let all: Vec<_> = (0..600)
        .map(|i| {
            let mut c = context();
            c.key = i.to_string();
            c
        })
        .collect();
    for expected in (32..=MAX_AGENT_OBSERVATION_SESSIONS).step_by(32) {
        gate.configure(all.clone(), 600, false, 0, Instant::now());
        let roster = gate.publication();
        assert_eq!(gate.contexts.len(), expected);
        assert_eq!(roster.truncated_sessions, (600 - expected) as u64);
        let can_load = expected < MAX_AGENT_OBSERVATION_SESSIONS;
        assert_eq!(
            gate.recovery_capability(roster.revision).can_load_more,
            can_load
        );
        assert_eq!(gate.recover(roster.revision, Action::LoadMore), can_load);
    }
}
#[test]
fn retry_requires_a_failed_observation_and_cannot_run_hidden_or_in_workspace() {
    let mut gate = ready();
    let live = gate.publication();
    assert!(!gate.recover(live.revision, Action::Retry));
    gate.slots[0].observed = Observed::Failed;
    let failed = gate.publication();
    gate.workspace = true;
    assert!(!gate.recover(failed.revision, Action::Retry));
    gate.workspace = false;
    assert!(gate.recover(failed.revision, Action::Retry));
    assert!(!gate.recover(failed.revision, Action::Retry));
    assert_eq!(gate.session_limit(), 32);
    assert!(gate.published.is_empty());
}

#[test]
fn still_valid_controls_survive_partial_results_but_not_reconfiguration() {
    let mut gate = ready();
    gate.total = 40;
    let first = gate.publication();
    gate.slots[0].observed = Observed::Failed;
    let partial = gate.publication();
    assert!(gate.control_current(first.revision));
    assert!(!gate.recover(first.revision, Action::Retry)); // Retry did not exist yet.
    assert!(gate.recover(first.revision, Action::LoadMore));
    assert!(!gate.control_current(partial.revision));
    gate.configure(vec![context()], 40, false, 0, Instant::now());
    gate.publication();
    assert!(!gate.control_current(first.revision));
    assert!(!gate.recover(partial.revision, Action::LoadMore));
}

#[test]
fn actual_failed_worker_can_be_retried_without_reusing_its_old_publication() {
    let mut gate = Gate::default();
    let c = context();
    gate.sources.insert(
        c.machine.clone(),
        CatalogSource::Local(PathBuf::from(
            "/nonexistent-native-recovery-fixture/daemon.json",
        )),
    );
    let mut previous = None;
    for _ in 0..2 {
        gate.configure(vec![c.clone()], 1, false, 0, Instant::now());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            gate.poll(true, Instant::now());
            if matches!(gate.slots[0].observed, Observed::Failed) && !gate.pool.busy() {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        let failed = gate.publication();
        assert!(failed.phase == home_agents::Phase::Unavailable);
        assert!(gate.recovery_capability(failed.revision).can_retry);
        if let Some(old) = previous {
            assert!(!gate.recover(old, Action::Retry));
        }
        assert!(gate.recover(failed.revision, Action::Retry));
        assert!(!gate.recover(failed.revision, Action::Retry));
        previous = Some(failed.revision);
    }
}
