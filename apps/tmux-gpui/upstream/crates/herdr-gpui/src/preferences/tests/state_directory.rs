use super::*;

fn directory(vars: &[(&str, &str)]) -> Option<PathBuf> {
    state_dir_with(|name| {
        vars.iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| (*value).into())
    })
}

#[core::prelude::v1::test]
fn explicit_state_home_wins() {
    assert_eq!(
        directory(&[
            ("XDG_STATE_HOME", "state"),
            ("LOCALAPPDATA", "local"),
            ("USERPROFILE", "profile"),
            ("HOME", "home"),
        ]),
        Some(PathBuf::from("state").join("herdr").join("gpui"))
    );
}

#[core::prelude::v1::test]
fn empty_variables_are_ignored_and_missing_roots_disable_storage() {
    assert_eq!(directory(&[]), None);
    assert_eq!(directory(&[("XDG_STATE_HOME", ""), ("HOME", "")]), None);
    assert_eq!(
        directory(&[("XDG_STATE_HOME", ""), ("HOME", "home")]),
        Some(PathBuf::from("home").join(".local/state/herdr/gpui"))
    );
}

#[cfg(windows)]
#[core::prelude::v1::test]
fn windows_existing_home_state_keeps_its_location() {
    assert_eq!(
        directory(&[
            ("XDG_STATE_HOME", ""),
            ("HOME", "home"),
            ("LOCALAPPDATA", "local"),
            ("USERPROFILE", "profile"),
        ]),
        Some(PathBuf::from("home").join(".local/state/herdr/gpui"))
    );
}

#[cfg(windows)]
#[core::prelude::v1::test]
fn windows_logs_and_preferences_work_without_xdg_or_home() {
    assert_eq!(
        directory(&[
            ("HOME", ""),
            ("LOCALAPPDATA", "local"),
            ("USERPROFILE", "profile")
        ]),
        Some(PathBuf::from("local").join("herdr/gpui"))
    );
    assert_eq!(
        directory(&[("LOCALAPPDATA", ""), ("USERPROFILE", "profile")]),
        Some(PathBuf::from("profile").join("AppData/Local/herdr/gpui"))
    );
}
