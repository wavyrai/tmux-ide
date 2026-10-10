use super::*;
use std::os::unix::net::UnixListener;
use std::sync::atomic::AtomicUsize;

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn socket() -> PathBuf {
    env::temp_dir().join(format!(
        "gpui-{}-{}.sock",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn existing_daemon_does_not_launch() {
    let path = socket();
    let listener = UnixListener::bind(&path).unwrap();
    let result = connect_or_start(
        &path,
        &AtomicBool::new(false),
        Duration::ZERO,
        || panic!("must not launch"),
        true,
    );
    assert!(result.is_ok());
    drop(listener);
    std::fs::remove_file(path).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn local_endpoint_survives_executable_removal_and_replacement() {
    // Only this test dials the endpoint; the rest just bind one.
    use std::os::unix::{fs::PermissionsExt, net::UnixStream};
    let root = socket();
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let dir = root.join("session");
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("herdr-client.sock");
    let listener = UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let stream = UnixStream::connect(&path).unwrap();
    let (_accepted, _) = listener.accept().unwrap();
    // No executable argument or process-path probe participates in trust.
    let installed = dir.join("herdr");
    std::fs::write(&installed, "old installation").unwrap();
    assert!(peer_matches_local_endpoint(&stream, &path, &path));
    std::fs::remove_file(&installed).unwrap();
    assert!(peer_matches_local_endpoint(&stream, &path, &path));
    std::fs::write(&installed, "replacement installation").unwrap();
    assert!(peer_matches_local_endpoint(&stream, &path, &path));
    assert!(!peer_matches_local_endpoint(
        &stream,
        &path,
        &dir.join("forwarded.sock")
    ));
    assert!(!is_local_peer(
        &stream,
        &ConnectTarget::Ssh {
            target: "remote".into(),
            session: "default".into(),
        },
        &path,
    ));
    let forwarded = dir.join("forwarded.sock");
    let proxy = UnixListener::bind(&forwarded).unwrap();
    let proxy_stream = UnixStream::connect(&forwarded).unwrap();
    assert!(!peer_matches_local_endpoint(
        &proxy_stream,
        &forwarded,
        &path
    ));
    let redirected = dir.join("redirected.sock");
    std::os::unix::fs::symlink(&forwarded, &redirected).unwrap();
    assert!(!peer_matches_local_endpoint(
        &proxy_stream,
        &redirected,
        &redirected
    ));
    let alias = root.join("alias");
    std::os::unix::fs::symlink(&dir, &alias).unwrap();
    let alias_socket = alias.join("herdr-client.sock");
    let alias_stream = UnixStream::connect(&alias_socket).unwrap();
    assert!(peer_matches_local_endpoint(
        &alias_stream,
        &alias_socket,
        &path
    ));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o622)).unwrap();
    assert!(!peer_matches_local_endpoint(&stream, &path, &path));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(!peer_matches_local_endpoint(&stream, &path, &path));
    drop(proxy);
    drop(listener);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn attach_only_and_cancelled_do_not_launch() {
    let path = socket();
    for (cancelled, auto_start, kind) in [
        (false, false, io::ErrorKind::NotFound),
        (true, true, io::ErrorKind::Interrupted),
    ] {
        let error = connect_or_start(
            &path,
            &AtomicBool::new(cancelled),
            Duration::ZERO,
            || panic!("must not launch"),
            auto_start,
        )
        .unwrap_err();
        assert_eq!(error.kind(), kind);
        assert!(!is_missing_installation(&error));
    }
}

#[test]
fn explicit_and_remote_targets_never_start_local_daemon() {
    for target in [
        ConnectTarget::Socket(socket()),
        ConnectTarget::Ssh {
            target: "unused".into(),
            session: "default".into(),
        },
    ] {
        let _ = connect(&target, &AtomicBool::new(false), || {
            panic!("attach-only targets must not launch a local daemon")
        });
    }
}

#[test]
fn cancellation_during_command_preparation_does_not_spawn() {
    let stop = AtomicBool::new(false);
    let error = connect_or_start(
        &socket(),
        &stop,
        Duration::from_secs(1),
        || {
            stop.store(true, Ordering::Release);
            Command::new("/nonexistent/must-not-spawn")
        },
        true,
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Interrupted);
}

#[test]
fn missing_executable_is_actionable() {
    let error = connect_or_start(
        &socket(),
        &AtomicBool::new(false),
        Duration::ZERO,
        || Command::new("/nonexistent/herdr-gpui-test"),
        true,
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert!(is_missing_installation(&error));
    assert!(error.to_string().contains("Could not start herdr server"));
    assert!(
        error
            .get_ref()
            .and_then(|source| source.source())
            .and_then(|source| source.downcast_ref::<io::Error>())
            .is_some_and(|source| source.kind() == io::ErrorKind::NotFound)
    );
}

#[test]
fn starts_and_connects_to_socket() {
    let path = socket();
    let mut listener = None;
    let stream = connect_or_start(
        &path,
        &AtomicBool::new(false),
        Duration::from_secs(1),
        || {
            listener = Some(UnixListener::bind(&path).unwrap());
            Command::new("/usr/bin/true")
        },
        true,
    )
    .unwrap();
    drop(stream);
    drop(listener);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn startup_wait_is_bounded() {
    let error = connect_or_start(
        &socket(),
        &AtomicBool::new(false),
        Duration::ZERO,
        || Command::new("/usr/bin/true"),
        true,
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
}
