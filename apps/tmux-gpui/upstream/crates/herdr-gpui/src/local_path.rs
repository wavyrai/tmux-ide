use std::{ffi::OsString, path::PathBuf};

/// GUI launches omit directories commonly used by user-installed tools.
pub(crate) fn local_path() -> OsString {
    let mut dirs = Vec::new();
    if let Ok(home) = crate::config::home() {
        dirs.extend(
            [".local/bin", ".cargo/bin", ".bun/bin", ".npm-global/bin"].map(|dir| home.join(dir)),
        );
    }
    if cfg!(unix) {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    dirs.extend(std::env::split_paths(&inherited));
    std::env::join_paths(dirs).unwrap_or(inherited)
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn fallback_includes_homebrew() {
        assert!(
            std::env::split_paths(&super::local_path())
                .any(|path| path == std::path::Path::new("/opt/homebrew/bin"))
        );
    }
}
