use super::*;
use crate::config::{
    preferences::Preference,
    status_bar::{Button, Detail, Edit},
};

#[test]
fn status_bar_items_default_to_the_full_bar() -> anyhow::Result<()> {
    for config in [
        Config::default(),
        Config::parse("")?,
        Config::parse(DEFAULT_CONFIG)?,
    ] {
        assert_eq!(config.status_bar, StatusBar::default());
        assert!(config.status_bar.show);
        assert_eq!(config.status_bar.usage, Detail::Detailed);
        assert!(config.status_bar.keep_awake);
        assert_eq!(config.status_bar.theme, Button::Label);
    }
    Ok(())
}

#[test]
fn status_bar_items_parse_and_report_unknown_keys() -> anyhow::Result<()> {
    let config = Config::parse(
        "[status_bar]\nusage = 'compact'\nsystem_load = 'compact'\nkeep_awake = false\ntheme = 'icon'\nshortcuts = 'hidden'\nreport_issue = 'icon'\nclock = true\n",
    )?;
    assert_eq!(
        config.status_bar,
        StatusBar {
            show: true,
            usage: Detail::Compact,
            system_load: Detail::Compact,
            keep_awake: false,
            theme: Button::Icon,
            shortcuts: Button::Hidden,
            report_issue: Button::Icon,
        }
    );
    assert_eq!(config.unknown_keys, ["status_bar.clock"]);
    for invalid in [
        "[status_bar]\nusage = 'tiny'\n",
        "[status_bar]\ntheme = true\n",
        "[status_bar]\nkeep_awake = 'yes'\n",
        "status_bar = 'compact'\n",
    ] {
        assert!(Config::parse(invalid).is_err(), "{invalid}");
    }
    Ok(())
}

#[test]
fn status_bar_edits_round_trip_through_the_overrides_file() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("local.toml");
    fs::write(
        &path,
        "# mine\n[status_bar]\ntheme = 'label' # theme\nfuture = 1\n",
    )?;
    let edits = [
        Edit::Usage(Detail::Compact),
        Edit::SystemLoad(Detail::Compact),
        Edit::KeepAwake(false),
        Edit::Theme(Button::Icon),
        Edit::Shortcuts(Button::Hidden),
        Edit::ReportIssue(Button::Icon),
    ];
    for edit in edits {
        Config::save_preference_path(Preference::StatusBar(edit), &path)?;
    }
    let text = fs::read_to_string(&path)?;
    assert!(text.contains("# mine"));
    assert!(text.contains("theme = \"icon\" # theme"));
    assert!(text.contains("future = 1"));
    let config = Config::parse(&text)?;
    assert_eq!(
        config.status_bar,
        StatusBar {
            show: true,
            usage: Detail::Compact,
            system_load: Detail::Compact,
            keep_awake: false,
            theme: Button::Icon,
            shortcuts: Button::Hidden,
            report_issue: Button::Icon,
        }
    );
    for edit in [
        Edit::Usage(Detail::Detailed),
        Edit::Theme(Button::Label),
        Edit::KeepAwake(true),
    ] {
        Config::save_preference_path(Preference::StatusBar(edit), &path)?;
    }
    let config = Config::parse(&fs::read_to_string(&path)?)?;
    assert_eq!(config.status_bar.usage, Detail::Detailed);
    assert_eq!(config.status_bar.theme, Button::Label);
    assert!(config.status_bar.keep_awake);
    Ok(())
}

/// `show = false` starts windows without the bar; `toggle_status_bar` still
/// brings it back. It lives in the table, so a top-level key is an error.
#[test]
fn status_bar_show_can_be_turned_off() -> anyhow::Result<()> {
    let off = Config::parse("[status_bar]\nshow = false\n")?;
    assert!(!off.status_bar.show);
    assert_eq!(
        off.status_bar,
        StatusBar {
            show: false,
            ..StatusBar::default()
        }
    );
    assert!(off.unknown_keys.is_empty());
    assert!(
        Config::parse("[status_bar]\nshow = true\n")?
            .status_bar
            .show
    );
    for invalid in ["[status_bar]\nshow = 'no'\n", "status_bar = false\n"] {
        assert!(Config::parse(invalid).is_err(), "{invalid}");
    }
    Ok(())
}
