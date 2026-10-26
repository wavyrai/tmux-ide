//! Local configuration projection of runtime-namespace.ts. Background-thread IO.
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};
#[path = "config_development.rs"]
mod development;
/// Captured local environment, independent of the currently selected SSH source.
/// Resolve again before persistence: existing symlink ancestors may have changed.
pub struct LocalConfigNamespace {
    env: BTreeMap<String, String>,
    home: PathBuf,
    cwd: PathBuf,
    record: Option<PathBuf>,
}
impl LocalConfigNamespace {
    pub fn capture(record: Option<PathBuf>) -> Option<Self> {
        Self::from_environment(std::env::vars_os(), std::env::current_dir().ok()?, record)
    }
    /// Capture the launching terminal's namespace rather than a shared host process.
    pub fn from_environment(
        values: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
        cwd: PathBuf,
        record: Option<PathBuf>,
    ) -> Option<Self> {
        let env = capture_environment(values)?;
        let home = PathBuf::from(env.get("HOME")?);
        Some(Self {
            env,
            home,
            cwd,
            record,
        })
    }
    /// Resolve the canonical discovery record only after validating the entire
    /// local runtime namespace. Invalid isolated settings never fall back to HOME.
    pub fn daemon_record(&self) -> Option<PathBuf> {
        self.resolve()?;
        let state = self.value("TMUX_IDE_HOME").map_or_else(
            || Some(self.home.join(".tmux-ide")),
            |p| absolute(Path::new(p), &self.cwd),
        )?;
        let registry = self
            .value("TMUX_IDE_REGISTRY_DIR")
            .map_or_else(|| Some(state), |p| absolute(Path::new(p), &self.cwd))?;
        let daemon = self
            .value("TMUX_IDE_DAEMON_INFO_DIR")
            .map_or_else(|| Some(registry), |p| absolute(Path::new(p), &self.cwd))?;
        Some(daemon.join("daemon.json"))
    }
    fn raw(&self, key: &str) -> Option<&str> {
        self.env.get(key).map(String::as_str)
    }
    fn value(&self, key: &str) -> Option<&str> {
        self.raw(key).map(str::trim).filter(|s| !s.is_empty())
    }
    /// Returns no path for an invalid namespace or an unrelated explicit record.
    pub fn resolve(&self) -> Option<PathBuf> {
        if !self.home.is_absolute() || !self.cwd.is_absolute() {
            return None;
        }
        let mode = self.value("TMUX_IDE_RUNTIME_MODE").unwrap_or("production");
        if ![
            "production",
            "development",
            "test",
            "smoke",
            "testdrive",
            "performance",
        ]
        .contains(&mode)
        {
            return None;
        }
        let isolated = mode != "production";
        let canonical = self.home.join(".tmux-ide");
        let development = if mode == "development" {
            Some(development::resolve(self)?)
        } else {
            None
        };
        let state = match self.value("TMUX_IDE_HOME") {
            Some(path) => absolute(Path::new(path), &self.cwd)?,
            None if isolated => return None,
            None => canonical.clone(),
        };
        let registry = self.value("TMUX_IDE_REGISTRY_DIR").map_or_else(
            || Some(state.clone()),
            |p| absolute(Path::new(p), &self.cwd),
        )?;
        let daemon = self.value("TMUX_IDE_DAEMON_INFO_DIR").map_or_else(
            || Some(registry.clone()),
            |p| absolute(Path::new(p), &self.cwd),
        )?;
        let socket_name = self.value("TMUX_IDE_TMUX_SOCKET_NAME");
        let socket_path = match self.value("TMUX_IDE_TMUX_SOCKET_PATH") {
            Some(p) => Some(absolute(Path::new(p), &self.cwd)?),
            None => None,
        };
        if socket_name.is_some() && socket_path.is_some() {
            return None;
        }
        if socket_name.is_some_and(|name| !identifier(name, 64, false)) {
            return None;
        }
        if isolated {
            if socket_path.is_none() && socket_name.unwrap_or("default") == "default" {
                return None;
            }
            for path in [&state, &registry, &daemon] {
                if within(path, &canonical)? {
                    return None;
                }
            }
            if let Some(path) = &socket_path
                && within(path, &canonical)?
            {
                return None;
            }
        }
        match self.value("TMUX_IDE_CLEANUP_TOKEN") {
            Some(token) if token.len() >= 8 && identifier(token, 128, true) => {}
            None if !isolated => {}
            _ => return None,
        }
        // The config belongs to the local runtime, not an arbitrary --record or
        // SSH target. Explicit config remains allowed for custom fixture records.
        if self.raw("TMUX_IDE_CONFIG").is_none()
            && let Some(record) = &self.record
            && identity(record)? != identity(&daemon.join("daemon.json"))?
        {
            return None;
        }
        let config = self.raw("TMUX_IDE_CONFIG").map_or_else(
            || {
                if isolated {
                    state.join("config.json")
                } else {
                    canonical.join("config.json")
                }
            },
            PathBuf::from,
        );
        if config.as_os_str().is_empty() {
            return None;
        }
        if let Some(dev) = &development {
            dev.validate_scoped(self, &config)?;
        }
        absolute(&config, &self.cwd)
    }
}
fn identifier(s: &str, max: usize, colon: bool) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b) || (colon && b == b':'))
}
fn absolute(path: &Path, cwd: &Path) -> Option<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let mut result = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            c => result.push(c.as_os_str()),
        }
    }
    result.is_absolute().then_some(result)
}
fn identity(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let normalized = absolute(path, Path::new("/"))?;
    let mut cursor = normalized.as_path();
    let mut suffix = Vec::new();
    loop {
        match fs::symlink_metadata(cursor) {
            Ok(metadata) => {
                let mut result = canonical_entry(cursor, &metadata)?;
                for c in suffix.iter().rev() {
                    result.push(c);
                }
                return Some(result);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(cursor.file_name()?.to_os_string());
                cursor = cursor.parent()?;
            }
            Err(_) => return None,
        }
    }
}
fn within(path: &Path, parent: &Path) -> Option<bool> {
    Some(identity(path)?.starts_with(identity(parent)?))
}
#[cfg(test)]
#[path = "config_namespace_tests.rs"]
mod tests;

#[cfg(unix)]
fn canonical_entry(path: &Path, metadata: &fs::Metadata) -> Option<PathBuf> {
    use std::os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt},
    };
    if metadata.file_type().is_socket() {
        let bytes = path.as_os_str().as_bytes();
        if bytes.len() > 4096 || bytes.iter().any(|b| matches!(b, 0 | b'\r' | b'\n')) {
            return None;
        }
        let parent = path.parent()?;
        let info = fs::symlink_metadata(parent).ok()?;
        if !info.is_dir() || info.file_type().is_symlink() {
            return None;
        }
        let canonical = fs::canonicalize(parent).ok()?.join(path.file_name()?);
        let current = fs::symlink_metadata(&canonical).ok()?;
        if !current.file_type().is_socket()
            || current.dev() != metadata.dev()
            || current.ino() != metadata.ino()
        {
            return None;
        }
        return Some(canonical);
    }
    fs::canonicalize(path).ok()
}
#[cfg(not(unix))]
fn canonical_entry(path: &Path, _: &fs::Metadata) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn capture_environment(
    values: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Option<BTreeMap<String, String>> {
    let mut env = BTreeMap::new();
    for (key, value) in values {
        let name = key.to_string_lossy();
        if name.starts_with("TMUX_IDE_")
            || ["HOME", "TMUX", "XDG_CONFIG_HOME"].contains(&name.as_ref())
        {
            // Never drop an invalid namespace selector and fall back to production.
            env.insert(key.into_string().ok()?, value.into_string().ok()?);
        }
    }
    Some(env)
}
