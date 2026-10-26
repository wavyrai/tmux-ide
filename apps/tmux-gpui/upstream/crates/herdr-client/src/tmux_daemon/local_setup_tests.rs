#![allow(clippy::unwrap_used)]
use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("tmux-native-setup-{}", uuid::Uuid::new_v4()));
        let root = home.join(".local/share/tmux-ide");
        let release = root.join("releases/install-Owned1");
        fs::create_dir_all(release.join("node/bin")).unwrap();
        fs::create_dir_all(release.join("npm/lib/node_modules/tmux-ide/bin")).unwrap();
        fs::write(root.join("installer-v1"), b"1\n").unwrap();
        fs::write(release.join(".installer-release-v1"), b"1\n").unwrap();
        fs::write(release.join("node/bin/node"), b"#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(
            release.join("node/bin/node"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
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
        symlink("releases/install-Owned1", root.join("current")).unwrap();
        Self(home)
    }
    fn installation(&self) -> LocalSetupInstallation {
        resolve_local_setup(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn read_only_resolution_and_exact_command_sequence() {
    let fixture = Fixture::new();
    let installation = fixture.installation();
    let mut calls = Vec::new();
    installation
        .execute(&AtomicBool::new(false), |args, _| {
            calls.push(args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
            Ok(if args == ["--version"] {
                b"tmux-ide v2.9.12\n".to_vec()
            } else {
                br#"{"ok":true,"status":"ready","productVersion":"2.9.12","instanceId":"fixture"}"#
                    .to_vec()
            })
        })
        .unwrap();
    assert_eq!(
        calls,
        vec![vec!["--version"], vec!["update", "--daemon", "--json"]]
    );
}
#[test]
fn changed_installation_between_version_and_setup_never_runs_setup() {
    let fixture = Fixture::new();
    let installation = fixture.installation();
    let mut calls = 0;
    let result = installation.execute(&AtomicBool::new(false), |_, _| {
        calls += 1;
        fs::write(&installation.cli, b"changed fixture").unwrap();
        Ok(b"tmux-ide v2.9.12".to_vec())
    });
    assert!(matches!(result, Err(LocalSetupError::Installation)));
    assert_eq!(calls, 1);
}
#[test]
fn unsupported_versions_redirected_files_and_non_managed_roots_are_rejected() {
    let fixture = Fixture::new();
    let installation = fixture.installation();
    fs::write(
        installation
            .cli
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("package.json"),
        br#"{"name":"tmux-ide","version":"99.0.0","bin":{"tmux-ide":"bin/cli.js"}}"#,
    )
    .unwrap();
    assert!(matches!(
        resolve_local_setup(&fixture.0),
        Err(LocalSetupError::Unsupported)
    ));
    let fixture = Fixture::new();
    let installation = fixture.installation();
    fs::remove_file(&installation.cli).unwrap();
    symlink(&installation.node, &installation.cli).unwrap();
    assert!(resolve_local_setup(&fixture.0).is_err());
    assert!(matches!(
        resolve_local_setup(Path::new("relative")),
        Err(LocalSetupError::Installation)
    ));
    assert!(matches!(
        resolve_local_setup(&{
            let empty = fixture.0.join("empty-home");
            fs::create_dir(&empty).unwrap();
            empty
        }),
        Err(LocalSetupError::Missing)
    ));
}
#[test]
fn cancellation_and_wrong_version_do_not_execute_setup() {
    let fixture = Fixture::new();
    let installation = fixture.installation();
    assert!(matches!(
        installation.execute(&AtomicBool::new(true), |_, _| panic!("must not run")),
        Err(LocalSetupError::Stopped)
    ));
    let mut calls = 0;
    let result = installation.execute(&AtomicBool::new(false), |_, _| {
        calls += 1;
        Ok(b"tmux-ide v2.9.11".to_vec())
    });
    assert!(matches!(result, Err(LocalSetupError::Response)));
    assert_eq!(calls, 1);
}
#[test]
fn private_fixture_process_executes_without_shell_interpolation_and_bounds_output() {
    let fixture = Fixture::new();
    let installation = fixture.installation();
    fs::write(&installation.node,b"#!/bin/sh\nif [ \"$2\" = --version ]; then printf 'tmux-ide v2.9.12\\n'; else printf '{\"ok\":true,\"status\":\"ready\",\"productVersion\":\"2.9.12\",\"instanceId\":\"fixture\"}'; fi\n").unwrap();
    fixture.installation().run(&AtomicBool::new(false)).unwrap();
    fs::write(
        &installation.node,
        b"#!/bin/sh\nwhile :; do printf '0123456789012345678901234567890123456789'; done\n",
    )
    .unwrap();
    assert!(matches!(
        fixture.installation().run(&AtomicBool::new(false)),
        Err(LocalSetupError::Response)
    ));
}
#[test]
fn cancellation_reaps_only_the_owned_waiter() {
    let fixture = Fixture::new();
    let installation = fixture.installation();
    fs::write(&installation.node, b"#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
    let installation = fixture.installation();
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let stop = cancel.clone();
    let began = Instant::now();
    let worker = std::thread::spawn(move || installation.run(&stop));
    std::thread::sleep(Duration::from_millis(40));
    cancel.store(true, Ordering::Release);
    assert!(matches!(
        worker.join().unwrap(),
        Err(LocalSetupError::Stopped)
    ));
    assert!(began.elapsed() < Duration::from_secs(3));
}
