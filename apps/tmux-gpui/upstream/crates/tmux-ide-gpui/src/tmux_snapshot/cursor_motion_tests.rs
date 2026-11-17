use super::*;

#[test]
fn cursor_animation_is_on_unless_saved_off() -> anyhow::Result<()> {
    assert!(Setting::default().enabled);
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("gpui-cursor.json");
    let missing = Setting::load(Some(path.clone()));
    assert!(missing.enabled && missing.ready && missing.note.is_none());
    developer_mode::write(&path, false)?;
    assert!(!Setting::load(Some(path.clone())).enabled);
    developer_mode::write(&path, true)?;
    assert!(Setting::load(Some(path.clone())).enabled);
    std::fs::write(&path, "not json")?;
    let malformed = Setting::load(Some(path));
    assert!(malformed.enabled && malformed.note.is_some());
    Ok(())
}

#[test]
fn the_cursor_setting_has_its_own_file_and_temporary() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let developer = dir.path().join("gpui-developer.json");
    let cursor = dir.path().join("gpui-cursor.json");
    // A pending developer write does not block the cursor's.
    let temporary = dir
        .path()
        .join(format!(".gpui-developer-{}.tmp", std::process::id()));
    std::fs::write(&temporary, "pending")?;
    developer_mode::write(&cursor, false)?;
    assert!(!developer_mode::read(&cursor)?.enabled);
    assert!(developer_mode::read(&developer).is_err());
    Ok(())
}
