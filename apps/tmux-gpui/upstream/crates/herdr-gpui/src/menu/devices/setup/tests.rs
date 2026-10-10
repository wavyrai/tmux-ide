use super::*;

#[test]
fn validates_setup_fields_before_launch() -> Result<()> {
    for target in ["", "-oProxyCommand=bad", "two hosts", "host\ncommand"] {
        assert!(matches!(
            Request::new(target, "Label", ""),
            Err(Error::DeviceSetupInput(_))
        ));
    }
    // An empty label is not an error: the target names the device.
    assert_eq!(Request::new("host", "", "")?.label(), "host");
    assert!(Request::new("host", "Label", "../session").is_err());
    assert!(Request::new("host", "Label", ".").is_err());
    assert!(Request::new("host", "Label", "dev.session").is_ok());
    assert!(Request::new("ssh://user:password@host", "Label", "").is_err());
    let request = Request::new(" user@host ", " My Device ", "")?;
    assert_eq!(
        request.arguments(),
        [
            "machine",
            "add",
            "user@host",
            "--label",
            "My Device",
            "--remote-session",
            "default"
        ]
    );
    Ok(())
}

fn destination(host: &str) -> Destination {
    Destination {
        user: "penso".into(),
        host: host.into(),
        port: 22,
    }
}

fn saved(id: char, label: &str, target: &str) -> SavedHost {
    SavedHost {
        id: id.to_string().repeat(32),
        label: label.into(),
        target: target.into(),
        session: "default".into(),
        enabled: true,
    }
}

#[test]
fn a_claim_blocks_a_second_add_until_released_held_or_expired() -> Result<()> {
    let now = Instant::now();
    let first = Claim::acquire(destination("claim.test"), "default", now)?;
    assert!(matches!(
        Claim::acquire(destination("claim.test"), "default", now),
        Err(Error::DeviceAdding)
    ));
    // Another session on the same host is a different device.
    drop(Claim::acquire(destination("claim.test"), "work", now)?);
    drop(first);
    let held = Claim::acquire(destination("claim.test"), "default", now)?;
    held.hold();
    assert!(Claim::acquire(destination("claim.test"), "default", now).is_err());
    drop(Claim::acquire(
        destination("claim.test"),
        "default",
        now + CLAIM_TTL,
    )?);
    Ok(())
}

#[test]
fn saved_hosts_match_by_resolved_destination_not_spelling() -> Result<()> {
    let request = Request::new("penso@10.0.0.9", "Box", "")?;
    let claim = Claim::acquire(destination("match.test"), "default", Instant::now())?;
    let resolve = |target: &str| {
        (target == "box-alias" || target == "penso@10.0.0.9").then(|| destination("match.test"))
    };
    let mut other_session = saved('b', "Work", "box-alias");
    other_session.session = "work".into();
    let hosts = [
        saved('a', "Else", "elsewhere"),
        other_session,
        saved('c', "Box", "box-alias"),
    ];
    assert_eq!(
        first_saved(&request, &claim, &hosts, resolve).map(|host| host.label.as_str()),
        Some("Box")
    );
    assert!(ensure_unsaved(&request, &claim, &hosts[..2], resolve).is_ok());
    Ok(())
}

#[test]
fn saved_ids_come_only_from_the_cli_confirmation_line() {
    let id = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        saved_id(format!("progress\nSaved SSH machine {id}. Remote server is ready.\n").as_bytes()),
        Some(id.into())
    );
    assert_eq!(
        saved_id(b"Saved SSH machine ../x. Remote server is ready.\n"),
        None
    );
    assert_eq!(saved_id(b""), None);
}

/// A fake `herdr` that prints the confirmation `machine add` prints, logs
/// removals, and fails the add of `host` the way a needed approval does.
#[cfg(unix)]
fn fake_cli(name: &str) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    let root = std::env::temp_dir().join(format!("herdr-device-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
    let binary = root.join("herdr");
    let log = root.join("log");
    crate::test_executable::write(
        &binary,
        format!(
            "#!/bin/sh\ncase \"$1 $2\" in\n\
                 'machine add') [ \"$3\" = host ] && {{ read -r answer; echo 'error: approval required' >&2; exit 3; }}\n\
                   echo add >> '{log}'; echo \"Saved SSH machine {id}. Remote server is ready.\";;\n\
                 'machine remove') echo \"remove $3\" >> '{log}';;\n\
                 esac\n",
            log = log.display(),
            id = "a".repeat(32),
        ),
        0o700,
    )?;
    Ok((binary, log))
}

#[cfg(unix)]
#[test]
fn save_reports_the_cli_failure_without_waiting_for_input() -> Result<()> {
    let (binary, log) = fake_cli("failure")?;
    let request = Request::new("host", "Label", "")?;
    let claim = Claim::acquire(destination("failure.test"), "default", Instant::now())?;
    let error = save_with(&binary, &request, &claim, || Ok(Vec::new()), |_| None).err();
    std::fs::remove_dir_all(binary.parent().unwrap_or(&binary))?;
    assert!(!log.exists());
    match error {
        Some(Error::DeviceSetup { status, detail }) => {
            assert_eq!(status.code(), Some(3));
            assert_eq!(detail, "error: approval required");
        }
        other => panic!("unexpected result: {other:?}"),
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn a_host_saved_by_another_client_meanwhile_keeps_only_the_first_profile() -> Result<()> {
    let (binary, log) = fake_cli("race")?;
    let request = Request::new("penso@box", "Mine", "")?;
    let claim = Claim::acquire(destination("race.test"), "default", Instant::now())?;
    let resolve = |_: &str| Some(destination("race.test"));
    let ours = saved('a', "Mine", "penso@box");
    let theirs = saved('b', "Theirs", "box-alias");
    let run = |after: Vec<SavedHost>| {
        let loads = std::cell::Cell::new(0);
        let result = save_with(
            &binary,
            &request,
            &claim,
            || {
                loads.set(loads.get() + 1);
                Ok(if loads.get() == 1 {
                    Vec::new()
                } else {
                    after.clone()
                })
            },
            resolve,
        );
        let calls = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_file(&log);
        (result, calls)
    };

    // Nobody else saved it: ours stays.
    let (result, calls) = run(vec![ours.clone()]);
    assert!(result.is_ok());
    assert_eq!(calls, "add\n");
    // Another client saved it first: ours is removed, theirs stays.
    let (result, calls) = run(vec![theirs.clone(), ours.clone()]);
    assert!(matches!(result, Err(Error::DeviceExists(label)) if label == "Theirs"));
    assert_eq!(calls, format!("add\nremove {}\n", "a".repeat(32)));
    // Ours came first: the other client removes its own, not us.
    let (result, calls) = run(vec![ours, theirs.clone()]);
    assert!(result.is_ok());
    assert_eq!(calls, "add\n");

    // Already saved before we start: `machine add` never runs.
    let before = save_with(
        &binary,
        &request,
        &claim,
        || Ok(vec![theirs.clone()]),
        resolve,
    );
    assert!(matches!(before, Err(Error::DeviceExists(_))));
    assert!(!log.exists());
    std::fs::remove_dir_all(binary.parent().unwrap_or(&binary))?;
    Ok(())
}

#[test]
fn an_empty_label_names_the_device_after_its_target() -> Result<()> {
    assert_eq!(
        Request::new("penso@10.0.0.9", "  ", "")?.label(),
        "penso@10.0.0.9"
    );
    assert_eq!(device_label("", "ssh://penso@box:22")?, "penso@box:22");
    assert_eq!(device_label(" Work box ", "box")?, "Work box");
    // A long target is cut to Herdr's limit on a character boundary.
    let long = format!("u@{}", "é".repeat(100));
    let label = device_label("", &long)?;
    assert!(label.len() <= LABEL_LIMIT && long.starts_with(&label));
    assert!(device_label("bad\u{7}", "box").is_err());
    assert!(device_label(&"x".repeat(129), "box").is_err());
    Ok(())
}

#[cfg(unix)]
#[test]
fn rename_passes_the_label_as_one_value_even_when_it_looks_like_a_flag() -> Result<()> {
    let root = std::env::temp_dir().join(format!("herdr-device-rename-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
    let binary = root.join("herdr");
    let log = root.join("log");
    crate::test_executable::write(
        &binary,
        format!(
            "#!/bin/sh\nprintf '%s|' \"$@\" > '{}'\n[ \"$3\" = missing ] && {{ echo 'machine profile missing was not found' >&2; exit 1; }}\nexit 0\n",
            log.display()
        ),
        0o700,
    )?;
    let id = "0123456789abcdef0123456789abcdef";
    rename_with(binary.as_os_str(), id, "--work = box")?;
    assert_eq!(
        std::fs::read_to_string(&log)?,
        format!("machine|rename|{id}|--label=--work = box|")
    );
    assert!(matches!(
        rename_with(binary.as_os_str(), "../x", "x"),
        Err(Error::DeviceSetupInput(_))
    ));
    std::fs::remove_dir_all(&root)?;
    Ok(())
}

#[test]
fn same_host_means_same_ssh_target_and_session() -> Result<()> {
    // An empty session is the default one, as `machine add` saves it.
    let request = Request::new(" penso@box ", "Box", "")?;
    assert!(request.same_host("penso@box", "default"));
    assert!(!request.same_host("penso@box", "work"));
    assert!(!request.same_host("other@box", "default"));
    Ok(())
}

#[test]
fn save_failures_keep_only_the_final_diagnostic_line() {
    assert_eq!(
        last_line(b"connecting\nerror: remote server is not ready\n\n"),
        "error: remote server is not ready"
    );
    assert_eq!(last_line(b"\x1b[31mbad\x1b[0m"), "[31mbad[0m");
    assert_eq!(last_line(&[b'x'; 1000]).len(), 300);
    assert_eq!(last_line(b""), "");
}

#[test]
fn shell_arguments_and_catalog_roots_are_quoted() -> Result<()> {
    let request = Request::new("host", "Alice's $(printf INJECTED); device", "work")?;
    let setup = shell_command(
        "/a path/herdr",
        &request,
        &[("XDG_STATE_HOME".into(), "/state user's".into())],
    );
    let command = &setup.command;
    assert!(command.contains("\"XDG_STATE_HOME=$HERDR_GPUI_SETUP_XDG_STATE_HOME\""));
    assert!(command.contains("'-u' 'HERDR_GPUI_SETUP_XDG_STATE_HOME'"));
    assert!(command.contains("'/a path/herdr' 'machine' 'add' 'host'"));
    assert!(command.contains("'Alice'\\''s $(printf INJECTED); device'"));
    assert!(command.contains("'-u' 'HERDR_CONFIG_PATH'"));
    assert_eq!(
        setup.environment,
        BTreeMap::from([(
            "HERDR_GPUI_SETUP_XDG_STATE_HOME".to_owned(),
            "/state user's".to_owned()
        )])
    );
    Ok(())
}

/// Splits the setup command the way a POSIX shell in the workspace would,
/// with the workspace's launch environment, and returns its words.
#[cfg(unix)]
fn shell_words(setup: &TerminalSetup) -> Result<Vec<Vec<u8>>> {
    let output = Command::new("/bin/sh")
        .args([
            "-c",
            &format!("set -- {}; printf '%s\\0' \"$@\"", setup.command),
        ])
        .envs(&setup.environment)
        .output()?;
    assert!(output.status.success());
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(<[u8]>::to_vec)
        .collect())
}

#[cfg(unix)]
#[test]
fn terminal_shell_preserves_exact_arguments_without_expansion() -> Result<()> {
    let request = Request::new("user@host", "Alice's $(printf INJECTED); device", "work")?;
    let setup = shell_command(
        "/a path/herdr",
        &request,
        &[("XDG_STATE_HOME".into(), "/state user's".into())],
    );
    let args = shell_words(&setup)?;
    assert_eq!(
        &args[args.len() - 7..],
        request.arguments().map(str::as_bytes).as_slice()
    );
    assert!(args.contains(&b"XDG_STATE_HOME=/state user's".to_vec()));
    assert!(args.contains(&b"/a path/herdr".to_vec()));
    Ok(())
}

#[cfg(unix)]
mod long_environment;
