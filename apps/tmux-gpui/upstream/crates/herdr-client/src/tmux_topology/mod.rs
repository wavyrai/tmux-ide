//! Ordered daemon topology and coherent pane placement without a composed cell canvas.
mod presentation;
mod wire;
pub use presentation::{CopyRegion, Presentation, PresentedWindow, Region, WindowPaint};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::collections::{BTreeMap, BTreeSet};
pub use wire::{
    BorderStatus, DisplayNameSource, Layout, LayoutPane, ModeKeys, WindowLink, WindowLinks,
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid native terminal topology JSON")]
    Json(#[source] serde_json::Error),
    #[error("native terminal topology exceeds bounds")]
    Bounds,
    #[error("native terminal topology identity mismatch")]
    Identity,
    #[error("native terminal topology revision regressed")]
    Revision,
    #[error("native terminal topology is retired")]
    Retired,
}

pub struct Topology {
    generation: String,
    issued: BTreeSet<String>,
    layouts: BTreeMap<String, Layout>,
    links: Option<WindowLinks>,
    epoch: Option<u64>,
    retired: bool,
    awaiting_authority: bool,
}

impl Topology {
    pub fn new(generation: String, issued_panes: Vec<String>) -> Result<Self, Error> {
        if uuid::Uuid::parse_str(&generation).is_err()
            || issued_panes.is_empty()
            || issued_panes.len() > 24
            || issued_panes.iter().any(|pane| !wire::identity(pane))
        {
            return Err(Error::Identity);
        }
        let issued: BTreeSet<_> = issued_panes.iter().cloned().collect();
        if issued.len() != issued_panes.len() {
            return Err(Error::Identity);
        }
        Ok(Self {
            generation,
            issued,
            layouts: BTreeMap::new(),
            links: None,
            epoch: None,
            retired: false,
            awaiting_authority: false,
        })
    }

    pub fn layouts(&self) -> &BTreeMap<String, Layout> {
        &self.layouts
    }
    pub fn links(&self) -> Option<&WindowLinks> {
        self.links.as_ref()
    }
    pub fn epoch(&self) -> Option<u64> {
        self.epoch
    }
    pub fn awaiting_authority(&self) -> bool {
        self.awaiting_authority
    }
    pub fn retire(&mut self) {
        self.retired = true;
        self.layouts.clear();
        self.links = None;
        self.epoch = None;
    }

    /// Returns false for unrelated controls. Invalid topology retires this connection's topology.
    pub fn apply_control(&mut self, raw: &RawValue) -> Result<bool, Error> {
        let result = self.apply(raw);
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn apply(&mut self, raw: &RawValue) -> Result<bool, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        if raw.get().len() > 1024 * 1024 {
            return Err(Error::Bounds);
        }
        #[derive(Deserialize)]
        struct Kind<'a> {
            #[serde(rename = "type", borrow)]
            kind: &'a str,
        }
        let kind: Kind<'_> = serde_json::from_str(raw.get()).map_err(Error::Json)?;
        match kind.kind {
            "layout-snapshot" => {
                let snapshot: wire::LayoutSnapshot =
                    serde_json::from_str(raw.get()).map_err(Error::Json)?;
                snapshot.validate()?;
                if self
                    .epoch
                    .is_some_and(|epoch| snapshot.topology_epoch <= epoch)
                {
                    return Err(Error::Revision);
                }
                if let Some(old) = &self.links {
                    if old.live_session_id != snapshot.window_links.live_session_id
                        || snapshot.window_links.link_revision < old.link_revision
                    {
                        return Err(Error::Revision);
                    }
                    if snapshot.window_links.link_revision == old.link_revision {
                        fn members(links: &WindowLinks) -> BTreeMap<&str, (&str, u64)> {
                            links
                                .links
                                .iter()
                                .map(|link| {
                                    (
                                        link.link_id.as_str(),
                                        (link.semantic_window_id.as_str(), link.display_index),
                                    )
                                })
                                .collect()
                        }
                        if members(old) != members(&snapshot.window_links) {
                            return Err(Error::Revision);
                        }
                    }
                }
                self.awaiting_authority = false;
                self.epoch = Some(snapshot.topology_epoch);
                self.links = Some(snapshot.window_links);
                self.layouts = snapshot
                    .layouts
                    .into_iter()
                    .filter_map(|layout| layout.semantic_window_id.clone().map(|id| (id, layout)))
                    .collect();
                Ok(true)
            }
            "layout" => {
                let layout: Layout = serde_json::from_str(raw.get()).map_err(Error::Json)?;
                layout.validate()?;
                let Some(id) = layout.semantic_window_id.clone() else {
                    return Ok(true);
                };
                // Semantic streams publish atomic snapshots. An unversioned advisory
                // can race them and cannot replace newer authority or force a disconnect.
                if self.epoch.is_some() {
                    if self.layouts.get(&id) != Some(&layout) {
                        self.awaiting_authority = true;
                    }
                    return Ok(true);
                }
                if !self.layouts.contains_key(&id) && self.layouts.len() >= 24 {
                    return Err(Error::Bounds);
                }
                self.layouts.insert(id, layout);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// Advisory navigation only. A missing/ambiguous active pane is never invented.
    pub fn preferred_pane(&self) -> Option<&str> {
        let mut current = self.layouts.values().filter(|layout| layout.current_window);
        let layout = current.next()?;
        if current.next().is_some() {
            return None;
        }
        let mut active = layout.panes.iter().filter(|pane| pane.active);
        let pane = active.next()?.pane.as_deref()?;
        if active.next().is_some() || !self.issued.contains(pane) {
            return None;
        }
        (self
            .layouts
            .values()
            .flat_map(|layout| &layout.panes)
            .filter(|entry| entry.pane.as_deref() == Some(pane))
            .count()
            == 1)
            .then_some(pane)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod serde_tests;
