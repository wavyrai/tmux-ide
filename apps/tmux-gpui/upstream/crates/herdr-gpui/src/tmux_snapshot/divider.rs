//! Release-only resize of simple separators and axis-origin T segments. No layout prediction.
//! Non-origin unequal spans are deliberately unsupported: rectangles do not identify
//! the nearest same-axis tmux ancestor that an absolute pane resize will change.
use super::{SnapshotView, browser, hit_regions};
use gpui::{prelude::*, *};
use serde::{Deserialize, Serialize};
pub(super) mod canonical;
pub(super) mod gesture;
pub(super) use gesture::Owner;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Axis {
    Cols,
    Rows,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Split {
    canonical: Option<canonical::Target>,
    id: String,
    neighbor: String,
    axis: Axis,
    edge: u16,
    start: u16,
    span: u16,
    cells: u16,
    total: u16,
}
fn splits(state: &browser::State) -> Vec<Split> {
    let Some(frame) = state.frame.as_ref() else {
        return Vec::new();
    };
    if state.surface != browser::Surface::Workspace
        || (state.resize_token.is_none() && state.split_layout.is_none())
        || !state.input_ready
        || !hit_regions::valid(&state.regions, Some(frame), &state.panes)
        || frame.width > 1000
        || frame.height > 500
    {
        return Vec::new();
    }
    if let Some(layout) = state.split_layout.as_ref() {
        if !layout.matches(
            Some(frame),
            &state.regions,
            &state.panes,
            state.selected_session.as_deref(),
            state.selected_pane.as_deref(),
        ) {
            return Vec::new();
        }
        return layout
            .splits
            .iter()
            .map(|edge| Split {
                canonical: Some(layout.target(edge)),
                id: edge.split_id.clone(),
                neighbor: String::new(),
                axis: edge.axis,
                edge: edge.boundary,
                start: edge.start,
                span: edge.length,
                cells: edge.boundary,
                total: if edge.axis == Axis::Cols {
                    layout.cols
                } else {
                    layout.rows
                },
            })
            .collect();
    }
    let mut result = Vec::new();
    for a in &state.regions {
        for b in &state.regions {
            if a.id == b.id {
                continue;
            }
            let top = a.top.max(b.top);
            let bottom = (a.top + a.height).min(b.top + b.height);
            let left = a.left.max(b.left);
            let right = (a.left + a.width).min(b.left + b.width);
            let split = if a.left + a.width + 1 == b.left
                && top < bottom
                && ((a.top == b.top && a.height == b.height) || a.left == 0)
            {
                Some(Split {
                    canonical: None,
                    id: a.id.clone(),
                    neighbor: b.id.clone(),
                    axis: Axis::Cols,
                    edge: a.left + a.width,
                    start: top,
                    span: bottom - top,
                    cells: a.width,
                    total: a.width + b.width,
                })
            } else if a.top + a.height + 1 == b.top
                && left < right
                && ((a.left == b.left && a.width == b.width) || a.top == 0)
            {
                Some(Split {
                    canonical: None,
                    id: a.id.clone(),
                    neighbor: b.id.clone(),
                    axis: Axis::Rows,
                    edge: a.top + a.height,
                    start: left,
                    span: right - left,
                    cells: a.height,
                    total: a.height + b.height,
                })
            } else {
                None
            };
            if let Some(split) = split {
                result.push(split);
            }
        }
    }
    result
}
fn at(state: &browser::State, x: f32, y: f32) -> Option<Split> {
    if !x.is_finite() || !y.is_finite() || x < 0. || y < 0. {
        return None;
    }
    let col = x.floor();
    let row = y.floor();
    let mut candidates = splits(state).into_iter().filter(|s| {
        let (along, cross) = if s.axis == Axis::Cols {
            (col, row)
        } else {
            (row, col)
        };
        along == f32::from(s.edge)
            && cross >= f32::from(s.start)
            && cross < f32::from(s.start + s.span)
    });
    let split = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    if split.canonical.is_some() {
        return canonical::safe_cell(state, col as u16, row as u16).then_some(split);
    }
    let frame = state.frame.as_ref()?;
    // Reuse the existing all-pane carve and styled/glyph protection, not a broad border box.
    hit_regions::separator_cells(&split.id, &state.regions, frame, &state.panes)
        .iter()
        .any(|cell| {
            f32::from(cell.col) == col
                && f32::from(cell.row) == row
                && cell.vertical == (split.axis == Axis::Cols)
        })
        .then_some(split)
}

pub(super) struct Drag {
    gesture: Option<String>,
    split: Split,
    token: String,
    request: u64,
    session: String,
    selected: String,
    presence_revision: u64,
    regions: Vec<hit_regions::Region>,
    grid: (u16, u16),
    bounds: Bounds<Pixels>,
    cell_width: f32,
    anchor: f32,
    cells: u16,
}
impl Drag {
    fn begin(
        state: &browser::State,
        bounds: Bounds<Pixels>,
        width: f32,
        position: Point<Pixels>,
    ) -> Option<Self> {
        if !width.is_finite() || width <= 0. || !bounds.contains(&position) {
            return None;
        }
        let offset = position - bounds.origin;
        let (x, y) = (
            f32::from(offset.x) / width,
            f32::from(offset.y) / crate::terminal::CELL_HEIGHT,
        );
        let split = at(state, x, y)?;
        let frame = state.frame.as_ref()?;
        let cells = split.cells;
        Some(Self {
            gesture: (split.canonical.is_some() || state.resize_gesture_supported)
                .then(|| uuid::Uuid::new_v4().to_string()),
            anchor: if split.axis == Axis::Cols { x } else { y },
            split,
            token: state.resize_token.clone().unwrap_or_default(),
            request: state.request,
            session: state.selected_session.clone()?,
            selected: state.selected_pane.clone()?,
            presence_revision: state.presence_revision,
            regions: state.regions.clone(),
            grid: (frame.width, frame.height),
            bounds,
            cell_width: width,
            cells,
        })
    }
    pub fn compatible(&self, state: &browser::State) -> bool {
        let pending = self.split.canonical.is_some()
            && state.split_gesture.as_ref().is_some_and(|a| {
                self.gesture.as_ref() == Some(&a.gesture)
                    && a.phase == gesture::Phase::Pending
                    && a.target.is_none()
            })
            || self.split.canonical.is_none()
                && state.resize_gesture.as_ref().is_some_and(|a| {
                    self.gesture.as_ref() == Some(&a.gesture)
                        && a.id == self.split.id
                        && a.axis == self.split.axis
                        && a.phase == gesture::Phase::Pending
                        && a.token.is_none()
                });
        state.surface == browser::Surface::Workspace
            && (state.input_ready || pending)
            && state.request == self.request
            && self.geometry_compatible(state)
            && state.selected_session.as_ref() == Some(&self.session)
            && state.selected_pane.as_ref() == Some(&self.selected)
            && state.presence_revision == self.presence_revision
            && state
                .frame
                .as_ref()
                .map_or(pending, |f| (f.width, f.height) == self.grid)
    }
    fn geometry_compatible(&self, state: &browser::State) -> bool {
        if let Some(original) = self.split.canonical.as_ref() {
            if let Some(ack) = state
                .split_gesture
                .as_ref()
                .filter(|a| self.gesture.as_ref() == Some(&a.gesture))
            {
                if matches!(
                    ack.phase,
                    gesture::Phase::Failed | gesture::Phase::Cancelled
                ) {
                    return false;
                }
                if ack.phase == gesture::Phase::Pending && ack.target.is_none() {
                    return true;
                }
                return ack.target.as_ref().is_some_and(|target| {
                    target.window == original.window
                        && state
                            .split_layout
                            .as_ref()
                            .is_some_and(|layout| layout.contains(target, self.split.axis))
                });
            }
            return state
                .split_layout
                .as_ref()
                .is_some_and(|layout| layout.contains(original, self.split.axis))
                && state.regions == self.regions;
        }
        if let Some(ack) = state
            .resize_gesture
            .as_ref()
            .filter(|a| self.gesture.as_ref() == Some(&a.gesture))
        {
            if ack.id != self.split.id || ack.axis != self.split.axis {
                return false;
            }
            if matches!(
                ack.phase,
                gesture::Phase::Failed | gesture::Phase::Cancelled
            ) {
                return false;
            }
            if ack.phase == gesture::Phase::Pending && ack.token.is_none() {
                // Hold the original pointer transform while unresolved; this is not
                // a geometry rebase or an assertion that intervening changes are ours.
                return true;
            }
            return ack.token.is_some()
                && ack.token == state.resize_token
                && splits(state).iter().any(|s| {
                    s.id == self.split.id
                        && s.neighbor == self.split.neighbor
                        && s.axis == self.split.axis
                        && s.start == self.split.start
                        && s.span == self.split.span
                        && s.total == self.split.total
                        && s.cells == ack.cells
                });
        }
        state.resize_token.as_ref() == Some(&self.token) && state.regions == self.regions
    }
    fn update(&mut self, position: Point<Pixels>) -> bool {
        let offset = position - self.bounds.origin;
        let coordinate = if self.split.axis == Axis::Cols {
            f32::from(offset.x) / self.cell_width
        } else {
            f32::from(offset.y) / crate::terminal::CELL_HEIGHT
        };
        if !coordinate.is_finite() {
            return false;
        }
        if self.split.canonical.is_some() {
            self.cells = (f32::from(self.split.cells) + (coordinate - self.anchor).round())
                .clamp(0., f32::from(self.split.total)) as u16;
            return true;
        }
        // Outer row rectangles may include a status line. Three outer rows leave
        // at least two content rows; the bridge converts to daemon pane_height.
        let minimum = if self.split.axis == Axis::Rows { 3 } else { 2 };
        if self.split.total < minimum * 2 {
            return false;
        }
        self.cells = (f32::from(self.split.cells) + (coordinate - self.anchor).round())
            .clamp(f32::from(minimum), f32::from(self.split.total - minimum))
            as u16;
        true
    }
    fn command(&self) -> Option<browser::Command> {
        if self.split.canonical.is_some() {
            return None;
        }
        (self.cells != self.split.cells).then(|| browser::Command::ResizePane {
            request: self.request,
            id: self.split.id.clone(),
            token: self.token.clone(),
            axis: self.split.axis,
            cells: self.cells,
        })
    }
}
impl SnapshotView {
    pub(super) fn divider_handles(&self, width: f32) -> Vec<AnyElement> {
        if !self.presence.ready()
            || self.selection.is_some()
            || (self.picker.is_some() || self.pane_actions.is_some() || self.new_session.is_some())
            || !width.is_finite()
            || width <= 0.
            || !hit_regions::is_painted(self.frame.as_ref(), self.browser_state.frame.as_ref())
        {
            return Vec::new();
        }
        let Some(frame) = self.browser_state.frame.as_ref() else {
            return Vec::new();
        };
        if self.browser_state.split_layout.is_some() {
            return canonical::guides(
                &self.browser_state,
                width,
                self.divider.as_ref().map(|d| d.split.id.as_str()),
                self.accent(),
            );
        }
        splits(&self.browser_state)
            .into_iter()
            .enumerate()
            .filter_map(|(index, split)| {
                let safe = hit_regions::separator_cells(
                    &split.id,
                    &self.browser_state.regions,
                    frame,
                    &self.browser_state.panes,
                );
                let count = safe
                    .iter()
                    .filter(|cell| {
                        if split.axis == Axis::Cols {
                            cell.vertical
                                && cell.col == split.edge
                                && cell.row >= split.start
                                && cell.row < split.start + split.span
                        } else {
                            !cell.vertical
                                && cell.row == split.edge
                                && cell.col >= split.start
                                && cell.col < split.start + split.span
                        }
                    })
                    .count();
                if count != usize::from(split.span) {
                    return None;
                }
                let (left, top, cols, rows) = if split.axis == Axis::Cols {
                    (split.edge, split.start, 1, split.span)
                } else {
                    (split.start, split.edge, split.span, 1)
                };
                Some(
                    div()
                        .id(("pane-divider", index))
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
                        .when(
                            self.divider
                                .as_ref()
                                .is_some_and(|drag| drag.split == split),
                            |handle| handle.bg(rgb(self.accent())),
                        )
                        .into_any_element(),
                )
            })
            .collect()
    }
    pub(super) fn begin_divider(
        &mut self,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) -> bool {
        self.divider = None;
        if self.selection.is_some()
            || (self.picker.is_some() || self.pane_actions.is_some() || self.new_session.is_some())
            || !self.presence.ready()
            || self.browser_request != self.browser_state.request
            || !hit_regions::is_painted(self.frame.as_ref(), self.painted_frame.as_ref())
        {
            return false;
        }
        let (Some((bounds, _)), Some(width)) = (self.input_geometry, self.input_cell_width) else {
            return false;
        };
        if self.resize_gesture.busy() {
            return false;
        }
        self.divider = Drag::begin(&self.browser_state, bounds, width, position);
        if let Some(drag) = self.divider.as_ref() {
            self.resize_gesture.begin(drag);
        }
        if self.divider.is_some() {
            self.discard_composition(cx);
            cx.notify();
            cx.stop_propagation();
            true
        } else {
            false
        }
    }
    pub(super) fn move_divider(
        &mut self,
        position: Point<Pixels>,
        release: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(mut drag) = self.divider.take() else {
            return;
        };
        if !self.presence.ready()
            || self.selection.is_some()
            || (self.picker.is_some() || self.pane_actions.is_some() || self.new_session.is_some())
            || self.browser_request != drag.request
            || !drag.compatible(&self.browser_state)
            || self.input_geometry.map(|g| g.0) != Some(drag.bounds)
            || self.input_cell_width != Some(drag.cell_width)
            || !drag.update(position)
        {
            cx.notify();
            return;
        }
        if drag.gesture.is_some() {
            self.resize_gesture.offer(drag.cells, release);
            if !release {
                self.divider = Some(drag);
            }
        } else if release {
            if let Some(command) = drag.command()
                && self
                    .browser_commands
                    .as_ref()
                    .is_none_or(|sender| sender.try_send(command).is_err())
            {
                self.browser_state.status = "Pane resize unavailable — try again".into();
            }
        } else {
            self.divider = Some(drag);
        }
        cx.notify();
    }
}
#[cfg(test)]
mod tests;
