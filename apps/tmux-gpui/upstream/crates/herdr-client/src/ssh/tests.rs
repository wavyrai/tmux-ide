use super::*;

mod command;
mod forward;
mod incompatible;

#[test]
fn discovery_and_bridge_stdio_work_with_quoted_install_paths() {
    let root =
        std::env::temp_dir().join(format!("herdr-client-{}-quoted ' path", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let binary = root.join("herdr");
    crate::test_executable::write(&binary, r#"#!/bin/sh
if [ "$1" = status ]; then
    printf '%s\n' '{"endpoint_protocol_generation":1,"endpoint_capabilities":["surface_interest","presentation_effects_fence","health_check"],"remote_bridge_idle_timeout":true}'
    exit 0
fi
[ "$1" = --session ] && [ "$2" = agents ] && [ "$3" = remote-client-bridge ] && [ "$4" = --idle-timeout-v1 ] || exit 1
IFS= read -r hello || exit 1
printf '%s\n' "$hello"
"#, 0o700).unwrap();
    let (mut stream, child_stream) = Stream::pair().unwrap();
    stream.set_read_timeout(Some(POLL)).unwrap();
    let child = ChildGuard(
        Command::new("/bin/sh")
            .args(["-c", &bridge_command("agents")])
            .env("PATH", &root)
            .env("HOME", &root)
            .stdin(Stdio::from(OwnedFd::from(
                child_stream.try_clone().unwrap(),
            )))
            .stdout(Stdio::from(OwnedFd::from(child_stream)))
            .spawn()
            .unwrap(),
    );
    let status = await_ready(&mut stream, &AtomicBool::new(false), Instant::now()).unwrap();
    assert_eq!(compatible_status(&status), Some(true));
    stream.write_all(b"accept-idle\nhello\n").unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut response = [0; 6];
    stream.read_exact(&mut response).unwrap();
    assert_eq!(&response, b"hello\n");
    drop(child);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn probe_classifies_only_finished_output() {
    let client = r#"{"endpoint_protocol_generation":1,"endpoint_capabilities":["surface_interest","presentation_effects_fence","health_check"]}"#;
    let old = r#"{"endpoint_protocol_generation":0,"endpoint_capabilities":[]}"#;
    let running = r#"{"running":true,"version":"1"}"#;
    let stopped = r#"{"running":false}"#;
    let probe = |blocks: &[(&str, &str)], done: bool| {
        let mut output = String::from("motd banner\n");
        for (client, server) in blocks {
            output += &format!("{PROBE_CANDIDATE}\n{client}\n{server}\n");
        }
        if done {
            output += PROBE_DONE;
            output += "\n";
        }
        classify_probe(output.as_bytes())
    };
    assert_eq!(probe(&[], true), Some(HostProbe::Missing));
    assert_eq!(probe(&[(old, running)], true), Some(HostProbe::Outdated));
    assert_eq!(probe(&[(client, stopped)], true), Some(HostProbe::Stopped));
    // A failed server status leaves an empty line, which is not running.
    assert_eq!(probe(&[(client, "")], true), Some(HostProbe::Stopped));
    // The first compatible copy decides, as it does for the bridge.
    assert_eq!(
        probe(&[(old, running), (client, running)], true),
        Some(HostProbe::Running)
    );
    assert_eq!(probe(&[(client, running)], false), None);
    // A running old server does not make a compatible copy look running.
    assert_eq!(
        probe(&[(old, running), (client, stopped)], true),
        Some(HostProbe::Stopped)
    );
}

#[test]
fn probe_script_reports_the_session_server_without_starting_it() {
    let root = std::env::temp_dir().join(format!("herdr-probe-{}-a ' b", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let binary = root.join("herdr");
    crate::test_executable::write(&binary, r#"#!/bin/sh
case "$*" in
    "status client --json") printf '%s\n' '{"endpoint_protocol_generation":1,"endpoint_capabilities":["surface_interest","presentation_effects_fence","health_check"]}';;
    "--session work's status server --json") [ -e "$HOME/up" ] && printf '%s\n' '{"running":true}' || printf '%s\n' '{"running":false}';;
    *) exit 1;;
esac
"#, 0o700).unwrap();
    let run = || {
        let output = Command::new("/bin/sh")
            .args(["-c", &probe_command("work's")])
            .env("PATH", &root)
            .env("HOME", &root)
            .output()
            .unwrap();
        classify_probe(&output.stdout)
    };
    assert_eq!(run(), Some(HostProbe::Stopped));
    std::fs::write(root.join("up"), "").unwrap();
    assert_eq!(run(), Some(HostProbe::Running));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn origin_command_reads_only_the_named_repository() {
    let root = std::env::temp_dir().join(format!("herdr-origin-{}-a ' $(b)", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    };
    git(&["init", "-q"]);
    let git_dir = root.join(".git");
    let run = || {
        Command::new("/bin/sh")
            .args([
                "-c",
                &config_command(git_dir.to_str().unwrap(), "remote.origin.url"),
            ])
            .output()
            .unwrap()
    };
    // No origin: `git config --get` exits 1, which callers read as none.
    assert_eq!(run().status.code(), Some(1));
    git(&["remote", "add", "origin", "git@github.com:owner/repo.git"]);
    let output = run();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"git@github.com:owner/repo.git\n");
    // Both the repository path and branch-derived key are shell quoted.
    let key = "branch.pr/'$(false).merge";
    git(&["config", key, "refs/heads/feat/inline-ime-preedit"]);
    let output = Command::new("/bin/sh")
        .args(["-c", &config_command(git_dir.to_str().unwrap(), key)])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"refs/heads/feat/inline-ime-preedit\n");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn origin_lookup_rejects_relative_or_control_git_dirs_before_ssh() {
    for dir in ["relative/.git", "/repo\n/.git", ""] {
        assert!(matches!(
            remote_origin_url("host", dir, Duration::from_secs(1), || false),
            Err(Error::InvalidGitDir)
        ));
    }
    assert!(matches!(
        remote_origin_url(
            "-oProxyCommand=x",
            "/repo/.git",
            Duration::from_secs(1),
            || false
        ),
        Err(Error::InvalidSshTarget)
    ));
}

#[test]
fn destinations_come_from_the_resolved_config_not_the_spelling() {
    let parsed =
        parse_destination(b"user penso\nhostname M5Max.Local\nport 2222\nhostkeyalias none\n")
            .unwrap();
    assert_eq!(
        parsed,
        Destination {
            user: "penso".into(),
            host: "m5max.local".into(),
            port: 2222
        }
    );
    // `hostkeyalias` must not satisfy the `hostname` key.
    assert_eq!(parse_destination(b"user a\nhostnamex b\nport 22\n"), None);
    assert_eq!(parse_destination(b"user a\nhostname b\nport x\n"), None);
    // Spellings of one host agree through the real `ssh -G`.
    let a = resolve_destination("penso@example.invalid").unwrap();
    let b = resolve_destination("ssh://penso@EXAMPLE.invalid:22").unwrap();
    assert_eq!(a, b);
    assert!(matches!(
        resolve_destination("-oProxyCommand=x"),
        Err(Error::InvalidSshTarget)
    ));
}

#[test]
fn probe_rejects_bad_targets_before_spawning_ssh() {
    assert!(matches!(
        probe_host("-oProxyCommand=x", "default"),
        Err(Error::InvalidSshTarget)
    ));
    assert!(matches!(
        probe_host("host", "../escape"),
        Err(Error::InvalidSession)
    ));
}

#[test]
fn command_is_noninteractive_and_target_is_one_argument() {
    let command = command("user@host;not-a-command", "agents");
    let args: Vec<_> = command.get_args().map(|a| a.to_str().unwrap()).collect();
    for option in [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ControlMaster=no",
    ] {
        assert!(args.contains(&option));
    }
    // The user's SSH config decides agent forwarding and which master to share.
    assert!(
        !args
            .iter()
            .any(|arg| arg.starts_with("ForwardAgent=") || arg.starts_with("ControlPath="))
    );
    assert_eq!(args[args.len() - 3], "--");
    assert_eq!(args[args.len() - 2], "user@host;not-a-command");
    assert_eq!(quote("a'b"), "'a'\\''b'");
    for bad in [
        "",
        "-oProxyCommand=bad",
        "host\ncommand",
        "user:secret@host",
    ] {
        assert!(validate_target(bad).is_err());
    }
}
#[test]
fn script_runs_under_remote_sh_and_rejects_option_targets() {
    let command = script_command("user@host", "echo 'hi'").unwrap();
    let args: Vec<_> = command.get_args().map(|a| a.to_str().unwrap()).collect();
    assert_eq!(args[args.len() - 3], "--");
    assert_eq!(args[args.len() - 2], "user@host");
    assert_eq!(args[args.len() - 1], "/bin/sh -c 'echo '\\''hi'\\'''");
    assert!(matches!(
        script_command("-oProxyCommand=bad", "true"),
        Err(Error::InvalidSshTarget)
    ));
}
#[test]
fn marker_consumes_banners_not_protocol_bytes() {
    let (mut stream, mut remote) = Stream::pair().unwrap();
    remote
        .write_all(b"banner\n\nherdr-remote-output-ready:1\nWIRE")
        .unwrap();
    await_ready(&mut stream, &AtomicBool::new(false), Instant::now()).unwrap();
    let mut bytes = [0; 4];
    stream.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"WIRE");
    assert!(await_ready(&mut stream, &AtomicBool::new(true), Instant::now()).is_err());
}
#[test]
fn child_guard_reaps_on_drop() {
    let child = Command::new("sleep").arg("60").spawn().unwrap();
    let id = child.id();
    drop(ChildGuard(child));
    assert!(
        !Command::new("kill")
            .args(["-0", &id.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}
#[test]
fn discovery_checks_binary_capabilities_before_starting_bridge() {
    let mut status = serde_json::json!({"endpoint_protocol_generation":1,"endpoint_capabilities":["surface_interest","presentation_effects_fence","health_check"],"remote_bridge_idle_timeout":true});
    assert_eq!(compatible_status(status.to_string().as_bytes()), Some(true));
    status["endpoint_capabilities"] = serde_json::json!(["surface_interest", "health_check"]);
    assert_eq!(compatible_status(status.to_string().as_bytes()), None);
    assert_eq!(compatible_status(b"banner\n{\"wrapper\":true}\n"), None);
}

/// Yields each scripted result once, so a retryable error and a short read
/// are exercised without a socket or a timing guess.
struct ScriptedReader(std::collections::VecDeque<io::Result<Vec<u8>>>);

impl Read for ScriptedReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.0.pop_front() {
            Some(Ok(bytes)) => {
                let len = bytes.len().min(buf.len());
                buf[..len].copy_from_slice(&bytes[..len]);
                Ok(len)
            }
            Some(Err(error)) => Err(error),
            None => Ok(0),
        }
    }
}

fn scripted(chunks: Vec<io::Result<Vec<u8>>>) -> ScriptedReader {
    ScriptedReader(chunks.into())
}

fn bytes(text: &[u8]) -> Vec<io::Result<Vec<u8>>> {
    text.iter().map(|byte| Ok(vec![*byte])).collect()
}

#[test]
fn ready_line_ends_the_banner_and_returns_what_preceded_it() {
    let mut stream = scripted(
        bytes(b"one\ntwo\n")
            .into_iter()
            .chain(bytes(READY))
            .collect(),
    );
    let output = await_ready(&mut stream, &AtomicBool::new(false), Instant::now()).unwrap();
    assert_eq!(output, b"one\ntwo\n");
}

#[test]
fn banner_output_is_bounded_and_a_closed_stream_is_reported() {
    let mut flood = scripted(bytes(&b"x".repeat(16385)));
    assert!(matches!(
        await_ready(&mut flood, &AtomicBool::new(false), Instant::now()),
        Err(Error::SshOutputLimit)
    ));
    // An exhausted script reads zero bytes, as a closed pipe does.
    let mut closed = scripted(bytes(b"partial\n"));
    assert!(matches!(
        await_ready(&mut closed, &AtomicBool::new(false), Instant::now()),
        Err(Error::SshClosed)
    ));
}

#[test]
fn cancellation_and_deadline_are_checked_before_reading() {
    let stop = AtomicBool::new(true);
    let mut never_read = scripted(vec![Err(io::Error::other("must not be read"))]);
    assert!(matches!(
        await_ready(&mut never_read, &stop, Instant::now()),
        Err(Error::SshCancelled)
    ));
    let expired = Instant::now() - Duration::from_secs(16);
    let mut also_never_read = scripted(vec![Err(io::Error::other("must not be read"))]);
    assert!(matches!(
        await_ready(&mut also_never_read, &AtomicBool::new(false), expired),
        Err(Error::SshTimeout)
    ));
}

#[test]
fn retryable_read_errors_do_not_end_the_banner() {
    let mut stream = scripted(
        [
            io::ErrorKind::WouldBlock,
            io::ErrorKind::TimedOut,
            io::ErrorKind::Interrupted,
        ]
        .into_iter()
        .map(|kind| Err(io::Error::from(kind)))
        .chain(bytes(READY))
        .collect(),
    );
    assert_eq!(
        await_ready(&mut stream, &AtomicBool::new(false), Instant::now()).unwrap(),
        Vec::<u8>::new()
    );
    let mut fatal = scripted(vec![Err(io::Error::other("broken pipe"))]);
    assert!(matches!(
        await_ready(&mut fatal, &AtomicBool::new(false), Instant::now()),
        Err(Error::Io(_))
    ));
}
