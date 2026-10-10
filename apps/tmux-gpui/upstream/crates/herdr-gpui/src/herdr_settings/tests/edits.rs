use super::*;

#[cfg(unix)]
#[test]
fn tab_bar_and_copy_on_select_edits_keep_comments() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    let original = "[ui]\ncopy_on_select = true # copy\nfuture = 1\n";
    fs::write(&path, original)?;
    let settings = Settings::load_path(path.clone())?
        .save(Edit::CopyOnSelect(false))?
        .save(Edit::TabBarPosition(TabBarPosition::Bottom))?
        .save(Edit::HideSingleTabBar(true))?;
    assert!(!settings.copy_on_select);
    assert_eq!(settings.tab_bar_position, TabBarPosition::Bottom);
    assert!(settings.hide_tab_bar_when_single_tab);
    assert_eq!(
        fs::read_to_string(&path)?,
        "[ui]\ncopy_on_select = false # copy\nfuture = 1\ntab_bar_position = \"bottom\"\nhide_tab_bar_when_single_tab = true\n"
    );
    let settings = settings.save(Edit::TabBarPosition(TabBarPosition::Top))?;
    assert_eq!(settings.tab_bar_position, TabBarPosition::Top);
    Ok(())
}

#[cfg(unix)]
#[test]
fn sound_edits_preserve_paths_per_agent_policy_and_unknown_fields_verbatim() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    let original = "[ui.sound] # audio\nenabled = true # switch\npath = 'all.mp3'\ndone_path = 'done.mp3' # done\nrequest_path = 'request.mp3'\nfuture = { key = 42 }\n[ui.sound.agents] # policy\ndroid = 'default'\nclaude = 'off'\nfuture-agent = 'new-policy'\n";
    fs::write(&path, original)?;
    let settings = Settings::load_path(path.clone())?.save(Edit::Sound(false))?;
    assert!(!settings.sound_enabled);
    assert_eq!(
        fs::read_to_string(&path)?,
        original.replace("enabled = true", "enabled = false")
    );
    assert!(settings.save(Edit::Sound(true))?.sound_enabled);
    assert_eq!(fs::read_to_string(&path)?, original);
    Ok(())
}

#[test]
#[cfg(unix)]
fn edits_preserve_comments_unknown_fields_and_disable_auto_switch() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    let original = "# shared\nfuture = ['keep', 12]\n[theme] # theme\nname = 'nord' # selected\nauto_switch = true # follow\n[theme.custom]\nred = '#123456'\n[ui]\nstatus_indicators = 'dots' # indicators\n[ui.sound]\nenabled = true # audible\npath = 'keep.mp3'\n[ui.toast]\n# legacy comment\nenabled = true # legacy inline\ndelay_seconds = 2 # wait\n[unknown]\nvalue = 'untouched'\n";
    fs::write(&path, original)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640))?;
    let settings = Settings::load_path(path.clone())?.save(Edit::Theme("Dracula".into()))?;
    assert_eq!(
        fs::read_to_string(&path)?,
        original
            .replace("'nord'", "\"dracula\"")
            .replace("auto_switch = true", "auto_switch = false")
    );
    assert_eq!(settings.theme(false)?, settings.theme(true)?);
    assert_eq!(settings.status_color(AgentStatus::Blocked, false), 0x123456);
    let settings = settings
        .save(Edit::Indicators(IndicatorStyle::Symbols))?
        .save(Edit::Sound(false))?
        .save(Edit::Toasts(ToastDelivery::Terminal))?;
    assert_eq!(settings.indicators, IndicatorStyle::Symbols);
    assert!(!settings.sound_enabled);
    assert_eq!(settings.toast_delivery, ToastDelivery::Terminal);
    let text = fs::read_to_string(&path)?;
    for kept in [
        "# shared",
        "# selected",
        "# follow",
        "# indicators",
        "# audible",
        "# wait",
        "# legacy comment",
        "# legacy inline",
        "future = ['keep', 12]",
        "value = 'untouched'",
        "path = 'keep.mp3'",
    ] {
        assert!(text.contains(kept), "missing {kept}: {text}");
    }
    let document: toml::Value = toml::from_str(&text)?;
    assert!(document["ui"]["toast"].get("enabled").is_none());
    assert_eq!(fs::metadata(&path)?.permissions().mode() & 0o777, 0o640);
    assert!(fs::read_dir(temp.path())?.all(|entry| {
        entry.is_ok_and(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp"))
    }));
    Ok(())
}

#[test]
#[cfg(unix)]
fn inline_tables_and_dotted_keys_remain_valid() -> anyhow::Result<()> {
    for text in [
        "ui = { sound = { enabled = true }, toast = { enabled = true, future = 42 } }\n",
        "ui.sound.enabled = true\nui.toast.enabled = true\n",
    ] {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("config.toml");
        fs::write(&path, text)?;
        let settings = Settings::load_path(path.clone())?
            .save(Edit::Sound(false))?
            .save(Edit::Toasts(ToastDelivery::Herdr))?;
        assert!(!settings.sound_enabled);
        assert_eq!(settings.toast_delivery, ToastDelivery::Herdr);
        Settings::load_path(path)?;
    }
    Ok(())
}
