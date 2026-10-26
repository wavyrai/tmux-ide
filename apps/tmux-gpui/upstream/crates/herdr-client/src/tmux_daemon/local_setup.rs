//! Explicit managed-install setup. Call only on an owned background worker.
//! Resolution is read-only; execution never searches PATH or installs a package.
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
#[derive(Debug, thiserror::Error)]
pub enum LocalSetupError {
    #[error("managed installation is missing")]
    Missing,
    #[error("managed installation is invalid or changed")]
    Installation,
    #[error("managed CLI version is unsupported")]
    Unsupported,
    #[error("local setup stopped waiting")]
    Stopped,
    #[error("local setup process failed")]
    Process,
    #[error("local setup response is invalid")]
    Response,
    #[error("local setup IO failed")]
    Io(#[from] std::io::Error),
}
#[derive(PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: i64,
    mtime_ns: i64,
    ctime: i64,
    ctime_ns: i64,
    mode: u32,
}
/// Private inspected paths and identities; not a wire capability.
#[derive(PartialEq, Eq)]
pub struct LocalSetupInstallation {
    home: PathBuf,
    release: PathBuf,
    node: PathBuf,
    cli: PathBuf,
    version: String,
    stamps: Vec<Stamp>,
}
impl LocalSetupInstallation {
    pub fn version(&self) -> &str {
        &self.version
    }
    /// Resolve again immediately before each executable invocation. An elected
    /// daemon may survive cancellation; cancellation stops only this CLI waiter.
    pub fn run(&self, cancel: &AtomicBool) -> Result<(), LocalSetupError> {
        self.execute(cancel, |args, deadline| {
            process::run(self, args, cancel, deadline)
        })
    }
    fn execute(
        &self,
        cancel: &AtomicBool,
        mut run: impl FnMut(&[&str], Instant) -> Result<Vec<u8>, LocalSetupError>,
    ) -> Result<(), LocalSetupError> {
        let deadline = Instant::now() + Duration::from_secs(20);
        check(cancel, deadline)?;
        self.current()?;
        let version = run(&["--version"], deadline)?;
        check(cancel, deadline)?;
        if version.len() > 4096
            || std::str::from_utf8(&version).map(str::trim).ok()
                != Some(format!("tmux-ide v{}", self.version).as_str())
        {
            return Err(LocalSetupError::Response);
        }
        self.current()?;
        check(cancel, deadline)?;
        let output = run(&["update", "--daemon", "--json"], deadline)?;
        check(cancel, deadline)?;
        if output.len() > 4096 {
            return Err(LocalSetupError::Response);
        }
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Ready {
            ok: bool,
            status: String,
            product_version: String,
            instance_id: String,
        }
        let ready: Ready =
            serde_json::from_slice(&output).map_err(|_| LocalSetupError::Response)?;
        if !ready.ok
            || ready.status != "ready"
            || ready.product_version != self.version
            || ready.instance_id.is_empty()
            || ready.instance_id.len() > 512
        {
            return Err(LocalSetupError::Response);
        }
        Ok(())
    }
    fn current(&self) -> Result<(), LocalSetupError> {
        if &resolve_local_setup(&self.home)? != self {
            return Err(LocalSetupError::Installation);
        }
        Ok(())
    }
}
fn check(cancel: &AtomicBool, deadline: Instant) -> Result<(), LocalSetupError> {
    if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
        Err(LocalSetupError::Stopped)
    } else {
        Ok(())
    }
}
fn directory(path: &Path) -> Result<(), LocalSetupError> {
    if fs::canonicalize(path)? != path || !fs::symlink_metadata(path)?.is_dir() {
        return Err(LocalSetupError::Installation);
    }
    Ok(())
}
fn regular(
    path: &Path,
    limit: Option<u64>,
    executable: bool,
) -> Result<(Stamp, Option<Vec<u8>>), LocalSetupError> {
    use rustix::fs::{Mode, OFlags, open};
    use std::{fs::File, io::Read, os::unix::fs::MetadataExt};
    if fs::canonicalize(path)? != path {
        return Err(LocalSetupError::Installation);
    }
    let mut file = File::from(
        open(
            path,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(std::io::Error::from)?,
    );
    let stamp = |m: fs::Metadata| -> Result<Stamp, LocalSetupError> {
        if !m.is_file()
            || m.uid() != rustix::process::getuid().as_raw()
            || m.mode() & 0o022 != 0
            || executable && m.mode() & 0o111 == 0
            || limit.is_some_and(|n| m.len() > n)
        {
            return Err(LocalSetupError::Installation);
        }
        Ok(Stamp {
            dev: m.dev(),
            ino: m.ino(),
            len: m.len(),
            mtime: m.mtime(),
            mtime_ns: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_ns: m.ctime_nsec(),
            mode: m.mode(),
        })
    };
    let before = stamp(file.metadata()?)?;
    let bytes = if let Some(limit) = limit {
        let mut bytes = Vec::new();
        file.by_ref().take(limit + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit {
            return Err(LocalSetupError::Installation);
        }
        Some(bytes)
    } else {
        None
    };
    if before != stamp(file.metadata()?)?
        || before != stamp(fs::symlink_metadata(path)?)?
        || fs::canonicalize(path)? != path
    {
        return Err(LocalSetupError::Installation);
    }
    Ok((before, bytes))
}
/// Exact managed layout only. Merely resolving never launches a process.
pub fn resolve_local_setup(home: &Path) -> Result<LocalSetupInstallation, LocalSetupError> {
    if !home.is_absolute() {
        return Err(LocalSetupError::Installation);
    }
    let home = fs::canonicalize(home)?;
    let root = home.join(".local/share/tmux-ide");
    if fs::symlink_metadata(&root).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Err(LocalSetupError::Missing);
    }
    directory(&root)?;
    let mut stamps = Vec::new();
    let (stamp, bytes) = regular(&root.join("installer-v1"), Some(16), false)?;
    if bytes.as_deref() != Some(b"1\n") {
        return Err(LocalSetupError::Installation);
    }
    stamps.push(stamp);
    let releases = root.join("releases");
    directory(&releases)?;
    let release = fs::canonicalize(root.join("current"))?;
    let name = release
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("install-"))
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_alphanumeric()));
    if release.parent() != Some(releases.as_path()) || name.is_none() {
        return Err(LocalSetupError::Installation);
    }
    directory(&release)?;
    let (stamp, bytes) = regular(&release.join(".installer-release-v1"), Some(16), false)?;
    if bytes.as_deref() != Some(b"1\n") {
        return Err(LocalSetupError::Installation);
    }
    stamps.push(stamp);
    let node = release.join("node/bin/node");
    let pkg = release.join("npm/lib/node_modules/tmux-ide");
    let cli = pkg.join("bin/cli.js");
    stamps.push(regular(&node, None, true)?.0);
    stamps.push(regular(&cli, None, false)?.0);
    let (stamp, bytes) = regular(&pkg.join("package.json"), Some(65536), false)?;
    stamps.push(stamp);
    let metadata: serde_json::Value =
        serde_json::from_slice(bytes.as_deref().ok_or(LocalSetupError::Installation)?)
            .map_err(|_| LocalSetupError::Installation)?;
    if metadata["name"] != "tmux-ide" || metadata["bin"]["tmux-ide"] != "bin/cli.js" {
        return Err(LocalSetupError::Installation);
    }
    let version = metadata["version"]
        .as_str()
        .ok_or(LocalSetupError::Installation)?
        .to_owned();
    if !matches!(
        version.as_str(),
        "2.9.6" | "2.9.7" | "2.9.8" | "2.9.9" | "2.9.10" | "2.9.11" | "2.9.12"
    ) {
        return Err(LocalSetupError::Unsupported);
    }
    Ok(LocalSetupInstallation {
        home,
        release,
        node,
        cli,
        version,
        stamps,
    })
}
#[cfg(test)]
#[path = "local_setup_live_tests.rs"]
mod live_tests;
#[path = "local_setup_process.rs"]
mod process;
#[cfg(test)]
#[path = "local_setup_tests.rs"]
mod tests;
