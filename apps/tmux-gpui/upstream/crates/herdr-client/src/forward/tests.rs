use super::*;
use std::ffi::OsStr;

const WAIT: Duration = Duration::from_secs(10);

fn port(port: u16) -> NonZeroU16 {
    NonZeroU16::new(port).unwrap()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("herdr-forward-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir(&dir).unwrap();
    dir
}

/// A stand-in master: records its pid and control socket, opens the
/// socket (an ordinary file is enough for readiness), and waits.
fn master(dir: &Path) -> impl FnOnce(&Path) -> Command + Send + 'static {
    let dir = dir.to_owned();
    move |socket| {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                r#"echo $$ > "$1/pid"; echo "$2" > "$1/socket"; : > "$2"; exec sleep 30"#,
                "master",
            ])
            .arg(&dir)
            .arg(socket);
        command
    }
}

/// A stand-in `ssh -O forward` that logs the port it was asked for and
/// grants every port but `refuse`.
fn grant(dir: &Path, refuse: u16) -> impl Fn(&Path, u16) -> Command + Send + 'static {
    let dir = dir.to_owned();
    move |_, local_port| {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                r#"echo "$2" >> "$1/asked"; test "$2" != "$3""#,
                "forward",
            ])
            .arg(&dir)
            .arg(local_port.to_string())
            .arg(refuse.to_string());
        command
    }
}

fn next_event(forward: &PortForward) -> ForwardEvent {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(event) = forward.try_event() {
            return event;
        }
        assert!(Instant::now() < deadline, "no event from the forward");
        thread::sleep(Duration::from_millis(10));
    }
}

fn read(file: &Path) -> String {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Ok(text) = std::fs::read_to_string(file)
            && text.ends_with('\n')
        {
            return text;
        }
        assert!(
            Instant::now() < deadline,
            "{} never written",
            file.display()
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn running(pid: &str) -> bool {
    Command::new("/bin/kill")
        .args(["-0", pid.trim()])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

fn wait_until(mut done: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn privileged_ports_move_up_and_others_keep_their_number() {
    assert_eq!(preferred_local_port(port(80)), 10080);
    assert_eq!(preferred_local_port(port(1023)), 11023);
    assert_eq!(preferred_local_port(port(1024)), 1024);
    assert_eq!(preferred_local_port(port(3000)), 3000);
    assert_eq!(preferred_local_port(port(u16::MAX)), u16::MAX);
}

#[test]
fn the_master_is_private_to_the_forward_and_the_request_binds_loopback_only() {
    let socket = Path::new("/tmp/herdr-fwd-1-1/c%h");
    let master = master_command("penso@box", socket);
    assert_eq!(master.get_program(), "ssh");
    let args: Vec<&OsStr> = master.get_args().collect();
    assert_eq!(args[0], "-N");
    for option in [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ControlMaster=yes",
        "ControlPersist=no",
        "ExitOnForwardFailure=no",
        // A literal `%` is not an SSH token.
        "ControlPath=/tmp/herdr-fwd-1-1/c%%h",
    ] {
        assert!(args.contains(&OsStr::new(option)), "{option}");
    }
    // The master forwards nothing until asked, and it would clear the
    // requested forward along with the config's.
    assert!(!args.contains(&OsStr::new("-L")));
    assert!(!args.contains(&OsStr::new("ClearAllForwardings=yes")));
    assert_eq!(&args[args.len() - 2..], ["--", "penso@box"]);

    let request = forward_command("penso@box", socket, 13000, 3000);
    let args: Vec<&OsStr> = request.get_args().collect();
    assert!(args.contains(&OsStr::new("ControlPath=/tmp/herdr-fwd-1-1/c%%h")));
    let at = args.iter().position(|arg| *arg == "-O").unwrap();
    assert_eq!(args[at + 1], "forward");
    assert_eq!(args[at + 2], "-L");
    assert_eq!(args[at + 3], "127.0.0.1:13000:localhost:3000");
    assert_eq!(&args[args.len() - 2..], ["--", "penso@box"]);
}

#[test]
fn a_long_temporary_directory_falls_back_to_tmp_for_the_socket() {
    // The shape of a macOS per-user temporary directory.
    let short = Path::new("/var/folders/ab/0123456789abcdefghijklmnopqrst/T");
    let name = "herdr-fwd-98765-3";
    assert_eq!(ControlDir::place(short, name), short.join(name));
    let long = PathBuf::from(format!("/Users/someone/{}", "deep/".repeat(12)));
    assert_eq!(ControlDir::place(&long, name), Path::new("/tmp").join(name));
}

#[test]
fn option_like_targets_are_refused_before_anything_runs() {
    assert!(matches!(
        PortForward::start("-oProxyCommand=x", port(3000)),
        Err(Error::InvalidSshTarget)
    ));
}

/// Listening means the master granted the port. Stopping kills the
/// master, and its private control directory goes with it.
#[test]
fn a_granted_port_is_listening_and_stop_kills_the_master() {
    let dir = scratch("granted");
    let forward = PortForward::start_with(port(3000), WAIT, master(&dir), grant(&dir, 0)).unwrap();
    assert!(matches!(
        next_event(&forward),
        ForwardEvent::Listening { local_port: 3000 }
    ));
    assert_eq!(read(&dir.join("asked")), "3000\n");
    let pid = read(&dir.join("pid"));
    let socket = PathBuf::from(read(&dir.join("socket")).trim_end());
    let control = socket.parent().unwrap().to_owned();
    assert!(control.starts_with(std::env::temp_dir()));
    assert!(running(&pid));
    drop(forward);
    wait_until(|| !running(&pid), "the master outlived its forward");
    wait_until(
        || !control.exists(),
        "the control directory was left behind",
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// The preferred port held by another process is refused by the master,
/// so the forward moves to another port instead of reporting a listener
/// that is not its own.
#[test]
fn a_port_taken_by_another_process_is_never_reported_as_the_forward() {
    let dir = scratch("taken");
    let forward =
        PortForward::start_with(port(3000), WAIT, master(&dir), grant(&dir, 3000)).unwrap();
    let ForwardEvent::Listening { local_port } = next_event(&forward) else {
        panic!("expected Listening");
    };
    assert_ne!(local_port, 3000);
    assert_eq!(read(&dir.join("asked")), format!("3000\n{local_port}\n"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_master_refusing_every_port_ends_the_forward() {
    let dir = scratch("refused");
    let forward = PortForward::start_with(port(3000), WAIT, master(&dir), |_, _| {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 255"]);
        command
    })
    .unwrap();
    let ForwardEvent::Ended(Error::ForwardRefused(status)) = next_event(&forward) else {
        panic!("expected ForwardRefused");
    };
    assert_eq!(status.code(), Some(255));
    let pid = read(&dir.join("pid"));
    wait_until(|| !running(&pid), "a refused forward kept its master");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_master_that_exits_ends_the_forward_without_a_retry() {
    let dir = scratch("exit");
    let count = dir.join("count");
    let script = format!("echo run >> '{}'; exit 255", count.display());
    let forward = PortForward::start_with(
        port(3000),
        WAIT,
        move |_| {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", &script]);
            command
        },
        |_, _| unreachable!("no master to ask"),
    )
    .unwrap();
    let ForwardEvent::Ended(Error::ForwardExit(status)) = next_event(&forward) else {
        panic!("expected ForwardExit");
    };
    assert_eq!(status.code(), Some(255));
    thread::sleep(Duration::from_millis(200));
    assert!(forward.try_event().is_none());
    assert_eq!(std::fs::read_to_string(&count).unwrap(), "run\n");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_master_that_never_connects_times_out_and_is_killed() {
    let dir = scratch("timeout");
    let pid_file = dir.join("pid");
    let script = format!("echo $$ > '{}'; exec sleep 30", pid_file.display());
    let forward = PortForward::start_with(
        port(3000),
        Duration::from_millis(300),
        move |_| {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", &script]);
            command
        },
        |_, _| unreachable!("the master never opened its socket"),
    )
    .unwrap();
    assert!(matches!(
        next_event(&forward),
        ForwardEvent::Ended(Error::ForwardTimeout)
    ));
    let pid = read(&pid_file);
    wait_until(|| !running(&pid), "a timed-out master was left running");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_master_that_cannot_start_ends_the_forward_with_its_cause() {
    let forward = PortForward::start_with(
        port(3000),
        WAIT,
        |_| Command::new("/nonexistent/herdr-test-ssh"),
        |_, _| unreachable!(),
    )
    .unwrap();
    let ForwardEvent::Ended(error) = next_event(&forward) else {
        panic!("expected Ended");
    };
    assert!(matches!(error, Error::ForwardSpawn(_)));
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert!(std::error::Error::source(&error).is_some());
}
