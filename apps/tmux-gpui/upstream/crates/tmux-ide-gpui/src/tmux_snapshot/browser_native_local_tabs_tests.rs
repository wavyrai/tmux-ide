#![allow(clippy::unwrap_used)]
use super::*;
fn target(n: u8) -> Target {
    Target {
        key: format!("key-{n}"),
        machine: "remote".into(),
        identity: CatalogIdentity {
            instance_id: "instance".into(),
            environment_id: Some("environment".into()),
        },
        scope: ServerScope {
            server_id: "server".into(),
            generation: "generation".into(),
        },
        live: format!("session-{n}"),
        label: format!("Session {n}"),
        host: "Remote".into(),
        server: "Server".into(),
    }
}
fn command(p: &Publication, action: &str, request: u64) -> Reply {
    Reply {
        request,
        from_request: p.request,
        revision: p.revision,
        action: action.into(),
        outcome: Outcome::Rejected,
    }
}
#[test]
fn availability_and_labels_change_without_rotating_capabilities() {
    let mut tabs = Tabs::default();
    let original = target(1);
    tabs.accept(1, original.clone());
    let first = tabs
        .publish(1, true, std::slice::from_ref(&original))
        .unwrap();
    assert!(first.valid());
    assert!(first.rows[0].available);
    let gone = tabs.publish(1, true, &[]).unwrap();
    assert!(!gone.rows[0].available);
    assert_eq!(gone.revision, first.revision);
    assert_eq!(gone.rows[0].activate, first.rows[0].activate);
    let mut renamed = original.clone();
    renamed.label = "New name".into();
    let changed = tabs.publish(1, true, &[renamed]).unwrap();
    assert_eq!(changed.rows[0].label, "New name");
    assert!(changed.rows[0].available);
    let mut replaced = original;
    replaced.scope.generation = "replacement".into();
    assert!(!tabs.publish(1, true, &[replaced]).unwrap().rows[0].available);
}
#[test]
fn stale_background_and_replayed_commands_do_not_authorize_navigation() {
    let mut tabs = Tabs::default();
    tabs.accept(1, target(1));
    let p = tabs.publish(1, true, &[target(1)]).unwrap();
    let c = command(&p, &p.rows[0].activate, 2);
    assert!(tabs.admit(&c, 1, false).is_none());
    assert!(tabs.admit(&c, 1, true).is_none());
    let mut c = command(&p, &p.rows[0].activate, 3);
    c.revision += 1;
    assert!(tabs.admit(&c, 1, true).is_none());
    assert!(
        tabs.admit(&command(&p, &p.rows[0].activate, 4), 1, true)
            .is_some()
    );
    tabs.cancel();
    assert!(
        tabs.admit(&command(&p, &p.rows[0].close, 5), 1, true)
            .is_none()
    );
}
#[test]
fn pending_attachment_requires_exact_request_and_generation_and_duplicate_ready_is_stable() {
    let mut tabs = Tabs::default();
    tabs.accept(1, target(1));
    tabs.cancel();
    tabs.pending = Some((2, target(1)));
    let mut wrong = target(1);
    wrong.identity.instance_id = "other".into();
    tabs.accept(2, wrong);
    tabs.accept(3, target(1));
    assert!(tabs.active.is_none());
    assert!(tabs.pending.is_some());
    tabs.accept(2, target(1));
    let p = tabs.publish(2, true, &[target(1)]).unwrap();
    tabs.accept(2, target(1));
    assert_eq!(
        tabs.publish(2, true, &[target(1)]).unwrap().revision,
        p.revision
    );
    assert!(tabs.pending.is_none());
}
#[test]
fn retained_tabs_are_bounded_and_source_switch_continuation_is_scoped() {
    let mut tabs = Tabs::default();
    for i in 0..12 {
        tabs.accept(i.into(), target(i));
    }
    assert_eq!(tabs.rows.len(), 8);
    tabs.pending = Some((20, target(11)));
    assert!(tabs.take_transition(19, "remote").is_none());
    assert!(tabs.take_transition(20, "local").is_none());
    let pending = tabs.take_transition(20, "remote");
    tabs.cancel();
    tabs.restore_transition(pending);
    assert_eq!(tabs.pending.unwrap().0, 20);
}

#[path = "browser_native_local_tab_activity_navigation_tests.rs"]
mod activity_navigation;
