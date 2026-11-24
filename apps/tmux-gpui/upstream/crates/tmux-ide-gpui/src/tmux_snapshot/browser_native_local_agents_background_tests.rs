#![allow(clippy::unwrap_used)]
//! Card #876: the agent rows on Home and in a session's sidebar stay as they
//! are while the window is in the background, and every machine whose daemon
//! pushes replaces the 5 s re-read with its notices.
use super::quiet_link_fixture::{presence, window};
use super::*;

/// Home's agent rows, observed and live.
fn rows(local: &mut Local) {
    let gate = tests::ready();
    local.agents = gate;
    local.agents.catalog = local.agents.contexts.clone();
    local.agents.catalog_total = 1;
    local.state.home_agents = Some(local.agents.publication());
}
fn shown(local: &Local) -> Option<Vec<String>> {
    local
        .state
        .home_agents
        .as_ref()
        .map(|r| r.rows.iter().map(|row| row.name.clone()).collect())
}

/// Leaving the front keeps the agent rows on Home as they are; coming back
/// shows them at once, never "Discovering agents…" from nothing. On main the
/// rows were wiped when the window left the front and loaded again from
/// nothing when it came back.
#[test]
fn home_keeps_its_agent_rows_while_the_window_is_in_the_background() {
    let (mut local, _events) = window(false);
    rows(&mut local);
    let before = shown(&local);
    assert_eq!(before.as_ref().map(Vec::len), Some(1));
    presence(&mut local, false);
    local.agent_tick().unwrap();
    assert_eq!(shown(&local), before, "the rows changed in the background");
    presence(&mut local, true);
    local.agent_tick().unwrap();
    assert_eq!(shown(&local), before, "the rows changed on return");
    assert!(
        local
            .state
            .home_agents
            .as_ref()
            .is_some_and(|r| r.phase != home_agents::Phase::Loading),
        "the rows loaded again from nothing"
    );
}

/// In the background a daemon without push is not read on its timer; the
/// read that is due waits for the window to come back. With push, a notice
/// still reads in the background, so the rows stay current at no cost.
#[test]
fn in_the_background_only_a_daemon_notice_reads_the_agent_rows() {
    let (mut local, _events) = window(false);
    rows(&mut local);
    presence(&mut local, false);
    local.agents.pushed = false;
    local.agents.cycle = false;
    local.agents.due = Some(Instant::now());
    local.agent_tick().unwrap();
    assert!(!local.agents.pool.busy(), "a timer read ran in the background");
    assert!(local.agents.due.is_some(), "the due read was dropped");
    local.agents.pushed = true;
    local.agent_tick().unwrap();
    assert!(local.agents.cycle, "a pushed notice did not read in the background");
}

/// A saved machine whose daemon pushes needs no 5 s re-read: the rows wait
/// for a notice from any machine. A machine without push keeps the timer.
#[test]
fn every_pushing_machine_replaces_the_agent_timer() {
    let local = tests::context();
    let mut remote = local.clone();
    remote.machine = "saved".into();
    remote.key = "saved-key".into();
    let finish = |gate: &mut Gate| {
        gate.cycle = true;
        gate.due = None;
        gate.poll(false, Instant::now());
    };
    let both: std::collections::BTreeSet<String> = ["local".into(), "saved".into()].into();
    let mut gate = Default::default();
    let gate: &mut Gate = &mut gate;
    gate.configure(vec![local.clone(), remote.clone()], 2, false, 0, Instant::now());
    gate.pushed(&both, false);
    finish(gate);
    assert!(gate.due.is_none(), "a pushing saved machine kept the timer");
    gate.pushed(&both, true);
    assert!(gate.due.is_some_and(|due| due <= Instant::now()), "a notice did not read");
    let only_local: std::collections::BTreeSet<String> = ["local".into()].into();
    gate.pushed(&only_local, false);
    finish(gate);
    assert!(gate.due.is_some(), "a saved machine without push lost its re-read");
}

