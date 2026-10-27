use super::*;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{fs, path::Path};

// Every test in `edits` is Unix-only.
#[cfg(unix)]
mod edits;
mod pane_history;
mod reading;
mod save_safety;
mod theme_palettes;

fn parsed(text: &str) -> Result<Settings, Error> {
    #[cfg(unix)]
    let snapshot = persistence::Snapshot {
        text: Some(text.into()),
        ..Default::default()
    };
    #[cfg(windows)]
    let snapshot = persistence::Snapshot {
        text: Some(text.into()),
    };
    Settings::parse(PathBuf::from("/fixture/herdr/config.toml"), snapshot)
}

fn source(error: &crate::Error) -> Option<&Error> {
    let mut cause: &(dyn std::error::Error + 'static) = error;
    loop {
        if let Some(error) = cause.downcast_ref::<Error>() {
            return Some(error);
        }
        cause = cause.source()?;
    }
}
