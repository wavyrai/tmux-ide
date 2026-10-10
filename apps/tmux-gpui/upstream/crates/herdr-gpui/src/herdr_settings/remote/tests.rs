use super::*;

/// Points the scripts at a private config path. The assignment precedes
/// the scripts' own default, so `$HOME` is untouched.
fn prefix(path: &std::path::Path) -> String {
    format!(
        "HERDR_CONFIG_PATH={}\n",
        shell_quote(&path.to_string_lossy())
    )
}

fn read(path: &std::path::Path) -> Result<RemotePaneHistory, Error> {
    RemotePaneHistory::read(ScriptHost::Local, &prefix(path), &AtomicBool::new(false))
}

fn save(
    path: &std::path::Path,
    from: &RemotePaneHistory,
    enabled: bool,
) -> Result<RemotePaneHistory, Error> {
    from.save_with(
        ScriptHost::Local,
        &prefix(path),
        enabled,
        &AtomicBool::new(false),
    )
}

/// Writes arbitrary replacement text, for states `save` cannot produce.
fn write(path: &std::path::Path, from: &RemotePaneHistory, text: &str) -> Result<(), Error> {
    let expected = from.text.as_deref().unwrap_or("");
    let input = [expected.as_bytes(), text.as_bytes()].concat();
    let script = write_script(from.text.as_ref().map(String::len));
    run(
        ScriptHost::Local,
        &format!("{}{script}", prefix(path)),
        &input,
        &AtomicBool::new(false),
    )
    .map(|_| ())
}

#[test]
fn missing_config_reads_off_and_a_save_creates_it_privately() -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("herdr").join("config.toml");
    let missing = read(&path)?;
    assert_eq!(missing.text, None);
    assert!(!missing.enabled);

    let saved = save(&path, &missing, true)?;
    assert!(saved.enabled);
    assert_eq!(
        std::fs::read_to_string(&path)?,
        "[experimental]\npane_history = true\n"
    );
    assert_eq!(
        std::fs::metadata(&path)?.permissions().mode() & 0o777,
        0o600
    );
    // The temporary files never outlive the script.
    assert_eq!(std::fs::read_dir(temp.path().join("herdr"))?.count(), 1);
    Ok(())
}

#[test]
fn save_keeps_comments_and_sibling_settings() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    let original = "# mine\n[ui]\ncopy_on_select = false\n[experimental] # opt in\npane_history = true # replay\ncjk_ime_agents = ['codex']\n";
    std::fs::write(&path, original)?;
    let current = read(&path)?;
    assert!(current.enabled);
    assert!(!save(&path, &current, false)?.enabled);
    assert_eq!(
        std::fs::read_to_string(&path)?,
        original.replace("pane_history = true", "pane_history = false")
    );
    Ok(())
}

#[test]
fn a_config_changed_since_the_read_is_left_alone() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    std::fs::write(&path, "[ui]\n")?;
    let stale = read(&path)?;
    std::fs::write(&path, "[ui]\ncopy_on_select = false\n")?;
    assert!(matches!(
        save(&path, &stale, true),
        Err(Error::RemoteConflict)
    ));
    assert_eq!(
        std::fs::read_to_string(&path)?,
        "[ui]\ncopy_on_select = false\n"
    );

    // A file created after reading "missing", and one emptied or filled
    // after reading "empty", are conflicts too.
    let missing_path = temp.path().join("new.toml");
    let missing = read(&missing_path)?;
    std::fs::write(&missing_path, "")?;
    assert!(matches!(
        write(&missing_path, &missing, "x = 1\n"),
        Err(Error::RemoteConflict)
    ));
    let empty = read(&missing_path)?;
    assert_eq!(empty.text.as_deref(), Some(""));
    std::fs::write(&missing_path, "y = 2\n")?;
    assert!(matches!(
        write(&missing_path, &empty, "x = 1\n"),
        Err(Error::RemoteConflict)
    ));
    std::fs::write(&missing_path, "")?;
    write(&missing_path, &empty, "x = 1\n")?;
    assert_eq!(std::fs::read_to_string(&missing_path)?, "x = 1\n");
    Ok(())
}

#[test]
fn symlinks_and_directories_are_refused() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let target = temp.path().join("target.toml");
    std::fs::write(&target, "[experimental]\npane_history = true\n")?;
    let link = temp.path().join("config.toml");
    std::os::unix::fs::symlink(&target, &link)?;
    assert!(matches!(read(&link), Err(Error::RemoteUnsafePath)));
    let from = RemotePaneHistory::parse(Some(std::fs::read_to_string(&target)?))?;
    assert!(matches!(
        write(&link, &from, "x = 1\n"),
        Err(Error::RemoteUnsafePath)
    ));
    assert!(std::fs::symlink_metadata(&link)?.file_type().is_symlink());

    let directory = temp.path().join("directory");
    std::fs::create_dir(&directory)?;
    assert!(matches!(read(&directory), Err(Error::RemoteUnsafePath)));
    Ok(())
}

#[test]
fn oversized_and_non_utf8_configs_are_refused() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    std::fs::write(&path, "#".repeat(LIMIT as usize + 1))?;
    assert!(matches!(read(&path), Err(Error::RemoteTooLarge)));
    std::fs::write(&path, [b'#', 0xff, b'\n'])?;
    assert!(matches!(read(&path), Err(Error::RemoteUtf8(_))));
    Ok(())
}

#[test]
fn debug_omits_the_config_text() -> anyhow::Result<()> {
    let history = RemotePaneHistory::parse(Some(
        "[experimental]\npane_history = true\n# secret\n".into(),
    ))?;
    let debug = format!("{history:?}");
    assert!(!debug.contains("secret"), "{debug}");
    assert!(debug.contains("enabled: true"), "{debug}");
    Ok(())
}
