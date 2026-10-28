use super::*;
#[test]
fn developer_preferences_missing_and_malformed_stay_off() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("gpui-developer.json");
    let missing = Settings::load(Some(path.clone()));
    assert!(!missing.enabled);
    assert!(missing.ready && missing.note.is_none());
    for contents in [
        "not json",
        r#"{"version":2,"enabled":true}"#,
        r#"{"version":1,"enabled":true,"extra":0}"#,
        r#"{"version":1,"enabled":"true"}"#,
    ] {
        std::fs::write(&path, contents)?;
        let settings = Settings::load(Some(path.clone()));
        assert!(!settings.enabled);
        assert!(settings.note.is_some());
        assert_eq!(std::fs::read_to_string(&path)?, contents);
    }
    std::fs::write(&path, " ".repeat(1025))?;
    assert!(read(&path).is_err());
    Ok(())
}
#[test]
fn developer_preferences_persist_both_values_and_atomic_conflict_preserves_previous()
-> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("gpui-developer.json");
    write(&path, true)?;
    assert!(Settings::load(Some(path.clone())).enabled);
    let temporary = dir
        .path()
        .join(format!(".gpui-developer-{}.tmp", std::process::id()));
    std::fs::write(&temporary, "someone else's write")?;
    assert!(write(&path, false).is_err());
    assert!(read(&path)?.enabled);
    assert_eq!(std::fs::read_to_string(&temporary)?, "someone else's write");
    std::fs::remove_file(temporary)?;
    write(&path, false)?;
    assert!(!Settings::load(Some(path)).enabled);
    Ok(())
}
