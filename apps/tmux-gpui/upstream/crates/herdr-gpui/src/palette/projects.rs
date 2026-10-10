//! Local project discovery and path validation run only on background workers.

use crate::{Error, Result};
use herdr_client::protocol::ClientShellSnapshot;
use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const MAX_VISITS: usize = 8192;
const MAX_PROJECTS: usize = 2048;

#[derive(Clone, Debug)]
pub(super) struct Project {
    pub(super) path: PathBuf,
    pub(super) label: String,
}

#[derive(Default)]
pub(super) struct Collection {
    pub(super) projects: Vec<Project>,
    pub(super) errors: Vec<Error>,
}

pub(super) struct Cancellation(pub(super) Arc<AtomicBool>);

impl Default for Cancellation {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn valid_path(path: &Path) -> Result<&str> {
    path.to_str()
        .filter(|text| {
            path.is_absolute() && text.len() <= 8192 && !text.chars().any(char::is_control)
        })
        .ok_or(Error::PaletteProjectPath)
}

/// Expand variables as path data, never as shell syntax. An unset variable is
/// an error rather than silently scanning a different directory.
fn expand(
    root: &str,
    get: impl Fn(&str) -> Option<OsString>,
    home: Option<&Path>,
) -> Result<PathBuf> {
    let mut expanded = OsString::new();
    let mut rest = root;
    if rest == "~" || rest.starts_with("~/") {
        expanded.push(home.ok_or(Error::MissingHome)?);
        rest = &rest[1..];
    }
    while let Some(index) = rest.find('$') {
        expanded.push(&rest[..index]);
        rest = &rest[index + 1..];
        let (name, consumed) = if let Some(braced) = rest.strip_prefix('{') {
            let end = braced.find('}').ok_or(Error::PaletteProjectPath)?;
            (&braced[..end], end + 2)
        } else {
            let end = rest
                .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
                .unwrap_or(rest.len());
            (&rest[..end], end)
        };
        if name.is_empty()
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            return Err(Error::PaletteProjectPath);
        }
        expanded.push(
            get(name)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| Error::PaletteProjectVariable(name.into()))?,
        );
        rest = &rest[consumed..];
    }
    expanded.push(rest);
    let path = PathBuf::from(expanded);
    valid_path(&path)?;
    Ok(path)
}

pub(super) fn collect(roots: &[String], cancelled: &AtomicBool) -> Collection {
    let home = crate::config::home().ok();
    let mut collection = Collection::default();
    let mut seen = HashSet::new();
    let mut visits = 0;
    for root in roots {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let result = (|| -> Result<()> {
            let root = expand(root, |name| std::env::var_os(name), home.as_deref())?;
            let root =
                fs::canonicalize(&root).map_err(|error| Error::from(error).at_path(&root))?;
            for entry in fs::read_dir(&root).map_err(|error| Error::from(error).at_path(&root))? {
                if cancelled.load(Ordering::Relaxed) {
                    break;
                }
                visits += 1;
                if visits > MAX_VISITS || collection.projects.len() >= MAX_PROJECTS {
                    return Err(Error::PaletteProjectLimit);
                }
                let entry = entry.map_err(|error| Error::from(error).at_path(&root))?;
                let name = entry.file_name();
                let Some(label) = name.to_str().filter(|name| !name.starts_with('.')) else {
                    continue;
                };
                // Symlinks are not followed: configured roots may be symlinks,
                // but discovery never escapes them through a child link.
                if !entry
                    .file_type()
                    .map_err(|error| Error::from(error).at_path(&entry.path()))?
                    .is_dir()
                {
                    continue;
                }
                let path = entry.path();
                valid_path(&path)?;
                if seen.insert(path.clone()) {
                    collection.projects.push(Project {
                        path,
                        label: label.into(),
                    });
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let limited = matches!(error, Error::PaletteProjectLimit);
            collection.errors.push(error);
            if limited {
                break;
            }
        }
    }
    collection
        .projects
        .sort_by_cached_key(|project| (project.label.to_lowercase(), project.path.clone()));
    collection
}

pub(super) fn validate(project: &Project) -> Result<()> {
    valid_path(&project.path)?;
    let path = fs::canonicalize(&project.path)
        .map_err(|error| Error::from(error).at_path(&project.path))?;
    if path != project.path || !path.is_dir() {
        return Err(Error::PaletteProjectRemoved);
    }
    Ok(())
}

/// The first surviving pane in the first tab supplies the launch directory.
/// Snapshots have no original-root identity; never infer one from opaque IDs
/// or substitute a foreground process directory.
pub(super) fn workspace_for_path(snapshot: &ClientShellSnapshot, path: &Path) -> Option<String> {
    workspace_roots(snapshot)
        .into_iter()
        .find_map(|(workspace, cwd)| {
            let cwd = Path::new(&cwd);
            (cwd.is_absolute() && fs::canonicalize(cwd).is_ok_and(|cwd| cwd == path))
                .then_some(workspace)
        })
}

pub(super) fn workspace_roots(snapshot: &ClientShellSnapshot) -> Vec<(String, String)> {
    snapshot
        .workspaces
        .iter()
        .filter_map(|workspace| {
            Some((
                workspace.workspace_id.clone(),
                launch_root(snapshot, &workspace.workspace_id)?.to_owned(),
            ))
        })
        .collect()
}

pub(super) fn launch_root<'a>(
    snapshot: &'a ClientShellSnapshot,
    workspace: &str,
) -> Option<&'a str> {
    let tab = snapshot
        .tabs
        .iter()
        .filter(|tab| tab.workspace_id == workspace)
        .min_by_key(|tab| tab.number)?;
    snapshot
        .panes
        .iter()
        .find(|pane| pane.workspace_id == workspace && pane.tab_id == tab.tab_id)?
        .cwd
        .as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_paths_without_shell_execution_and_rejects_unset_variables() -> anyhow::Result<()> {
        let root = if cfg!(windows) {
            "C:/projects"
        } else {
            "/projects"
        };
        let home = if cfg!(windows) {
            "C:/Users/me"
        } else {
            "/home/me"
        };
        let get = |name: &str| (name == "ROOT").then(|| OsString::from(root));
        assert_eq!(
            expand("$ROOT/work", get, None)?,
            Path::new(root).join("work")
        );
        assert_eq!(
            expand("${ROOT}/work", get, None)?,
            Path::new(root).join("work")
        );
        assert_eq!(
            expand("~/work", get, Some(Path::new(home)))?,
            Path::new(home).join("work")
        );
        assert!(matches!(
            expand("$MISSING/work", get, None),
            Err(Error::PaletteProjectVariable(_))
        ));
        assert!(matches!(
            expand("relative", get, None),
            Err(Error::PaletteProjectPath)
        ));
        assert!(expand("${ROOT", get, None).is_err());
        assert!(expand("$(touch x)", get, None).is_err());
        Ok(())
    }

    #[test]
    fn discovers_only_immediate_visible_folders_and_deduplicates_roots() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        fs::create_dir_all(root.path().join("alpha/nested"))?;
        fs::create_dir(root.path().join(".hidden"))?;
        fs::write(root.path().join("file"), "")?;
        let missing = root.path().join("missing").to_string_lossy().into_owned();
        let name = root.path().to_string_lossy().into_owned();
        let result = collect(&[missing, name.clone(), name], &AtomicBool::new(false));
        assert_eq!(result.projects.len(), 1);
        assert_eq!(result.projects[0].label, "alpha");
        assert_eq!(result.errors.len(), 1);
        use std::error::Error as _;
        assert!(result.errors[0].source().is_some());
        validate(&result.projects[0])?;
        let cancelled = collect(
            &[root.path().to_string_lossy().into_owned()],
            &AtomicBool::new(true),
        );
        assert!(cancelled.projects.is_empty());
        Ok(())
    }

    #[test]
    fn limits_filesystem_work() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        for index in 0..=MAX_PROJECTS {
            fs::create_dir(root.path().join(format!("project-{index}")))?;
        }
        let result = collect(
            &[root.path().to_string_lossy().into_owned()],
            &AtomicBool::new(false),
        );
        assert_eq!(result.projects.len(), MAX_PROJECTS);
        assert!(matches!(
            result.errors.as_slice(),
            [Error::PaletteProjectLimit]
        ));
        Ok(())
    }

    #[test]
    fn matches_only_the_root_panes_launch_directory() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let path = fs::canonicalize(root.path())?;
        let nested = path.join("nested");
        fs::create_dir(&nested)?;
        let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
            "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))?;
        snapshot.panes[0].cwd = Some(path.to_string_lossy().into_owned());
        snapshot.panes[0].foreground_cwd = Some(nested.to_string_lossy().into_owned());
        assert_eq!(workspace_for_path(&snapshot, &path), Some("w1".into()));
        assert_eq!(workspace_for_path(&snapshot, &nested), None);
        let mut split = snapshot.panes[0].clone();
        split.pane_id = "split".into();
        split.cwd = Some(nested.to_string_lossy().into_owned());
        snapshot.panes.push(split);
        assert_eq!(workspace_for_path(&snapshot, &nested), None);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn skips_child_symlinks_and_rejects_a_replaced_directory() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        std::os::unix::fs::symlink(outside.path(), root.path().join("link"))?;
        let path = root.path().join("project");
        fs::create_dir(&path)?;
        let result = collect(
            &[root.path().to_string_lossy().into_owned()],
            &AtomicBool::new(false),
        );
        assert_eq!(result.projects.len(), 1);
        fs::remove_dir(&path)?;
        std::os::unix::fs::symlink(outside.path(), &path)?;
        assert!(matches!(
            validate(&result.projects[0]),
            Err(Error::PaletteProjectRemoved)
        ));
        Ok(())
    }
}
