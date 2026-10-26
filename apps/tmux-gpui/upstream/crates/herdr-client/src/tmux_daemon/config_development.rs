use super::*;
use sha2::{Digest, Sha256};
pub(super) struct Development {
    root: PathBuf,
    state: PathBuf,
    runtime: PathBuf,
}
#[cfg(unix)]
fn private_directory(path: &Path, private: &Path) -> Option<()> {
    use std::os::unix::fs::MetadataExt;
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return None;
    }
    for cursor in path.ancestors() {
        match fs::symlink_metadata(cursor) {
            Ok(m) => {
                if !m.is_dir() || m.file_type().is_symlink() {
                    return None;
                }
                if cursor.starts_with(private)
                    && (m.uid() != rustix::process::getuid().as_raw() || m.mode() & 0o077 != 0)
                {
                    return None;
                }
                if m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0) {
                    return None;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }
    Some(())
}
#[cfg(not(unix))]
fn private_directory(_: &Path, _: &Path) -> Option<()> {
    None
}
pub(super) fn resolve(ns: &LocalConfigNamespace) -> Option<Development> {
    let worktree = Path::new(ns.raw("TMUX_IDE_DEVELOPMENT_WORKTREE")?);
    if !worktree.is_absolute() {
        return None;
    }
    let worktree = fs::canonicalize(worktree).ok()?;
    if !fs::metadata(&worktree).ok()?.is_dir() {
        return None;
    }
    let name = ns.raw("TMUX_IDE_DEVELOPMENT_NAME").unwrap_or("");
    if !name.is_empty() && !identifier(name, 48, false) {
        return None;
    }
    let supplied = Path::new(ns.raw("TMUX_IDE_DEVELOPMENT_STORE")?);
    if !supplied.is_absolute() {
        return None;
    }
    let supplied = absolute(supplied, &ns.cwd)?;
    if fs::symlink_metadata(&supplied).is_ok_and(|m| m.file_type().is_symlink()) {
        return None;
    }
    let store = identity(&supplied)?;
    let canonical = fs::canonicalize(&ns.home).ok()?.join(".tmux-ide");
    if supplied.starts_with(&canonical) || within(&store, &canonical)? {
        return None;
    }
    let parts: Vec<_> = store.components().map(|c| c.as_os_str().to_str()).collect();
    if parts.windows(2).any(|p| {
        p[0] == Some("instances")
            && p[1].is_some_and(|s| {
                s.strip_prefix("dev-").is_some_and(|v| {
                    v.len() == 24
                        && v.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            })
    }) {
        return None;
    }
    let tuple = serde_json::to_vec(&["tmux-ide-development-v1", worktree.to_str()?, name]).ok()?;
    let digest: String = Sha256::digest(tuple)[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let id = format!("dev-{digest}");
    let root = store.join("instances").join(&id);
    let state = root.join("state");
    #[cfg(unix)]
    let runtime_root = fs::canonicalize("/tmp")
        .ok()?
        .join(format!("ti-dev-{}", rustix::process::getuid().as_raw()));
    #[cfg(not(unix))]
    let runtime_root = PathBuf::new();
    let runtime = runtime_root.join(&id);
    private_directory(&root, &store)?;
    private_directory(&state, &store)?;
    private_directory(&runtime, &runtime_root)?;
    if runtime.join("control.sock").to_str()?.len() > 100 {
        return None;
    }
    if ns.raw("TMUX_IDE_DEVELOPMENT_ID") != Some(id.as_str())
        || ns.raw("TMUX_IDE_RUNTIME_DIR") != runtime.to_str()
        || ns.value("TMUX_IDE_HOME") != state.to_str()
        || ns.raw("TMUX_IDE_REGISTRY_DIR") != state.to_str()
        || ns.raw("TMUX_IDE_DAEMON_INFO_DIR") != state.to_str()
        || ns.raw("TMUX_IDE_TMUX_SOCKET_PATH") != runtime.join("tmux.sock").to_str()
        || ns.value("TMUX_IDE_TMUX_SOCKET_NAME").is_some()
    {
        return None;
    }
    if ns.env.iter().any(|(k, v)| {
        !v.is_empty()
            && [
                "TMUX_IDE_TESTDRIVE_",
                "TMUX_IDE_CARD5_",
                "TMUX_IDE_PERFORMANCE_",
            ]
            .iter()
            .any(|p| k.starts_with(p))
    }) {
        return None;
    }
    Some(Development {
        root,
        state,
        runtime,
    })
}
impl Development {
    pub(super) fn validate_scoped(&self, ns: &LocalConfigNamespace, config: &Path) -> Option<()> {
        let check = |p: &Path| -> Option<()> {
            if !p.is_absolute() || !within(p, &self.root)? {
                None
            } else {
                Some(())
            }
        };
        check(config)?;
        let integration = self.state.join("integrations");
        let claude = ns
            .value("TMUX_IDE_CLAUDE_DIR")
            .map_or_else(|| integration.join(".claude"), PathBuf::from);
        for (key, fallback, raw) in [
            ("TMUX_IDE_SETTINGS_DIR", self.state.clone(), true),
            ("TMUX_IDE_CLAUDE_DIR", claude.clone(), false),
            (
                "TMUX_IDE_CLAUDE_SETTINGS",
                claude.join("settings.json"),
                false,
            ),
            (
                "TMUX_IDE_CLAUDE_HOOK_PATH",
                self.state.join("hooks/claude-state.sh"),
                false,
            ),
            (
                "TMUX_IDE_OPENCODE_DIR",
                integration.join("opencode/plugin"),
                false,
            ),
        ] {
            check(&if raw { ns.raw(key) } else { ns.value(key) }.map_or(fallback, PathBuf::from))?;
        }
        for key in [
            "TMUX_IDE_TUI_LOG",
            "TMUX_IDE_TUI_PERF_LOG",
            "TMUX_IDE_SESSION_RUNTIME_TRACE_LOG",
            "TMUX_IDE_TEMPLATES_DIR",
            "TMUX_IDE_CODEX_SESSIONS",
            "TMUX_IDE_CURSOR_CHATS",
            "TMUX_IDE_HOME_OVERRIDE",
        ] {
            if let Some(p) = ns.value(key) {
                check(Path::new(p))?;
            }
        }
        if let Some(tmux) = ns.raw("TMUX").filter(|s| !s.is_empty()) {
            let mut parts = tmux.rsplitn(3, ',');
            for _ in 0..2 {
                let value = parts.next()?;
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
            }
            let socket = absolute(Path::new(parts.next()?), &ns.cwd)?;
            if identity(&socket)? != identity(&self.runtime.join("tmux.sock"))? {
                return None;
            }
        }
        Some(())
    }
}
