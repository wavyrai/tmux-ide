#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn workspace_scopes_retire_on_navigation_and_replay_cannot_select() {
    let mut gate = Gate::default();
    let scope = gate.workspace_scope(1).unwrap();
    assert_eq!(gate.workspace_scope(1), Some(scope));
    let command = Rejected {
        request: 2,
        from_request: 1,
        scope,
        roster_revision: 1,
        key: "row".into(),
    };
    assert!(!gate.admit_workspace(&command, 1, false));
    assert!(!gate.admit_workspace(&command, 1, true));
    let command = Rejected {
        request: 3,
        ..command
    };
    assert!(gate.admit_workspace(&command, 1, true));
    gate.cancel();
    let replacement = gate.workspace_scope(1).unwrap();
    assert!(replacement > scope);
    assert!(!gate.admit_workspace(
        &Rejected {
            request: 4,
            ..command.clone()
        },
        1,
        true
    ));
    assert!(gate.admit_workspace(
        &Rejected {
            request: 5,
            scope: replacement,
            ..command
        },
        1,
        true
    ));
    assert!(gate.workspace_scope(2).unwrap() > replacement);
}

#[test]
fn active_keys_include_unavailable_rows_but_never_cross_catalog_or_server_generation() {
    let mut gate = super::super::tests::ready();
    let context = gate.slots[0].context.clone();
    let Observed::Ready(result) = &mut gate.slots[0].observed else {
        unreachable!()
    };
    result.agents[0].pane_id = None;
    let roster = gate.publication();
    assert!(!roster.rows[0].available);
    let keys = gate.workspace_keys(
        &context.machine,
        &context.catalog_identity,
        &context.scope,
        &context.live,
    );
    assert!(keys.contains(&roster.rows[0].key));
    let mut wrong = context.scope.clone();
    wrong.generation = "other".into();
    assert!(
        gate.workspace_keys(
            &context.machine,
            &context.catalog_identity,
            &wrong,
            &context.live
        )
        .is_empty()
    );
    let mut identity = context.catalog_identity.clone();
    identity.instance_id = "other".into();
    assert!(
        gate.workspace_keys(&context.machine, &identity, &context.scope, &context.live)
            .is_empty()
    );
    gate.suspend();
    assert!(
        gate.workspace_keys(
            &context.machine,
            &context.catalog_identity,
            &context.scope,
            &context.live
        )
        .is_empty()
    );
}
