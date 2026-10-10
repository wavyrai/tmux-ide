#![allow(clippy::unwrap_used)]
use super::*;
use crate::endpoint::tests::host;
#[cfg(feature = "coder")]
use std::sync::Arc;

#[test]
fn explicit_socket_never_reads_shared_catalog() {
    let mut catalog = Catalog::new(&ConnectTarget::Socket("/unused.sock".into()));
    assert!(catalog.poll().is_none());
    assert!(catalog.pending.is_none());
    catalog.choose(LOCAL);
    assert!(catalog.queued_write.is_none());
    assert!(catalog.poll_write().is_none());
    assert!(catalog.writing.is_none());
    assert!(
        Catalog::new(&ConnectTarget::Session {
            name: "test".into(),
            development: true
        })
        .development
            == Some(true)
    );
}

#[test]
fn selection_writes_are_serialized_and_failure_keeps_the_ui_choice() {
    let mut catalog = Catalog::new(&ConnectTarget::Local);
    let (tx, rx) = mpsc::sync_channel(1);
    catalog.writing = Some(rx);
    catalog.choose("ssh:first");
    catalog.choose(LOCAL);
    catalog.choose("ssh:last");
    assert!(catalog.poll_write().is_none());
    assert!(catalog.writing.is_some());
    assert_eq!(catalog.queued_write, Some(Some("ssh:last".into())));
    // Simulate a failed worker without accessing the real user's state root.
    catalog.queued_write = None;
    tx.send(Err(std::io::Error::other("disk unavailable").into()))
        .unwrap();
    assert!(
        matches!(catalog.poll_write(), Some(Error::Io(error)) if error.to_string() == "disk unavailable")
    );
    assert!(catalog.writing.is_none());
    assert_eq!(catalog.desired.as_deref(), Some("ssh:last"));
    assert!(!catalog.restore_pending);
}

#[test]
fn desired_selection_is_client_local_and_catalog_changes_cancel_stale_restore() {
    let update = |enabled, selection| CatalogUpdate {
        hosts: vec![host("a", enabled)],
        wsl: Vec::new(),
        selection,
        #[cfg(feature = "cloud")]
        cloud: None,
    };
    let mut first = Catalog::new(&ConnectTarget::Local);
    let mut second = Catalog::new(&ConnectTarget::Local);
    first.accept(&update(true, Some(Some("ssh:a".into()))));
    second.accept(&update(true, Some(Some("ssh:a".into()))));
    second.choose(LOCAL);
    first.accept(&update(true, Some(None)));
    assert_eq!(first.desired.as_deref(), Some("ssh:a"));
    assert!(first.restore_pending);
    assert_eq!(second.desired, None);
    first.accept(&update(false, None));
    assert_eq!(first.desired, None);
    assert!(!first.restore_pending);
    first.accept(&update(true, None));
    assert!(!first.restore_pending);
    let mut clicked = Catalog::new(&ConnectTarget::Local);
    clicked.choose(LOCAL);
    clicked.accept(&update(true, Some(Some("ssh:a".into()))));
    assert_eq!(
        clicked.desired, None,
        "late startup read cannot undo a click"
    );
    assert_eq!(clicked.queued_write, Some(None));
    second.choose("ssh:a");
    second.accept(&CatalogUpdate {
        hosts: vec![],
        wsl: Vec::new(),
        selection: None,
        #[cfg(feature = "cloud")]
        cloud: None,
    });
    assert_eq!(second.desired, None);
}

#[cfg(feature = "coder")]
#[gpui::test]
fn cloud_devices_follow_ssh_hosts_and_survive_an_unreadable_list(cx: &mut gpui::TestAppContext) {
    let workspace = |id: &str, enabled| crate::cloud::SavedDevice {
        provider: crate::cloud::CloudProvider::Coder,
        id: id.into(),
        label: format!("Coder {id}"),
        account: "https://coder.example.com".into(),
        machine: format!("herdr-{id}"),
        session: "default".into(),
        enabled,
    };
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        let ids = |view: &HerdrWindow| {
            view.endpoints
                .iter()
                .map(|e| e.id.clone())
                .collect::<Vec<_>>()
        };
        view.reconcile_devices(
            vec![host("a", false)],
            Vec::new(),
            Some(vec![workspace("w1", false), workspace("w2", false)]),
            cx,
        );
        assert_eq!(ids(view), [LOCAL, "ssh:a", "coder:w1", "coder:w2"]);
        assert_eq!(
            view.endpoints[2].connection.target,
            workspace("w1", false).target()
        );
        let inbox = view.endpoints[2].connection.inbox.clone();
        // A failed read of the Coder list keeps its endpoints and connections.
        view.reconcile_catalog(vec![host("a", false)], Vec::new(), cx);
        assert_eq!(ids(view), [LOCAL, "ssh:a", "coder:w1", "coder:w2"]);
        assert!(Arc::ptr_eq(&inbox, &view.endpoints[2].connection.inbox));
        let mut moved = workspace("w1", false);
        moved.session = "work".into();
        view.reconcile_devices(vec![], Vec::new(), Some(vec![moved.clone()]), cx);
        assert_eq!(ids(view), [LOCAL, "coder:w1"]);
        assert_eq!(view.endpoints[1].connection.target, moved.target());
        assert!(!Arc::ptr_eq(&inbox, &view.endpoints[1].connection.inbox));
        view.reconcile_devices(vec![], Vec::new(), Some(vec![]), cx);
        assert_eq!(ids(view), [LOCAL]);
    });
}

mod storage_warning;
mod wsl;
