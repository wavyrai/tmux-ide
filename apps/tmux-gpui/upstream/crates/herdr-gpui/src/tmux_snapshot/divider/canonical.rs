//! Daemon-issued ancestry handles. Rectangles validate presentation, never infer ancestry.
use super::*;
use herdr_client::protocol::FrameData;
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Window {
    pub live_session_id: String,
    pub link_id: String,
    pub expected_semantic_window_id: String,
    pub link_revision: u64,
}
fn hex_id(value: &str, prefix: &str, length: usize) -> bool {
    value.strip_prefix(prefix).is_some_and(|s| {
        s.len() == length
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn uuid(value: &str) -> bool {
    value.len() == 36 && uuid::Uuid::parse_str(value).is_ok()
}
fn identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}
impl Window {
    fn valid(&self) -> bool {
        hex_id(&self.live_session_id, "live-session.", 20)
            && hex_id(&self.link_id, "window-link.", 32)
            && identity(&self.expected_semantic_window_id)
            && self.link_revision <= 9_007_199_254_740_991
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Target {
    pub window: Window,
    pub layout_id: String,
    pub split_id: String,
    pub boundary: u16,
}
impl Target {
    fn valid(&self) -> bool {
        self.window.valid()
            && uuid(&self.layout_id)
            && uuid(&self.split_id)
            && self.boundary <= 4096
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Pane {
    pub semantic_pane_id: String,
    pub left: u16,
    pub top: u16,
    pub width: u16,
    pub height: u16,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Edge {
    pub split_id: String,
    pub axis: Axis,
    pub boundary: u16,
    pub start: u16,
    pub length: u16,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Layout {
    pub version: u8,
    pub window: Window,
    pub layout_id: String,
    pub cols: u16,
    pub rows: u16,
    pub panes: Vec<Pane>,
    pub splits: Vec<Edge>,
}
impl Layout {
    pub fn valid(&self) -> bool {
        let mut panes = HashSet::new();
        let mut splits = HashSet::new();
        self.version == 1
            && self.window.valid()
            && uuid(&self.layout_id)
            && (1..=4096).contains(&self.cols)
            && (1..=4096).contains(&self.rows)
            && !self.panes.is_empty()
            && self.panes.len() <= 256
            && self.splits.len() <= 255
            && self.panes.iter().all(|p| {
                identity(&p.semantic_pane_id)
                    && panes.insert(&p.semantic_pane_id)
                    && p.width > 0
                    && p.height > 0
                    && u32::from(p.left) + u32::from(p.width) <= u32::from(self.cols)
                    && u32::from(p.top) + u32::from(p.height) <= u32::from(self.rows)
            })
            && self.splits.iter().all(|s| {
                let (axis, cross) = if s.axis == Axis::Cols {
                    (self.cols, self.rows)
                } else {
                    (self.rows, self.cols)
                };
                uuid(&s.split_id)
                    && splits.insert(&s.split_id)
                    && s.boundary > 0
                    && s.boundary < axis
                    && s.length > 0
                    && u32::from(s.start) + u32::from(s.length) <= u32::from(cross)
            })
    }
    pub fn matches(
        &self,
        frame: Option<&FrameData>,
        regions: &[hit_regions::Region],
        choices: &[browser::Choice],
        session: Option<&str>,
        selected: Option<&str>,
    ) -> bool {
        self.valid()
            && session == Some(self.window.live_session_id.as_str())
            && frame.is_some_and(|f| f.width == self.cols && f.height == self.rows)
            && hit_regions::valid(regions, frame, choices)
            && self.panes.len() == regions.len()
            && self.panes.iter().all(|p| {
                regions.iter().any(|r| {
                    r.id == p.semantic_pane_id
                        && r.left == p.left
                        && r.top == p.top
                        && r.width == p.width
                        && r.height == p.height
                })
            })
            && choices.iter().any(|p| {
                Some(p.id.as_str()) == selected
                    && p.window_id.as_deref()
                        == Some(self.window.expected_semantic_window_id.as_str())
            })
    }
    pub fn contains(&self, target: &Target, axis: Axis) -> bool {
        self.window == target.window
            && self.layout_id == target.layout_id
            && self.splits.iter().any(|s| {
                s.split_id == target.split_id && s.axis == axis && s.boundary == target.boundary
            })
    }
    pub fn target(&self, edge: &Edge) -> Target {
        Target {
            window: self.window.clone(),
            layout_id: self.layout_id.clone(),
            split_id: edge.split_id.clone(),
            boundary: edge.boundary,
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::tmux_snapshot) struct Ack {
    pub gesture: String,
    pub phase: gesture::Phase,
    pub revision: u64,
    pub boundary: u16,
    pub target: Option<Target>,
}
impl Ack {
    pub fn valid(&self) -> bool {
        uuid(&self.gesture)
            && self.revision <= 9_007_199_254_740_991
            && self.boundary <= 4096
            && self
                .target
                .as_ref()
                .is_none_or(|t| t.valid() && t.boundary == self.boundary)
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum Update {
    Begin { target: Target, axis: Axis },
    Move { boundary: u16 },
    Release { boundary: u16 },
    Cancel,
}
/// The hit/guide cell must be unused, unstyled, and outside every pane rectangle.
pub(super) fn safe_cell(state: &browser::State, col: u16, row: u16) -> bool {
    let Some(frame) = state.frame.as_ref() else {
        return false;
    };
    col < frame.width
        && row < frame.height
        && frame.graphics.is_empty()
        && !state.regions.iter().any(|r| {
            col >= r.left
                && u32::from(col) < u32::from(r.left) + u32::from(r.width)
                && row >= r.top
                && u32::from(row) < u32::from(r.top) + u32::from(r.height)
        })
        && frame
            .cells
            .get(usize::from(row) * usize::from(frame.width) + usize::from(col))
            .is_some_and(|c| {
                matches!(c.symbol.as_str(), "" | " ")
                    && !c.skip
                    && c.modifier == 0
                    && c.fg == 0
                    && c.bg == 0
                    && c.hyperlink.is_none()
            })
}

pub(super) fn guides(
    state: &browser::State,
    width: f32,
    selected: Option<&str>,
    accent: u32,
) -> Vec<AnyElement> {
    let mut result = Vec::new();
    for (index, split) in splits(state).into_iter().enumerate() {
        let mut run = None;
        for cross in split.start..=split.start + split.span {
            let (col, row) = if split.axis == Axis::Cols {
                (split.edge, cross)
            } else {
                (cross, split.edge)
            };
            let safe = cross < split.start + split.span
                && safe_cell(state, col, row)
                && state.split_layout.as_ref().is_some_and(|layout| {
                    layout
                        .splits
                        .iter()
                        .filter(|other| {
                            let (along, across) = if other.axis == Axis::Cols {
                                (col, row)
                            } else {
                                (row, col)
                            };
                            along == other.boundary
                                && across >= other.start
                                && across < other.start + other.length
                        })
                        .count()
                        == 1
                });
            if safe {
                run.get_or_insert(cross);
            } else if let Some(start) = run.take() {
                let (left, top, cols, rows) = if split.axis == Axis::Cols {
                    (split.edge, start, 1, cross - start)
                } else {
                    (start, split.edge, cross - start, 1)
                };
                result.push(
                    div()
                        .id(("canonical-divider", index * 4096 + usize::from(start)))
                        .absolute()
                        .left(px(f32::from(left) * width))
                        .top(px(f32::from(top) * crate::terminal::CELL_HEIGHT))
                        .w(px(f32::from(cols) * width))
                        .h(px(f32::from(rows) * crate::terminal::CELL_HEIGHT))
                        .cursor(if split.axis == Axis::Cols {
                            CursorStyle::ResizeLeftRight
                        } else {
                            CursorStyle::ResizeUpDown
                        })
                        .when(selected == Some(split.id.as_str()), |el| el.bg(rgb(accent)))
                        .into_any_element(),
                );
            }
        }
    }
    result
}
