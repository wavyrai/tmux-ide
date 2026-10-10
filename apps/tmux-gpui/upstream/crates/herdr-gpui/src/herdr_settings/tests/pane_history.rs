use super::*;

#[test]
fn pane_history_follows_herdr_default_and_ignores_invalid_values() -> anyhow::Result<()> {
    assert!(!parsed("")?.pane_history);
    assert!(parsed("[experimental]\npane_history = true")?.pane_history);
    // Like Herdr, a value this build cannot read keeps history off.
    for text in [
        "[experimental]\npane_history = 'yes'",
        "experimental = 1",
        "[experimental]\npane_history = 1\nfuture = true",
    ] {
        assert!(!parsed(text)?.pane_history, "{text}");
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn pane_history_edit_keeps_sibling_experiments_and_comments() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    fs::write(&path, "[ui]\ncopy_on_select = true\n")?;
    let settings = Settings::load_path(path.clone())?.save(Edit::PaneHistory(true))?;
    assert!(settings.pane_history);
    assert_eq!(
        fs::read_to_string(&path)?,
        "[ui]\ncopy_on_select = true\n\n[experimental]\npane_history = true\n"
    );

    let original =
        "[experimental] # opt in\npane_history = true # replay\ncjk_ime_agents = ['codex']\n";
    fs::write(&path, original)?;
    let settings = Settings::load_path(path.clone())?.save(Edit::PaneHistory(false))?;
    assert!(!settings.pane_history);
    assert_eq!(
        fs::read_to_string(&path)?,
        "[experimental] # opt in\npane_history = false # replay\ncjk_ime_agents = ['codex']\n"
    );
    Ok(())
}
