use super::*;

#[cfg(windows)]
#[test]
fn windows_shared_settings_are_bounded_and_read_only() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("missing/config.toml");
    let settings = Settings::load_path(path.clone())?;
    let error = settings
        .save(Edit::Sound(false))
        .err()
        .ok_or_else(|| anyhow::anyhow!("saved on Windows"))?;
    assert!(matches!(source(&error), Some(Error::Unsupported)));
    assert!(!path.parent().is_some_and(Path::exists));
    let path = temp.path().join("config.toml");
    let original = "[ui.sound]\nenabled = false\n";
    fs::write(&path, original)?;
    let settings = Settings::load_path(path.clone())?;
    assert!(!settings.sound_enabled);
    assert!(settings.save(Edit::Sound(true)).is_err());
    assert_eq!(fs::read_to_string(&path)?, original);
    assert_eq!(fs::read_dir(temp.path())?.count(), 1);
    fs::write(&path, " ".repeat(1024 * 1024 + 1))?;
    assert!(matches!(persistence::read(&path), Err(Error::TooLarge)));
    Ok(())
}

#[test]
fn defaults_and_path_precedence_without_environment_mutation() -> anyhow::Result<()> {
    let settings = parsed("")?;
    assert_eq!(settings.theme_name, "catppuccin");
    assert_eq!(settings.indicators, IndicatorStyle::Dots);
    assert!(settings.sound_enabled);
    assert_eq!(settings.toast_delivery, ToastDelivery::Off);
    assert_eq!(settings.toast_delay_seconds, 1);
    assert_eq!(settings.toast_position, ToastPosition::BottomRight);
    assert!(settings.clipboard.enabled);
    assert_eq!(settings.clipboard.position, ClipboardPosition::BottomCenter);
    assert_eq!(
        settings.name_prompts,
        NamePrompts {
            tab: true,
            workspace: false
        }
    );
    let temp = tempfile::tempdir()?;
    let missing = temp.path().join("missing/config.toml");
    assert_eq!(
        Settings::load_path(missing.clone())?.theme_name,
        "catppuccin"
    );
    assert!(!missing.parent().is_some_and(Path::exists));
    Ok(())
}

#[test]
fn exact_upstream_fields_and_legacy_toast_precedence() -> anyhow::Result<()> {
    let settings = parsed(
        r#"
[ui]
status_indicators = "symbols"
[ui.sound]
enabled = true
[ui.toast]
enabled = true
delivery = "system"
delay_seconds = 3600
[ui.toast.herdr]
position = "top-left"
[ui.toast.clipboard]
enabled = false
position = "top-center"
"#,
    )?;
    assert_eq!(settings.indicators, IndicatorStyle::Symbols);
    assert_eq!(settings.toast_delivery, ToastDelivery::System);
    assert_eq!(settings.toast_delay_seconds, 3600);
    assert_eq!(settings.toast_position, ToastPosition::TopLeft);
    assert_eq!(settings.clipboard.position, ClipboardPosition::TopCenter);
    assert!(!settings.clipboard.enabled);
    assert!(settings.sound_enabled);
    assert!(!parsed("[ui.sound]\nenabled = false")?.sound_enabled);
    assert_eq!(
        parsed("[ui.toast]\nenabled = true")?.toast_delivery,
        ToastDelivery::Herdr
    );
    assert_eq!(
        parsed("[ui.toast]\nenabled = false\ndelivery = 'terminal'")?.toast_delivery,
        ToastDelivery::Terminal
    );
    Ok(())
}

#[test]
fn sidebar_collapse_defaults_compact_expanded_and_parses_upstream_values() -> anyhow::Result<()> {
    let defaults = parsed("")?;
    assert_eq!(
        defaults.sidebar_collapsed_mode,
        SidebarCollapsedMode::Compact
    );
    assert!(!defaults.sidebar_start_collapsed);
    let set = parsed("[ui]\nsidebar_collapsed_mode = 'hidden'\nsidebar_start_collapsed = true\n")?;
    assert_eq!(set.sidebar_collapsed_mode, SidebarCollapsedMode::Hidden);
    assert!(set.sidebar_start_collapsed);
    assert_eq!(
        parsed("[ui]\nsidebar_collapsed_mode = 'compact'")?.sidebar_collapsed_mode,
        SidebarCollapsedMode::Compact
    );
    // A mode from a newer Herdr falls back alone; its neighbour still applies.
    let newer = parsed("[ui]\nsidebar_collapsed_mode = 'rail'\nsidebar_start_collapsed = true\n")?;
    assert_eq!(newer.sidebar_collapsed_mode, SidebarCollapsedMode::Compact);
    assert!(newer.sidebar_start_collapsed);
    Ok(())
}

#[test]
fn name_prompts_follow_both_ui_keys() -> anyhow::Result<()> {
    let flipped = parsed("[ui]\nprompt_new_tab_name = false\nprompt_new_workspace_name = true")?;
    assert_eq!(
        flipped.name_prompts,
        NamePrompts {
            tab: false,
            workspace: true
        }
    );
    // Each key keeps its own default when only the other is set.
    assert_eq!(
        parsed("[ui]\nprompt_new_workspace_name = true")?.name_prompts,
        NamePrompts {
            tab: true,
            workspace: true
        }
    );
    // A value this build cannot read keeps Herdr's default.
    assert_eq!(
        parsed("[ui]\nprompt_new_tab_name = 'no'")?.name_prompts,
        NamePrompts::default()
    );
    Ok(())
}

#[test]
fn values_from_a_newer_herdr_fall_back_one_by_one() -> anyhow::Result<()> {
    // Each value this build cannot read keeps its own default.
    for text in [
        "[ui]\nstatus_indicators = 'bars'",
        "[ui]\nagent_panel_sort = 'grouped'",
        "[ui.sound]\nenabled = 'true'",
        "[theme]\nauto_switch = 1",
        "[theme.custom]\nred = 123",
        "[theme.custom]\naccent = 123",
        "[ui.toast]\ndelay_seconds = -1",
        "[ui.toast]\ndelay_seconds = 3601",
        "[ui.toast]\ndelivery = 'pager'",
        "[ui.toast.herdr]\nposition = 'top-center'",
        "[ui]\nsidebar_collapsed_mode = 'rail'",
        "[ui]\nsidebar_start_collapsed = 'yes'",
        "[ui.toast.clipboard]\nposition = 'middle'\nenabled = 2",
        "theme = 'catppuccin'",
        "ui = 1",
    ] {
        let settings = parsed(text)?;
        let defaults = parsed("")?;
        assert_eq!(settings.indicators, defaults.indicators, "{text}");
        assert_eq!(settings.agent_sort, defaults.agent_sort, "{text}");
        assert_eq!(settings.sound_enabled, defaults.sound_enabled, "{text}");
        assert_eq!(settings.toast_delivery, defaults.toast_delivery, "{text}");
        assert_eq!(settings.toast_delay_seconds, 1, "{text}");
        assert_eq!(settings.toast_position, defaults.toast_position, "{text}");
        assert_eq!(
            settings.clipboard.enabled, defaults.clipboard.enabled,
            "{text}"
        );
        assert_eq!(
            settings.clipboard.position, defaults.clipboard.position,
            "{text}"
        );
        assert_eq!(settings.theme_name, defaults.theme_name, "{text}");
        assert_eq!(settings.palettes, defaults.palettes, "{text}");
        assert_eq!(
            settings.sidebar_collapsed_mode, defaults.sidebar_collapsed_mode,
            "{text}"
        );
        assert_eq!(
            settings.sidebar_start_collapsed, defaults.sidebar_start_collapsed,
            "{text}"
        );
    }
    // Readable neighbours of an unreadable value still apply.
    let settings = parsed(
        "[theme]\nname = 'nord'\nauto_switch = 'sometimes'\n\
         [ui]\nstatus_indicators = 'symbols'\nfuture = 1\n\
         [ui.toast]\nenabled = true\ndelivery = 'pager'\ndelay_seconds = 9\n\
         [ui.toast.herdr]\nposition = 'top-left'\n\
         [ui.toast.clipboard]\nenabled = false\nposition = 'middle'",
    )?;
    assert_eq!(settings.theme_name, "nord");
    assert_eq!(settings.indicators, IndicatorStyle::Symbols);
    assert_eq!(settings.toast_delivery, ToastDelivery::Herdr);
    assert_eq!(settings.toast_delay_seconds, 9);
    assert_eq!(settings.toast_position, ToastPosition::TopLeft);
    assert!(!settings.clipboard.enabled);
    assert_eq!(settings.clipboard.position, ClipboardPosition::BottomCenter);
    Ok(())
}

#[test]
fn malformed_toml_keeps_typed_sources() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    fs::write(&path, "[broken")?;
    let error = Settings::load_path(path)
        .err()
        .ok_or_else(|| anyhow::anyhow!("accepted malformed TOML"))?;
    assert!(matches!(source(&error), Some(Error::Parse(_))));
    use std::error::Error as _;
    assert!(
        source(&error)
            .and_then(|error| error.source())
            .is_some_and(|source| source.is::<toml::de::Error>())
    );
    Ok(())
}

#[test]
fn agent_panel_sort_reads_upstream_spellings() -> anyhow::Result<()> {
    use crate::preferences::AgentSort;
    for (text, expected) in [
        ("", AgentSort::Grouped),
        ("[ui]\nagent_panel_sort = 'spaces'", AgentSort::Grouped),
        ("[ui]\nagent_panel_sort = 'workspaces'", AgentSort::Grouped),
        ("[ui]\nagent_panel_sort = 'priority'", AgentSort::Priority),
    ] {
        assert_eq!(parsed(text)?.agent_sort, expected, "{text}");
    }
    Ok(())
}

#[test]
fn shared_sound_reader_only_validates_the_enabled_switch() -> anyhow::Result<()> {
    for text in [
        "",
        "[ui.sound]",
        "[ui.sound]\npath = 42\n[ui.sound.agents]\nclaude = true",
    ] {
        assert!(parsed(text)?.sound_enabled);
    }
    assert!(!parsed("[ui.sound]\nenabled = false\nagents = 'backend-owned'")?.sound_enabled);
    Ok(())
}

#[test]
fn tab_bar_and_copy_on_select_follow_herdr_defaults_and_values() -> anyhow::Result<()> {
    let defaults = parsed("")?;
    assert!(defaults.copy_on_select);
    assert_eq!(defaults.tab_bar_position, TabBarPosition::Top);
    assert!(!defaults.hide_tab_bar_when_single_tab);
    let set = parsed(
        "[ui]\ncopy_on_select = false\ntab_bar_position = 'bottom'\nhide_tab_bar_when_single_tab = true",
    )?;
    assert!(!set.copy_on_select);
    assert_eq!(set.tab_bar_position, TabBarPosition::Bottom);
    assert!(set.hide_tab_bar_when_single_tab);
    // Like Herdr, a value this build does not know keeps the default.
    let unknown = parsed(
        "[ui]\ncopy_on_select = 'sometimes'\ntab_bar_position = 'left'\nhide_tab_bar_when_single_tab = 1",
    )?;
    assert!(unknown.copy_on_select);
    assert_eq!(unknown.tab_bar_position, TabBarPosition::Top);
    assert!(!unknown.hide_tab_bar_when_single_tab);
    Ok(())
}

#[test]
fn diagnostics_do_not_dump_unrelated_shared_config() -> anyhow::Result<()> {
    let settings =
        parsed("private_value = 'do-not-log-me'\n[ui.sound]\npath = 'private-sound-path'")?;
    let diagnostic = format!("{settings:?}");
    assert!(!diagnostic.contains("do-not-log-me"));
    assert!(!diagnostic.contains("private-sound-path"));
    assert!(diagnostic.contains("clipboard"));
    #[cfg(unix)]
    {
        let error = Error::Committed(std::io::Error::other("sync failed"));
        assert!(
            std::error::Error::source(&error).is_some_and(|cause| cause.is::<std::io::Error>())
        );
        assert!(error.to_string().contains("reload"));
    }
    Ok(())
}
