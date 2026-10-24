use super::*;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitTarget {
    pub window: WindowLink,
    pub layout_id: String,
    pub split_id: String,
    pub boundary: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitPane {
    pub semantic_pane_id: String,
    pub left: u16,
    pub top: u16,
    pub width: u16,
    pub height: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitBoundary {
    pub split_id: String,
    pub axis: Axis,
    pub boundary: u16,
    pub start: u16,
    pub length: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitLayout {
    pub version: u8,
    pub window: WindowLink,
    pub layout_id: String,
    pub cols: u16,
    pub rows: u16,
    pub panes: Vec<SplitPane>,
    pub splits: Vec<SplitBoundary>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitSuccessor {
    pub resource: SplitLayout,
    pub split_id: String,
}
impl SplitTarget {
    pub fn validate(&self) -> Result<()> {
        if !intent::valid_link(&self.window)
            || !uuid(&self.layout_id)
            || !uuid(&self.split_id)
            || self.boundary > 4096
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
impl SplitLayout {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || !intent::valid_link(&self.window)
            || !uuid(&self.layout_id)
            || !(1..=4096).contains(&self.cols)
            || !(1..=4096).contains(&self.rows)
            || self.panes.is_empty()
            || self.panes.len() > 256
            || self.splits.len() > 255
        {
            return Err(Error::Invalid);
        }
        let mut seen = std::collections::BTreeSet::new();
        for p in &self.panes {
            if !pane(&p.semantic_pane_id)
                || !seen.insert(&p.semantic_pane_id)
                || p.left > 4095
                || p.top > 4095
                || !(1..=4096).contains(&p.width)
                || !(1..=4096).contains(&p.height)
                || u32::from(p.left) + u32::from(p.width) > u32::from(self.cols)
                || u32::from(p.top) + u32::from(p.height) > u32::from(self.rows)
            {
                return Err(Error::Invalid);
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        for s in &self.splits {
            let (limit, cross) = match s.axis {
                Axis::Cols => (self.cols, self.rows),
                Axis::Rows => (self.rows, self.cols),
            };
            if !uuid(&s.split_id)
                || !seen.insert(&s.split_id)
                || s.boundary == 0
                || s.boundary >= limit
                || s.start > 4095
                || !(1..=4096).contains(&s.length)
                || u32::from(s.start) + u32::from(s.length) > u32::from(cross)
            {
                return Err(Error::Invalid);
            }
        }
        Ok(())
    }
}
impl SplitSuccessor {
    pub fn validate(&self) -> Result<()> {
        self.resource.validate()?;
        if !uuid(&self.split_id)
            || !self
                .resource
                .splits
                .iter()
                .any(|s| s.split_id == self.split_id)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
impl Policy {
    /// Ordered observed topology only; receipts are never installed as observations.
    pub fn bind_split_layout(
        &mut self,
        lifetime: &str,
        window: WindowLink,
        resource: Option<SplitLayout>,
    ) -> Result<()> {
        self.check()?;
        if !identity(lifetime, 512) || !intent::valid_link(&window) {
            return Err(Error::Invalid);
        }
        if let Some(resource) = resource {
            resource.validate()?;
            if resource.window != window {
                return Err(Error::Invalid);
            }
            self.split_layout = Some((lifetime.into(), resource));
        } else {
            self.split_layout = None;
        }
        self.split_scope = Some((lifetime.into(), window));
        Ok(())
    }
}
