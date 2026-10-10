use super::*;
use std::{
    cell::RefCell,
    env,
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn deletion_rejects_default_and_invalid_names_before_spawning() {
    let missing = Path::new("/no-such-session-test-executable");
    assert!(matches!(
        delete_local_session(missing, "default"),
        Err(Error::DefaultSession)
    ));
    for name in [
        "",
        ".",
        "..",
        "../work",
        "work space",
        "x;exit",
        &"a".repeat(65),
    ] {
        assert!(
            matches!(
                delete_local_session(missing, name),
                Err(Error::InvalidSession)
            ),
            "{name}"
        );
    }
    let error = delete_local_session(missing, "work").unwrap_err();
    assert!(matches!(error, Error::Io(_)));
    assert!(std::error::Error::source(&error).is_some());
    assert!(matches!(
        delete_remote_session("-oProxyCommand=bad", "work"),
        Err(Error::InvalidSshTarget)
    ));
}

#[cfg(unix)]
#[test]
fn deletion_reports_exit_status_and_times_out_without_a_daemon() {
    let command = |script: &str| {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    };
    assert!(delete_command(command("exit 0"), Duration::from_secs(1)).is_ok());
    assert!(
        matches!(delete_command(command("exit 17"), Duration::from_secs(1)),
        Err(Error::SessionDeleteFailed(status)) if status.code() == Some(17))
    );
    // exec keeps the sleeping process the exact child the runner owns.
    assert!(matches!(
        delete_command(command("exec sleep 30"), Duration::ZERO),
        Err(Error::SessionDeleteTimeout)
    ));
}

#[test]
fn confirmed_deletion_orders_stop_before_delete_and_aborts_uncertain_stops() {
    let calls = RefCell::new(Vec::new());
    stop_then_delete(
        || {
            calls.borrow_mut().push("stop");
            Ok(())
        },
        || {
            calls.borrow_mut().push("delete");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(*calls.borrow(), ["stop", "delete"]);
    assert!(matches!(
        stop_then_delete(
            || Err(Error::SessionDeleteTimeout),
            || panic!("a timed-out stop must not continue"),
        ),
        Err(Error::SessionDeleteTimeout)
    ));
    let error = stop_then_delete(
        || Err(Error::Io(io::Error::from(io::ErrorKind::PermissionDenied))),
        || panic!("a failed spawn must not continue"),
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(std::error::Error::source(&error).is_some());
}

#[cfg(unix)]
#[test]
fn an_already_stopped_session_can_be_deleted_but_a_live_one_is_still_refused() {
    use std::os::unix::process::ExitStatusExt;
    let refused = || Error::SessionDeleteFailed(std::process::ExitStatus::from_raw(256));
    assert!(stop_then_delete(|| Err(refused()), || Ok(())).is_ok());
    assert!(matches!(
        stop_then_delete(|| Err(refused()), || Err(refused())),
        Err(Error::SessionDeleteFailed(_))
    ));
}

#[cfg(unix)]
#[test]
fn remote_delete_is_noninteractive_and_never_retries_a_mutation() {
    let script = delete_script("--json");
    assert!(script.contains("exec \"$path\" session delete --json -- '--json'"));
    assert!(script.contains("session list --json >/dev/null 2>&1 || continue"));
    let command = script_command("host", &script).unwrap();
    assert!(command.get_args().any(|arg| arg == "BatchMode=yes"));
    assert!(script.contains("session stop --json -- '--json' >/dev/null 2>&1"));
    assert!(script.find("session stop").unwrap() < script.find("session delete").unwrap());
}

/// A private configuration directory; its build is idempotent so one test can
/// add entries to it after the first assertion.
fn fixture() -> PathBuf {
    let root = env::temp_dir().join(format!(
        "herdr-sessions-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(root.join("sessions")).unwrap();
    fs::write(root.join("config.toml"), "version = 1").unwrap();
    root
}

/// A root for the tests that bind a socket. The temporary directory on macOS
/// is already half of `sun_path`, so this one is built short and under `/tmp`:
/// a session socket is `sessions/<name>/herdr-client.sock` longer than it.
#[cfg(unix)]
fn socket_fixture() -> PathBuf {
    let root = Path::new("/tmp").join(format!(
        "hd-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    // A run that panicked leaves its socket behind, and bind would refuse it.
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("sessions")).unwrap();
    root
}

fn names_of(sessions: &[LocalSession]) -> Vec<&str> {
    sessions.iter().map(|s| s.name.as_str()).collect()
}

#[test]
fn only_real_directories_are_listed_in_order() {
    let root = fixture();
    for name in ["work", "gami9", "projects"] {
        fs::create_dir(root.join("sessions").join(name)).unwrap();
    }
    // A session directory without a socket is still a session: it is stopped.
    fs::write(root.join("sessions/notes.txt"), "not a session").unwrap();
    fs::create_dir(root.join("sessions/bad name")).unwrap();
    // Dots are legal in a session name (`work.1`), so a dot directory counts.
    fs::create_dir(root.join("sessions/.hidden")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("work"), root.join("sessions/linked")).unwrap();

    let probed = RefCell::new(Vec::new());
    let sessions = list_with(&root, |socket| {
        probed.borrow_mut().push(socket.to_owned());
        socket.ends_with("sessions/work/herdr-client.sock")
    })
    .unwrap();
    assert_eq!(
        names_of(&sessions),
        ["default", ".hidden", "gami9", "projects", "work"]
    );
    assert_eq!(
        probed.into_inner(),
        ["default", ".hidden", "gami9", "projects", "work"]
            .map(|name| session_socket(&root, name).unwrap())
    );
    assert_eq!(sessions[0].state, SessionState::Stopped);
    assert_eq!(sessions[4].state, SessionState::Running);
    assert!(SessionState::Running.running() && !SessionState::Stopped.running());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_single_session_installation_lists_only_the_root() {
    let root = env::temp_dir().join(format!(
        "herdr-sessions-bare-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&root).unwrap();
    let sessions = list_with(&root, |_| false).unwrap();
    assert_eq!(names_of(&sessions), ["default"]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn excessive_session_counts_are_refused_rather_than_truncated() {
    let root = fixture();
    // `default` is one of the sessions, so the cap counts it too.
    for index in 1..LIMIT {
        fs::create_dir(root.join("sessions").join(format!("session{index}"))).unwrap();
    }
    assert_eq!(list_with(&root, |_| false).unwrap().len(), LIMIT);
    fs::create_dir(root.join("sessions").join("one-too-many")).unwrap();
    assert!(matches!(
        list_with(&root, |_| false),
        Err(Error::SessionLimit)
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unreadable_session_roots_report_the_path_they_failed_on() {
    let root = fixture();
    fs::remove_dir_all(root.join("sessions")).unwrap();
    fs::write(root.join("sessions"), "not a directory").unwrap();
    let error = list_with(&root, |_| false).unwrap_err();
    assert!(matches!(
        error,
        Error::Storage {
            operation: crate::StorageOperation::Read,
            ref path,
            ..
        } if path == &root.join("sessions")
    ));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn default_belongs_to_the_configuration_root() {
    let root = fixture();
    let sessions = list_with(&root, |_| false).unwrap();
    assert_eq!(sessions[0].socket, root.join("herdr-client.sock"));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn state_follows_a_live_listener_not_the_socket_file() {
    let root = socket_fixture();
    let work = root.join("sessions/work");
    fs::create_dir(&work).unwrap();
    let path = work.join("herdr-client.sock");
    let listener = crate::transport::Listener::bind(&path).unwrap();
    assert!(running(&root, "work"));
    // The socket file survives the daemon, exactly as an installed one does.
    // A listener the kernel has only just closed still answers a connect for
    // an instant, so the state a surviving file implies is asserted against a
    // path no listener ever owned rather than raced against that teardown.
    drop(listener);
    assert!(path.exists());
    let stale = root.join("sessions/leftover");
    fs::create_dir(&stale).unwrap();
    fs::write(stale.join("herdr-client.sock"), "").unwrap();
    assert!(!running(&root, "leftover"));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
fn running(root: &Path, name: &str) -> bool {
    list_with(root, |socket| Stream::connect(socket).is_ok())
        .unwrap()
        .into_iter()
        .find(|session| session.name == name)
        .unwrap()
        .state
        .running()
}

/// The verified output of a real `herdr session list --json`, verbatim.
#[cfg(unix)]
const LISTING: &str = r#"{"sessions":[{"default":true,"name":"default","running":true,"session_dir":"/home/ed/.config/herdr","socket_path":"/home/ed/.config/herdr/herdr.sock"},{"default":false,"name":"gami","running":true,"session_dir":"/home/ed/.config/herdr/sessions/gami","socket_path":"/home/ed/.config/herdr/sessions/gami/herdr.sock"}]}"#;

#[cfg(unix)]
fn listed(count: usize) -> String {
    let entries: Vec<String> = (0..count)
        .map(|index| format!(r#"{{"name":"session{index}","running":true}}"#))
        .collect();
    format!(r#"{{"sessions":[{}]}}"#, entries.join(","))
}

#[cfg(unix)]
#[test]
fn a_host_listing_is_parsed_in_the_local_order() {
    assert_eq!(
        parse_session_list(LISTING.as_bytes()).unwrap(),
        [
            RemoteSession {
                name: "default".into(),
                running: true,
            },
            RemoteSession {
                name: "gami".into(),
                running: true,
            },
        ]
    );
}

#[cfg(unix)]
#[test]
fn a_host_that_omits_the_running_flag_lists_a_stopped_session() {
    assert_eq!(
        parse_session_list(r#"{"sessions":[{"name":"default"}]}"#.as_bytes()).unwrap(),
        [RemoteSession {
            name: "default".into(),
            running: false,
        }]
    );
}

#[cfg(unix)]
#[test]
fn names_this_client_cannot_attach_to_are_dropped() {
    assert_eq!(
        parse_session_list(
            r#"{"sessions":[{"name":"bad/name","running":true},{"name":".."},{"name":"work","running":true}]}"#
                .as_bytes()
        )
        .unwrap(),
        [RemoteSession {
            name: "work".into(),
            running: true,
        }]
    );
}

#[cfg(unix)]
#[test]
fn a_banner_before_the_listing_is_tolerated_and_the_last_line_wins() {
    // SSH can print a banner or motd ahead of the JSON.
    let bannered = format!("Welcome to Ubuntu\nLast login: Thu 1 Jan\n{LISTING}\n");
    assert_eq!(parse_session_list(bannered.as_bytes()).unwrap().len(), 2);
    // Two listings on one connection: the later one is the host's answer.
    let twice = format!(
        r#"{{"sessions":[{{"name":"stale","running":true}}]}}
{LISTING}"#
    );
    assert_eq!(parse_session_list(twice.as_bytes()).unwrap().len(), 2);
}

#[cfg(unix)]
#[test]
fn output_that_is_not_a_listing_is_a_failure_not_an_empty_listing() {
    assert!(matches!(
        parse_session_list(b"not json\n"),
        Err(Error::Json(_))
    ));
    assert!(matches!(
        parse_session_list(r#"{"sessions":"unexpected"}"#.as_bytes()),
        Err(Error::Json(_))
    ));
}

#[cfg(unix)]
/// A channel that prints what it was given and then goes quiet without ever
/// closing, the way a host that answered leaves one.
struct Answered(std::collections::VecDeque<u8>);

#[cfg(unix)]
impl Read for Answered {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.0.is_empty() {
            return Err(io::Error::from(io::ErrorKind::WouldBlock));
        }
        let take = buffer.len().min(self.0.len());
        let chunk: Vec<u8> = (0..take).filter_map(|_| self.0.pop_front()).collect();
        buffer[..take].copy_from_slice(&chunk);
        Ok(take)
    }
}

#[cfg(unix)]
#[test]
fn a_host_that_answered_is_read_without_waiting_for_the_channel_to_close() {
    let listing = br#"{"sessions":[{"name":"default","running":true}]}"#;
    let mut stream = Answered(listing.iter().copied().collect());
    let started = Instant::now();
    let output = match read_listing(&mut stream, Duration::from_secs(30), || false) {
        Ok(output) => output,
        Err(error) => panic!("this host answered, so it must not fail: {error}"),
    };
    assert_eq!(output, listing);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the read waited for an EOF this host never sends"
    );
}

#[cfg(unix)]
#[test]
fn a_child_that_finished_ends_the_read_instead_of_the_deadline() {
    // A host with no usable Herdr prints nothing and exits, which is a failure
    // worth reporting at once rather than a fifteen-second timeout.
    let mut silent = Answered(std::collections::VecDeque::new());
    let started = Instant::now();
    match read_listing(&mut silent, Duration::from_secs(30), || true) {
        Ok(output) => assert!(output.is_empty()),
        Err(error) => panic!("this child is gone, so it must not be waited on: {error}"),
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    // Whatever it did print is kept, so the parser can still report on it.
    let mut banner = Answered(b"host: no herdr here\n".iter().copied().collect());
    match read_listing(&mut banner, Duration::from_secs(30), || true) {
        Ok(output) => assert_eq!(output, b"host: no herdr here\n"),
        Err(error) => panic!("this child is gone, so it must not be waited on: {error}"),
    }
}

#[cfg(unix)]
#[test]
fn a_channel_that_never_prints_a_listing_still_times_out() {
    let mut stream = Answered(std::collections::VecDeque::new());
    assert!(matches!(
        read_listing(&mut stream, Duration::from_millis(20), || false),
        Err(Error::SshTimeout)
    ));
}

#[cfg(unix)]
#[test]
fn a_complete_listing_ends_the_read_before_any_eof() {
    // The command that prints a listing leaves a process holding the SSH
    // session open, so an answer must not be waited for until EOF: doing that
    // reported a host answering in a second as a fifteen-second timeout.
    assert!(listed_sessions(br#"{"sessions":[]}"#));
    assert!(listed_sessions(
        b"motd: welcome\n{\"sessions\":[{\"name\":\"default\",\"running\":true}]}\n"
    ));
    // A line that is still arriving is not an answer, so the deadline stands.
    assert!(!listed_sessions(b"{\"sessions\":[{\"name\":\"def"));
    assert!(!listed_sessions(b"motd: welcome\n"));
    assert!(!listed_sessions(b""));
}

#[cfg(unix)]
#[test]
fn a_host_that_prints_nothing_is_a_closed_bridge() {
    assert!(matches!(parse_session_list(b""), Err(Error::SshClosed)));
}

#[cfg(unix)]
#[test]
fn an_excessive_remote_listing_is_refused_rather_than_truncated() {
    assert_eq!(
        parse_session_list(listed(LIMIT).as_bytes()).unwrap().len(),
        LIMIT
    );
    assert!(matches!(
        parse_session_list(listed(LIMIT + 1).as_bytes()),
        Err(Error::SessionLimit)
    ));
}

#[cfg(unix)]
#[test]
fn the_remote_listing_walks_the_shared_candidate_roots() {
    // Asserted on the script and on the SSH child's arguments, never by faking
    // an `ssh` binary on PATH.
    let script = session_list_script();
    assert!(
        script.contains(r#""$path" session list --json"#),
        "{script}"
    );
    assert!(script.contains("command -v herdr"), "{script}");
    // The candidate that answers ends the probe, with a zero status.
    assert!(script.contains("exit 0"), "{script}");
    assert!(script.starts_with(CANDIDATES), "{script}");
    let command = script_command("host", &script).unwrap();
    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_str().unwrap())
        .collect();
    let wrapped = format!("/bin/sh -c {}", crate::ssh::quote(&script));
    assert_eq!(args.last(), Some(&wrapped.as_str()));
    assert!(args.contains(&"BatchMode=yes"));
    // A malformed target is rejected before anything is built or spawned.
    assert!(matches!(
        list_remote_sessions("-oProxyCommand=bad"),
        Err(Error::InvalidSshTarget)
    ));
}
