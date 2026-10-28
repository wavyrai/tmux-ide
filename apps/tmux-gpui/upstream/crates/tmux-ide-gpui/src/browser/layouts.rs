//! Saved editor group layouts: how each workspace's view was split, which
//! tab each group showed, and the group in use, kept across restarts. The
//! app keeps one per workspace of each daemon; a window restores it the
//! first time it shows that workspace, and saves it whenever it changes.
use super::{Scope, groups::SavedLayout};
use crate::state_file;
use gpui::{App, Global};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

const MAX_LAYOUTS: usize = 256;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// The workspace a layout belongs to.
pub(crate) type Key = (Scope, String);

#[derive(Serialize, Deserialize)]
struct Entry {
    scope: Scope,
    workspace: String,
    layout: SavedLayout,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    layouts: Vec<Entry>,
}

#[derive(Default)]
pub(crate) struct Layouts {
    layouts: HashMap<Key, SavedLayout>,
    writer: Option<state_file::Writer<Saved>>,
    quitting: bool,
}

impl Global for Layouts {}

fn valid_workspace(workspace: &str) -> bool {
    !workspace.is_empty() && workspace.len() <= 256
}

fn parse(bytes: &[u8]) -> crate::Result<HashMap<Key, SavedLayout>> {
    let saved: Saved = serde_json::from_slice(bytes)?;
    if saved.layouts.len() > MAX_LAYOUTS
        || !saved
            .layouts
            .iter()
            .all(|entry| valid_workspace(&entry.workspace) && entry.layout.valid())
    {
        return Err(crate::Error::InvalidGroupLayouts);
    }
    Ok(saved
        .layouts
        .into_iter()
        .map(|entry| ((entry.scope, entry.workspace), entry.layout))
        .collect())
}

impl Layouts {
    fn path() -> Option<PathBuf> {
        crate::preferences::state_dir().map(|dir| dir.join("editor-groups.json"))
    }

    /// Called before starting GPUI, like the browser tabs. A missing or
    /// damaged file starts every workspace unsplit.
    pub(crate) fn load() -> Self {
        let path = Self::path();
        let layouts = path
            .as_deref()
            .map(|path| {
                state_file::read(path, MAX_FILE_BYTES)
                    .and_then(|bytes| bytes.as_deref().map_or(Ok(HashMap::new()), parse))
            })
            .transpose()
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "Cannot restore editor groups");
                None
            })
            .unwrap_or_default();
        let writer = path.and_then(
            |path| match state_file::Writer::start("editor-groups", path) {
                Ok(writer) => Some(writer),
                Err(error) => {
                    tracing::warn!(%error, "Cannot start editor group worker");
                    None
                }
            },
        );
        Self {
            layouts,
            writer,
            quitting: false,
        }
    }

    pub(crate) fn install(self, cx: &mut App) {
        cx.set_global(self);
        cx.on_app_quit(|cx| {
            let layouts = cx.global_mut::<Self>();
            layouts.quitting = true;
            let writer = layouts.writer.take();
            cx.background_executor().spawn(async move {
                if let Some(writer) = writer {
                    writer.finish();
                }
            })
        })
        .detach();
    }

    /// Every saved layout, for a new window to restore from.
    pub(crate) fn snapshot(cx: &App) -> HashMap<Key, SavedLayout> {
        cx.try_global::<Self>()
            .map(|layouts| layouts.layouts.clone())
            .unwrap_or_default()
    }

    /// Records `layout` for `key`; `None` forgets it. Writes only a change,
    /// and reads before claiming the global so an unchanged layout wakes
    /// nothing.
    pub(crate) fn record(cx: &mut App, key: &Key, layout: Option<SavedLayout>) {
        let unchanged = cx.try_global::<Self>().map_or(layout.is_none(), |layouts| {
            layouts.layouts.get(key) == layout.as_ref()
        });
        if unchanged {
            return;
        }
        if !cx.has_global::<Self>() {
            cx.set_global(Self::default());
        }
        let layouts = cx.global_mut::<Self>();
        match layout {
            Some(layout)
                if layouts.layouts.len() < MAX_LAYOUTS || layouts.layouts.contains_key(key) =>
            {
                layouts.layouts.insert(key.clone(), layout);
            }
            Some(_) => return,
            None => {
                layouts.layouts.remove(key);
            }
        }
        layouts.save();
    }

    /// Forgets the layouts of workspaces the daemon closed.
    pub(crate) fn forget_workspaces(cx: &mut App, scope: &Scope, closed: &[String]) {
        let Some(layouts) = cx.try_global::<Self>() else {
            return;
        };
        if !layouts
            .layouts
            .keys()
            .any(|(saved, workspace)| saved == scope && closed.contains(workspace))
        {
            return;
        }
        let layouts = cx.global_mut::<Self>();
        layouts
            .layouts
            .retain(|(saved, workspace), _| saved != scope || !closed.contains(workspace));
        layouts.save();
    }

    fn save(&self) {
        if self.quitting {
            return;
        }
        if let Some(writer) = &self.writer {
            writer.save(Saved {
                layouts: self
                    .layouts
                    .iter()
                    .map(|((scope, workspace), layout)| Entry {
                        scope: scope.clone(),
                        workspace: workspace.clone(),
                        layout: layout.clone(),
                    })
                    .collect(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn saved_layouts_round_trip_and_damaged_files_are_refused() {
        let layout = r#"{"groups":[{"pick":null,"share":0.5},{"pick":{"kind":"page","id":3},"share":0.5}],"active":1}"#;
        let file = format!(
            r#"{{"layouts":[{{"scope":"local:/x.sock","workspace":"w1","layout":{layout}}}]}}"#
        );
        let parsed = parse(file.as_bytes()).unwrap();
        let key = (Scope::local("/x.sock".as_ref()), "w1".to_owned());
        let saved = parsed.get(&key).unwrap();
        assert_eq!(serde_json::to_string(saved).unwrap(), layout);
        let bytes = serde_json::to_vec(&Saved {
            layouts: vec![Entry {
                scope: key.0.clone(),
                workspace: key.1.clone(),
                layout: saved.clone(),
            }],
        })
        .unwrap();
        assert_eq!(parse(&bytes).unwrap(), parsed);
        for invalid in [
            r#"{"layouts":[{"scope":"s","workspace":"","layout":{"groups":[{"pick":null,"share":1}],"active":0}}]}"#,
            r#"{"layouts":[{"scope":"s","workspace":"w","layout":{"groups":[],"active":0}}]}"#,
            r#"{"layouts":[{"scope":"s","workspace":"w","layout":{"groups":[{"pick":{"kind":"file","id":"x"},"share":1}],"active":0}}]}"#,
            r#"{"layouts":"#,
        ] {
            assert!(parse(invalid.as_bytes()).is_err(), "{invalid}");
        }
    }

    #[gpui::test]
    fn records_write_changes_only_and_closed_workspaces_are_forgotten(
        cx: &mut gpui::TestAppContext,
    ) {
        let layout: SavedLayout =
            serde_json::from_str(r#"{"groups":[{"pick":null,"share":1}],"active":0}"#).unwrap();
        let scope = Scope::endpoint("local");
        let (one, two) = (
            (scope.clone(), "w1".to_owned()),
            (Scope::endpoint("ssh:box"), "w1".to_owned()),
        );
        cx.update(|cx| {
            // Forgetting what was never saved claims nothing.
            Layouts::record(cx, &one, None);
            assert!(!cx.has_global::<Layouts>());
            Layouts::record(cx, &one, Some(layout.clone()));
            Layouts::record(cx, &two, Some(layout.clone()));
            assert_eq!(Layouts::snapshot(cx).len(), 2);
            Layouts::forget_workspaces(cx, &scope, &["w1".to_owned()]);
            let left = Layouts::snapshot(cx);
            assert!(!left.contains_key(&one) && left.contains_key(&two));
            Layouts::record(cx, &two, None);
            assert!(Layouts::snapshot(cx).is_empty());
        });
    }
}
