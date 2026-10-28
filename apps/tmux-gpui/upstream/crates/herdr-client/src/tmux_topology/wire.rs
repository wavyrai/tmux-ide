use super::Error;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
const SAFE: u64 = (1_u64 << 53) - 1;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BorderStatus {
    Top,
    Bottom,
    #[default]
    Off,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModeKeys {
    Emacs,
    Vi,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DisplayNameSource {
    Manual,
    Agent,
    Process,
    Title,
    Generated,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutPane {
    pub pane: Option<String>,
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_icon: Option<String>,
    pub display_name_source: Option<DisplayNameSource>,
    pub left: usize,
    pub top: usize,
    pub width: usize,
    pub height: usize,
    pub active: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    #[serde(rename = "type")]
    kind: String,
    pub semantic_window_id: Option<String>,
    pub window_name: Option<String>,
    pub current_window: bool,
    pub cols: usize,
    pub rows: usize,
    pub zoomed: bool,
    #[serde(default)]
    pub pane_border_status: BorderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_keys: Option<ModeKeys>,
    pub panes: Vec<LayoutPane>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowLink {
    pub link_id: String,
    pub semantic_window_id: String,
    pub display_index: u64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowLinks {
    pub live_session_id: String,
    pub link_revision: u64,
    pub active_link_id: String,
    pub links: Vec<WindowLink>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LayoutSnapshot {
    #[serde(rename = "type")]
    kind: String,
    pub topology_epoch: u64,
    pub layouts: Vec<Layout>,
    pub window_links: WindowLinks,
}

pub(super) fn identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !matches!(value, "__proto__" | "prototype" | "constructor")
        && !value.starts_with("terminal.discovered.")
}
fn display(value: &str) -> bool {
    value.encode_utf16().count() <= 256 && !value.contains(['\0', '\r', '\n'])
}
fn opaque(value: &str, prefix: &str, length: usize) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == length
            && suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
impl Layout {
    pub(super) fn validate(&self) -> Result<(), Error> {
        if self.kind != "layout"
            || self
                .semantic_window_id
                .as_ref()
                .is_some_and(|id| !identity(id))
            || self.window_name.as_ref().is_some_and(|name| !display(name))
        {
            return Err(Error::Identity);
        }
        if !(1..=4096).contains(&self.cols)
            || !(1..=4096).contains(&self.rows)
            || self.panes.len() > 64
        {
            return Err(Error::Bounds);
        }
        for pane in &self.panes {
            if pane.browser_icon.as_ref().is_some_and(|icon| {
                !icon.is_empty()
                    && (icon.len() != 2048
                        || !icon
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            }) {
                return Err(Error::Bounds);
            }
            if pane.pane.as_ref().is_some_and(|id| !identity(id))
                || pane
                    .display_name
                    .as_ref()
                    .is_some_and(|name| !display(name))
            {
                return Err(Error::Identity);
            }
            if pane.left > 4096
                || pane.top > 4096
                || !(1..=4096).contains(&pane.width)
                || !(1..=4096).contains(&pane.height)
            {
                return Err(Error::Bounds);
            }
        }
        Ok(())
    }
    pub fn content_rect(&self, pane: &LayoutPane) -> (usize, usize) {
        let top = self.pane_border_status == BorderStatus::Top && pane.top == 0;
        let bottom =
            self.pane_border_status == BorderStatus::Bottom && pane.top + pane.height == self.rows;
        (
            pane.top + usize::from(top),
            pane.height.saturating_sub(usize::from(top || bottom)),
        )
    }
}
impl LayoutSnapshot {
    pub(super) fn validate(&self) -> Result<(), Error> {
        if self.kind != "layout-snapshot"
            || self.topology_epoch > SAFE
            || self.layouts.is_empty()
            || self.layouts.len() > 24
        {
            return Err(Error::Bounds);
        }
        let mut windows = BTreeMap::new();
        let mut panes = BTreeSet::new();
        let mut currents = 0;
        for layout in &self.layouts {
            layout.validate()?;
            let id = layout
                .semantic_window_id
                .as_deref()
                .ok_or(Error::Identity)?;
            if windows.insert(id, layout).is_some() {
                return Err(Error::Identity);
            }
            currents += usize::from(layout.current_window);
            for pane in &layout.panes {
                if !panes.insert(pane.pane.as_deref().ok_or(Error::Identity)?) {
                    return Err(Error::Identity);
                }
            }
        }
        if currents != 1 {
            return Err(Error::Identity);
        }
        let links = &self.window_links;
        if !opaque(&links.live_session_id, "live-session.", 20)
            || links.link_revision > SAFE
            || !opaque(&links.active_link_id, "window-link.", 32)
            || links.links.is_empty()
            || links.links.len() > 256
        {
            return Err(Error::Identity);
        }
        let mut ids = BTreeSet::new();
        let mut indexes = BTreeSet::new();
        let mut linked = BTreeSet::new();
        for link in &links.links {
            if !opaque(&link.link_id, "window-link.", 32)
                || !identity(&link.semantic_window_id)
                || link.display_index > SAFE
                || !ids.insert(&link.link_id)
                || !indexes.insert(link.display_index)
            {
                return Err(Error::Identity);
            }
            let layout = windows
                .get(link.semantic_window_id.as_str())
                .ok_or(Error::Identity)?;
            if link.link_id == links.active_link_id && !layout.current_window {
                return Err(Error::Identity);
            }
            linked.insert(link.semantic_window_id.as_str());
        }
        if !ids.contains(&links.active_link_id) || linked.len() != windows.len() {
            return Err(Error::Identity);
        }
        Ok(())
    }
}
