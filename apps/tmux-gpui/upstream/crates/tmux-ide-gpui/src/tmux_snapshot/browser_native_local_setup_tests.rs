#![allow(clippy::unwrap_used)]
use super::*;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
fn fixture() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".local/share/tmux-ide");
    let release = root.join("releases/install-Test1");
    fs::create_dir_all(release.join("node/bin")).unwrap();
    fs::create_dir_all(release.join("npm/lib/node_modules/tmux-ide/bin")).unwrap();
    fs::write(root.join("installer-v1"), b"1\n").unwrap();
    fs::write(release.join(".installer-release-v1"), b"1\n").unwrap();
    let node = release.join("node/bin/node");
    fs::write(&node,b"#!/bin/sh\nif [ \"$2\" = --version ]; then printf 'tmux-ide v2.9.12\\n'; else printf ran > \"$HOME/ran\"; printf '{\"ok\":true,\"status\":\"ready\",\"productVersion\":\"2.9.12\",\"instanceId\":\"test\"}'; fi\n").unwrap();
    fs::set_permissions(node, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        release.join("npm/lib/node_modules/tmux-ide/bin/cli.js"),
        b"fixture",
    )
    .unwrap();
    fs::write(
        release.join("npm/lib/node_modules/tmux-ide/package.json"),
        br#"{"name":"tmux-ide","version":"2.9.12","bin":{"tmux-ide":"bin/cli.js"}}"#,
    )
    .unwrap();
    symlink("releases/install-Test1", root.join("current")).unwrap();
    home
}
fn poll(owner: &Owner) -> (u64, Option<Phase>) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(result) = owner.setup_poll().unwrap() {
            return result;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn offer_is_read_only_and_explicit_setup_runs_in_its_inspected_home() {
    let home = fixture();
    let owner = Owner::new(CatalogSource::Local(home.path().join("record")));
    owner
        .0
        .lock()
        .unwrap()
        .setup
        .start_home(7, home.path().into(), false)
        .unwrap();
    assert!(poll(&owner) == (7, Some(Phase::Available)));
    assert!(!home.path().join("ran").exists());
    owner
        .0
        .lock()
        .unwrap()
        .setup
        .start_home(8, home.path().into(), true)
        .unwrap();
    assert!(poll(&owner) == (8, None));
    assert_eq!(fs::read(home.path().join("ran")).unwrap(), b"ran");
    owner.shutdown().unwrap();
}
#[test]
fn cancel_discards_late_results_and_shutdown_cannot_launch_another_job() {
    let home = fixture();
    let owner = Owner::new(CatalogSource::Local(home.path().join("record")));
    owner
        .0
        .lock()
        .unwrap()
        .setup
        .start_home(1, home.path().into(), false)
        .unwrap();
    let cancelled = owner
        .0
        .lock()
        .unwrap()
        .setup
        .job
        .as_ref()
        .unwrap()
        .cancel
        .clone();
    owner.cancel_setup().unwrap();
    assert!(cancelled.load(Ordering::Acquire));
    assert!(owner.setup_poll().unwrap().is_none());
    owner.shutdown().unwrap();
    assert!(
        !owner
            .setup_start(2, &home.path().join("record"), true)
            .unwrap()
    );
}
#[test]
fn isolated_record_never_resolves_the_personal_installation() {
    let home = fixture();
    let mut gate = Gate::default();
    assert!(
        !gate
            .start(1, &home.path().join("daemon.json"), true)
            .unwrap()
    );
    assert!(gate.job.is_none());
    assert!(!home.path().join("ran").exists());
}
