//! The invariant across a connection drop: rows stay as last known while the
//! link is down; back on the same daemon generation, one re-read makes the
//! view what a fresh load gives; a different generation keeps nothing.
use super::*;

type Shown = Vec<(String, String, bool, String)>;
fn shown(gate: &mut Gate) -> Shown {
    gate.publication()
        .rows
        .into_iter()
        .map(|r| {
            (
                r.name,
                r.status.label().to_owned(),
                r.attention,
                r.session_label,
            )
        })
        .collect()
}
/// A gate showing two agents; the second needs input.
fn two_agents() -> Gate {
    let mut gate = ready();
    let Observed::Ready(value) = &mut gate.slots[0].observed else {
        unreachable!()
    };
    let mut waiting = agent();
    waiting.id = "agent.two".into();
    waiting.name = "Review".into();
    waiting.attention = true;
    value.agents.push(waiting);
    gate
}
fn observation(gate: &Gate) -> AgentObservation {
    let Observed::Ready(value) = &gate.slots[0].observed else {
        unreachable!()
    };
    value.clone()
}
fn deliver(gate: &mut Gate, value: AgentObservation) {
    let epoch = uuid::Uuid::new_v4();
    gate.epoch = Some(epoch);
    let key = gate.contexts[0].key.clone();
    gate.apply(&key, epoch, Ok(value));
}

#[test]
fn a_drop_keeps_every_row_and_pill_until_fresh_data() {
    let mut gate = two_agents();
    let before = shown(&mut gate);
    assert_eq!(before.len(), 2);
    gate.pause();
    assert_eq!(
        shown(&mut gate),
        before,
        "nothing disappears during the drop"
    );
    assert!(gate.due.is_none(), "no reads while the link is down");
    assert!(!gate.poll(true, Instant::now()));
    assert!(!gate.pool.busy());
    // Back on the same sessions: the rows stay, and one re-read is due.
    let contexts = gate.contexts.clone();
    assert!(!gate.configure(contexts, 1, false, 0, Instant::now()));
    assert!(gate.due.is_some());
    assert_eq!(shown(&mut gate), before);
}

#[test]
fn back_on_the_same_generation_the_view_equals_a_fresh_load() {
    let mut gate = two_agents();
    let contexts = gate.contexts.clone();
    gate.pause();
    assert!(!gate.configure(contexts.clone(), 1, false, 0, Instant::now()));
    // The re-read: the waiting agent finished while the link was down.
    let mut fresh_value = observation(&gate);
    fresh_value.agents.retain(|a| a.id != "agent.two");
    deliver(&mut gate, fresh_value.clone());
    let mut fresh = Gate::default();
    fresh.configure(contexts, 1, false, 0, Instant::now());
    deliver(&mut fresh, fresh_value);
    let after = shown(&mut gate);
    assert_eq!(after, shown(&mut fresh));
    assert!(
        after.iter().all(|(name, ..)| name != "Review"),
        "a finished agent doesn't linger"
    );
}

#[test]
fn a_different_generation_keeps_nothing_after_its_first_catalog() {
    for change in ["daemon", "server-generation", "session"] {
        let mut gate = two_agents();
        gate.pause();
        let mut next = gate.contexts[0].clone();
        match change {
            "daemon" => next.catalog_identity.instance_id = uuid::Uuid::new_v4().to_string(),
            "server-generation" => next.scope.generation = uuid::Uuid::new_v4().to_string(),
            _ => next.live = format!("live-session.{}", "b".repeat(20)),
        }
        assert!(gate.configure(vec![next], 1, false, 0, Instant::now()));
        assert!(shown(&mut gate).is_empty(), "{change}");
        assert!(!gate.stale, "{change}");
    }
}

#[test]
fn a_reset_forgets_the_rows() {
    let mut gate = two_agents();
    gate.pause();
    gate.cancel();
    assert!(shown(&mut gate).is_empty());
    assert!(!gate.stale);
}

/// Last known, not current: the flag holds for as long as the drop lasts and
/// through the re-read after it, and clears only when that read completes.
#[test]
fn rows_say_last_known_until_the_reread_after_the_drop_completes() {
    let mut gate = two_agents();
    let before = shown(&mut gate);
    assert!(!gate.last_known());
    // A long recovery: the agent lane ticks many times while the link is down.
    for _ in 0..1000 {
        gate.pause();
    }
    assert!(gate.last_known());
    assert_eq!(shown(&mut gate), before);
    let contexts = gate.contexts.clone();
    assert!(!gate.configure(contexts, 1, false, 0, Instant::now()));
    assert!(gate.last_known(), "still last known while the re-read runs");
    let now = Instant::now();
    gate.poll(true, now);
    assert!(gate.last_known());
    assert!(
        gate.poll(true, now),
        "the re-read's end is a change to publish"
    );
    assert!(!gate.last_known());
}
