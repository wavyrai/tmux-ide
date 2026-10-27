use super::*;

#[test]
fn build_info_is_an_informational_mode() {
    assert_eq!(
        LaunchOptions::parse(["--build-info"]).unwrap().mode,
        LaunchMode::BuildInfo
    );
    assert_eq!(
        build_info(),
        concat!(
            "worktree=",
            env!("HERDR_BUILD_WORKTREE"),
            "\nbranch=",
            env!("HERDR_BUILD_BRANCH"),
            "\npr=",
            env!("HERDR_BUILD_PR"),
            "\n"
        )
    );
}

#[test]
fn browser_commands_never_start_the_gui() {
    let mode = |args: &[&str]| LaunchOptions::parse(args.iter().copied()).map(|o| o.mode);
    assert_eq!(
        mode(&["browser", "open", "localhost:3000"]).unwrap(),
        LaunchMode::Browser(BrowserCommand::Open {
            target: "localhost:3000".into(),
            workspace: None,
            focus: true,
        })
    );
    assert_eq!(
        mode(&[
            "browser",
            "open",
            "--no-focus",
            "--workspace",
            "w_2",
            "https://a.test"
        ])
        .unwrap(),
        LaunchMode::Browser(BrowserCommand::Open {
            target: "https://a.test".into(),
            workspace: Some("w_2".into()),
            focus: false,
        })
    );
    assert_eq!(
        mode(&["browser", "skill"]).unwrap(),
        LaunchMode::Browser(BrowserCommand::Skill)
    );
    assert_eq!(
        mode(&["browser", "reload"]).unwrap(),
        LaunchMode::Browser(BrowserCommand::Reload)
    );
    assert_eq!(
        mode(&["browser", "feedback"]).unwrap(),
        LaunchMode::Browser(BrowserCommand::Feedback { wait: 0 })
    );
    assert_eq!(
        mode(&["browser", "feedback", "--wait", "300"]).unwrap(),
        LaunchMode::Browser(BrowserCommand::Feedback { wait: 300 })
    );
    for help in [&["browser", "--help"][..], &["browser", "open", "-h"]] {
        assert_eq!(
            mode(help).unwrap(),
            LaunchMode::Browser(BrowserCommand::Help)
        );
    }
    for (args, expected) in [
        (&["browser"][..], CliError::MissingBrowserCommand),
        (
            &["browser", "eval"],
            CliError::UnknownBrowserCommand("eval".into()),
        ),
        (&["browser", "open"], CliError::MissingUrl),
        (
            &["browser", "open", "--workspace"],
            CliError::MissingWorkspace,
        ),
        (
            &["browser", "open", "a", "b"],
            CliError::UnexpectedArgument("b".into()),
        ),
        (
            &["browser", "open", "--new"],
            CliError::UnexpectedArgument("--new".into()),
        ),
        (
            &["browser", "skill", "x"],
            CliError::UnexpectedArgument("x".into()),
        ),
        (
            &["browser", "reload", "x"],
            CliError::UnexpectedArgument("x".into()),
        ),
        (&["browser", "feedback", "--wait"], CliError::InvalidWait),
        (
            &["browser", "feedback", "--wait", "0"],
            CliError::InvalidWait,
        ),
        (
            &["browser", "feedback", "--wait", "soon"],
            CliError::InvalidWait,
        ),
        (
            &["browser", "feedback", "now"],
            CliError::UnexpectedArgument("now".into()),
        ),
    ] {
        assert_eq!(mode(args).unwrap_err(), expected, "{args:?}");
    }
    // Only a leading "browser" is the subcommand.
    assert_eq!(
        mode(&["--dev", "browser"]).unwrap_err(),
        CliError::UnknownOption("browser".into())
    );
}

#[cfg(unix)]
#[test]
fn browser_arguments_must_be_utf8() {
    use std::os::unix::ffi::OsStringExt;
    let invalid = OsString::from_vec(b"https://a.test/\xff".to_vec());
    let error = LaunchOptions::parse([OsString::from("browser"), "open".into(), invalid.clone()])
        .unwrap_err();
    assert_eq!(error, CliError::InvalidBrowserEncoding(invalid));
}

#[test]
fn connection_selection() {
    assert!(
        matches!(LaunchOptions::parse(["--dev"]).unwrap().target, ConnectTarget::Session { name, development: true } if name == "default")
    );
    assert!(
        matches!(LaunchOptions::parse(["--session", "test"]).unwrap().target, ConnectTarget::Session { name, development: false } if name == "test")
    );
    assert!(matches!(
        LaunchOptions::parse(std::iter::empty::<OsString>())
            .unwrap()
            .target,
        ConnectTarget::Local
    ));
}

#[test]
fn rejects_missing_and_duplicate_values() {
    for (args, expected, message) in [
        (
            vec!["--socket"],
            CliError::MissingSocketPath,
            "--socket requires a path",
        ),
        (
            vec!["--session"],
            CliError::MissingSessionName,
            "--session requires a name",
        ),
        (
            vec!["--socket", "--help"],
            CliError::MissingSocketPath,
            "--socket requires a path",
        ),
        (
            vec!["--session", "--dev"],
            CliError::MissingSessionName,
            "--session requires a name",
        ),
        (
            vec!["--socket", ""],
            CliError::MissingSocketPath,
            "--socket requires a path",
        ),
        (
            vec!["--socket", "a", "--socket", "b"],
            CliError::DuplicateSocket,
            "--socket may only be specified once",
        ),
        (
            vec!["--session", "a", "--session", "b"],
            CliError::DuplicateSession,
            "--session may only be specified once",
        ),
        (
            vec!["--socket", "a", "--dev"],
            CliError::ConflictingConnectionOptions,
            "--socket cannot be combined with --session or --dev",
        ),
        (
            vec!["--socket", "a", "--session", "b"],
            CliError::ConflictingConnectionOptions,
            "--socket cannot be combined with --session or --dev",
        ),
        (
            vec!["--unknown"],
            CliError::UnknownOption("--unknown".into()),
            "Unknown option: --unknown",
        ),
    ] {
        let error = LaunchOptions::parse(args).unwrap_err();
        assert_eq!(error, expected);
        assert_eq!(error.to_string(), message);
    }
}

// Windows paths are UTF-16 and have no byte form to round-trip here; the
// parser stays byte-agnostic on both because it never converts to `String`.
#[cfg(unix)]
#[test]
fn socket_paths_need_not_be_utf8() {
    use std::os::unix::ffi::OsStringExt;
    let path = OsString::from_vec(b"/tmp/socket-\xff".to_vec());
    let options = LaunchOptions::parse([OsString::from("--socket"), path.clone()]).unwrap();
    assert!(matches!(options.target, ConnectTarget::Socket(actual) if actual.as_os_str() == path));
    let error = LaunchOptions::parse([OsString::from("--session"), path.clone()]).unwrap_err();
    assert_eq!(error, CliError::InvalidSessionEncoding(path.clone()));
    assert_eq!(error.to_string(), "--session requires a UTF-8 name");
    let error = LaunchOptions::parse([path.clone()]).unwrap_err();
    assert_eq!(error, CliError::UnknownOption(path.clone()));
    assert_eq!(
        error.to_string(),
        format!("Unknown option: {}", path.to_string_lossy())
    );
}

#[cfg(feature = "mockup")]
#[test]
fn mockup_mode_takes_feedback_and_capture_paths() {
    let mode = |args: &[&str]| LaunchOptions::parse(args.iter().copied()).map(|o| o.mode);
    assert_eq!(
        mode(&["--mockup"]).unwrap(),
        LaunchMode::Mockup(MockupOptions::default())
    );
    assert_eq!(
        mode(&[
            "--mockup",
            "--capture",
            "/tmp/m/shot.png",
            "--feedback",
            "/tmp/m/feedback.md"
        ])
        .unwrap(),
        LaunchMode::Mockup(MockupOptions {
            feedback: Some("/tmp/m/feedback.md".into()),
            capture: Some("/tmp/m/shot.png".into()),
        })
    );
    assert_eq!(mode(&["--mockup", "-h"]).unwrap(), LaunchMode::Help);
    for (args, expected, message) in [
        (
            &["--mockup", "--feedback"][..],
            CliError::MissingMockupPath("--feedback"),
            "--feedback requires a path",
        ),
        (
            &["--mockup", "--capture", "--dev"],
            CliError::MissingMockupPath("--capture"),
            "--capture requires a path",
        ),
        (
            &["--mockup", "--feedback", "a", "--feedback", "b"],
            CliError::DuplicateMockupPath("--feedback"),
            "--feedback may only be specified once",
        ),
        (
            &["--mockup", "--capture", "a", "--capture", "b"],
            CliError::DuplicateMockupPath("--capture"),
            "--capture may only be specified once",
        ),
        (
            &["--mockup", "--dev"],
            CliError::UnknownOption("--dev".into()),
            "Unknown option: --dev",
        ),
    ] {
        let error = mode(args).unwrap_err();
        assert_eq!(error, expected, "{args:?}");
        assert_eq!(error.to_string(), message);
    }
    // Like `browser`, only a leading `--mockup` selects the mode, so it
    // can never be mixed with connection options.
    assert_eq!(
        mode(&["--dev", "--mockup"]).unwrap_err(),
        CliError::UnknownOption("--mockup".into())
    );
}

#[cfg(all(feature = "mockup", unix))]
#[test]
fn mockup_paths_need_not_be_utf8() {
    use std::os::unix::ffi::OsStringExt;
    let path = OsString::from_vec(b"/tmp/mockup-\xff".to_vec());
    let options = LaunchOptions::parse([
        OsString::from("--mockup"),
        "--feedback".into(),
        path.clone(),
        "--capture".into(),
        path.clone(),
    ])
    .unwrap();
    assert_eq!(
        options.mode,
        LaunchMode::Mockup(MockupOptions {
            feedback: Some(path.clone().into()),
            capture: Some(path.into()),
        })
    );
}

#[cfg(feature = "integration-test")]
#[test]
fn test_modes_are_exclusive() {
    for first in ["--integration-test", "--sidebar-test", "--performance-test"] {
        for second in ["--integration-test", "--sidebar-test", "--performance-test"] {
            let error = LaunchOptions::parse([first, second]).unwrap_err();
            assert_eq!(error, CliError::ConflictingTestModes);
            assert_eq!(
                error.to_string(),
                "native test modes are mutually exclusive and may only be specified once"
            );
        }
    }
    let error = LaunchOptions::parse(["--integration-test"]).unwrap_err();
    assert_eq!(error, CliError::MissingIntegrationSocket);
    assert_eq!(
        error.to_string(),
        "--integration-test requires an explicit --socket"
    );
    for flag in ["--sidebar-test", "--performance-test"] {
        let error = LaunchOptions::parse([flag, "--dev"]).unwrap_err();
        assert_eq!(error, CliError::ConflictingFixtureOptions);
        assert_eq!(
            error.to_string(),
            "fixture tests cannot be combined with connection options or --integration-test"
        );
    }
}
