use super::*;

/// macOS truncates a line typed into a pty in canonical mode at `MAX_CANON`.
const MAX_CANON: usize = 1024;

/// Issue #288: a long `PATH` pushed the executable and `machine add` past the
/// canonical line limit, so the shell never ran them.
#[test]
fn long_environment_stays_out_of_the_typed_line() -> Result<()> {
    let request = Request::new("user@host", "Device", "work")?;
    let path = format!("/it's $HOME/`bin`:{}", "/a/long/bin:".repeat(400));
    let setup = shell_command(
        "/usr/local/bin/herdr",
        &request,
        &[
            ("HOME".into(), "/Users/me".into()),
            ("PATH".into(), path.clone()),
        ],
    );
    assert!(setup.command.len() < MAX_CANON, "{}", setup.command);
    assert!(!setup.command.contains("/a/long/bin"));
    assert_eq!(setup.environment.get("HERDR_GPUI_SETUP_PATH"), Some(&path));
    let args = shell_words(&setup)?;
    assert!(args.contains(&format!("PATH={path}").into_bytes()));
    assert!(args.contains(&b"HOME=/Users/me".to_vec()));
    // `env` drops the staging copies before running the CLI.
    for name in ["HERDR_GPUI_SETUP_PATH", "HERDR_GPUI_SETUP_HOME"] {
        let unset = args
            .windows(2)
            .any(|pair| pair[0] == b"-u" && pair[1] == name.as_bytes());
        assert!(unset, "{name} is not unset");
    }
    assert_eq!(
        &args[args.len() - 8..],
        std::iter::once("/usr/local/bin/herdr")
            .chain(request.arguments())
            .map(str::as_bytes)
            .collect::<Vec<_>>()
            .as_slice()
    );
    Ok(())
}
