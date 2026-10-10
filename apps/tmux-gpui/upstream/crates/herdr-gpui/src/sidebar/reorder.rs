//! Reordering workspaces by dragging their rows. Holding a press on a row, or
//! moving it a few pixels, lifts the row; the rows around it shift as if it
//! had already been dropped under the pointer, so the gap they open is where
//! it lands. Releasing sends `workspace.move_block`. The daemon owns the order,
//! so the preview holds until the next snapshot reorders the list, the same
//! for every attached client.
//!
//! A top-level row carries its whole worktree group, collapsed children and
//! the group's other parents included, and lands between other top-level
//! rows. A linked worktree only moves among its own siblings: the group is
//! decided by its repository, not by where it is dropped.

use crate::{
    HerdrWindow,
    reorder::{LIFT_DELAY, LIFT_DISTANCE, SETTLE_TIMEOUT, SLIDE, Slide, slot_for},
};
use gpui::{Context, Pixels, Point, Task};
use herdr_client::{Method, protocol::ClientShellWorkspace};
use std::{cell::RefCell, collections::HashMap, time::Instant};

use super::workspaces::{grouped_keys, workspace_entries};

/// A press on a workspace row that may become a reorder.
pub(crate) struct WorkspaceDrag {
    boot: String,
    pub(super) workspace: String,
    origin: Point<Pixels>,
    pub(super) pointer: Point<Pixels>,
    pub(super) lifted: bool,
    /// The gap under the pointer, `None` over the carried unit's own place.
    pub(super) target: Option<Target>,
    /// The order the list had when the drag was dropped with a move sent,
    /// kept so the preview lasts exactly until the daemon's answer.
    dropped: Option<Vec<String>>,
    /// Each shifted row's slide, by workspace. Render reads and advances them,
    /// so they live behind a cell; they end with the drag.
    slides: RefCell<HashMap<String, Slide>>,
    /// Lifts the row once the press has rested, then ends a dropped preview
    /// the daemon never answered. Dropping the drag cancels it.
    _timer: Task<()>,
}

impl WorkspaceDrag {
    /// How far the lifted row has followed the pointer.
    pub(super) fn offset(&self) -> Pixels {
        self.pointer.y - self.origin.y
    }

    /// Where a row paints on its way to shift `to`, and whether it is still
    /// moving. A row starts from its resting place.
    pub(super) fn slide(&self, workspace: &str, to: f32, now: Instant) -> (f32, bool) {
        let mut slides = self.slides.borrow_mut();
        let slide = slides.entry(workspace.to_owned()).or_insert(Slide {
            from: 0.,
            to: 0.,
            start: now,
        });
        *slide = slide.toward(to, now, SLIDE);
        (slide.at(now, SLIDE), slide.progress(now, SLIDE) < 1.)
    }

    /// Records a carried row at the pointer, so it slides from there once
    /// dropped rather than from where it was picked up.
    pub(super) fn pin(&self, workspace: &str, at: f32, now: Instant) {
        self.slides.borrow_mut().insert(
            workspace.to_owned(),
            Slide {
                from: at,
                to: at,
                start: now,
            },
        );
    }

    /// Whether the lifted row still follows the pointer.
    pub(super) fn floating(&self) -> bool {
        self.lifted && self.dropped.is_none()
    }

    /// Whether the list should show the drop in place: while it floats, and
    /// after it is dropped until the daemon's order replaces the old one.
    pub(super) fn previewing(&self, workspaces: &[ClientShellWorkspace]) -> bool {
        self.lifted
            && self.dropped.as_ref().is_none_or(|order| {
                order.iter().map(String::as_str).eq(workspaces
                    .iter()
                    .map(|workspace| workspace.workspace_id.as_str()))
            })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Target {
    pub(super) slot: usize,
    request: MoveBlock,
}

#[cfg(test)]
impl Target {
    pub(super) fn params(&self) -> serde_json::Value {
        self.request.params()
    }
}

/// A `workspace.move_block` request: `workspace_ids` land, in that order,
/// before `before`, or at the end of the list without one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MoveBlock {
    workspace_ids: Vec<String>,
    before: Option<String>,
}

impl MoveBlock {
    fn params(&self) -> serde_json::Value {
        serde_json::json!({
            "workspace_ids": self.workspace_ids,
            "before_workspace_id": self.before,
        })
    }
}

/// The units a drag reorders, in display order, and the one it carries. Each
/// unit lists workspace indices in the order the sidebar shows them.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Plan {
    units: Vec<Vec<usize>>,
    dragged: usize,
    /// Whether the units are one group's children rather than top-level rows.
    children: bool,
}

impl Plan {
    /// `None` when the pressed row has nowhere else to go.
    pub(super) fn new(workspaces: &[ClientShellWorkspace], workspace: &str) -> Option<Self> {
        let pressed = workspaces
            .iter()
            .position(|w| w.workspace_id == workspace)?;
        // A group's rows are contiguous, so a block is a run of one grouped
        // repository's rows, or a single ungrouped row.
        let grouped = grouped_keys(workspaces);
        let group_of = |index: usize| {
            workspaces[index]
                .worktree
                .as_ref()
                .map(|tree| tree.key.as_str())
                .filter(|key| grouped.contains(key))
        };
        let mut blocks: Vec<Vec<(usize, bool)>> = Vec::new();
        for (index, child) in workspace_entries(workspaces) {
            match blocks.last_mut() {
                Some(block)
                    if group_of(index).is_some() && group_of(block[0].0) == group_of(index) =>
                {
                    block.push((index, child));
                }
                _ => blocks.push(vec![(index, child)]),
            }
        }
        let (block, &(_, child)) = blocks.iter().enumerate().find_map(|(position, block)| {
            Some((
                position,
                block.iter().find(|&&(index, _)| index == pressed)?,
            ))
        })?;
        let plan = if !child {
            Self {
                units: blocks
                    .iter()
                    .map(|block| block.iter().map(|&(index, _)| index).collect())
                    .collect(),
                dragged: block,
                children: false,
            }
        } else {
            let children: Vec<_> = blocks[block]
                .iter()
                .filter(|&&(_, child)| child)
                .map(|&(i, _)| vec![i])
                .collect();
            Self {
                dragged: children.iter().position(|unit| unit[0] == pressed)?,
                units: children,
                children: true,
            }
        };
        (plan.units.len() > 1).then_some(plan)
    }

    pub(super) fn len(&self) -> usize {
        self.units.len()
    }

    pub(super) fn dragged(&self) -> usize {
        self.dragged
    }

    /// The unit a workspace belongs to, if this drag reorders it.
    pub(super) fn unit_of(&self, index: usize) -> Option<usize> {
        self.units.iter().position(|unit| unit.contains(&index))
    }

    /// The move that dropping into `slot`, the gap before unit `slot`, makes.
    /// `None` for the two gaps around the carried unit, which move nothing.
    pub(super) fn request(
        &self,
        workspaces: &[ClientShellWorkspace],
        slot: usize,
    ) -> Option<MoveBlock> {
        if slot == self.dragged || slot == self.dragged + 1 || slot > self.units.len() {
            return None;
        }
        let moved = &self.units[self.dragged];
        let id = |index: usize| workspaces[index].workspace_id.clone();
        // A group shows where its earliest member sits, so landing before a
        // unit means landing before that member.
        let before = match self.units.get(slot) {
            Some(unit) => unit.iter().min().copied(),
            // Past the last sibling, a child still has to stay ahead of what
            // follows its group; a top-level unit simply goes last.
            None if self.children => {
                let last = self
                    .units
                    .iter()
                    .enumerate()
                    .filter(|&(unit, _)| unit != self.dragged)
                    .flat_map(|(_, unit)| unit.iter().copied())
                    .max()?;
                (last + 1..workspaces.len()).find(|index| !moved.contains(index))
            }
            None => None,
        };
        Some(MoveBlock {
            workspace_ids: moved.iter().map(|&index| id(index)).collect(),
            before: before.map(id),
        })
    }
}

impl HerdrWindow {
    /// Arms a reorder for a left press on a row of the selected endpoint.
    pub(super) fn press_workspace(
        &mut self,
        workspace: &str,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        let Some(snapshot) = &self.live.snapshot else {
            return;
        };
        if self.menu.page.is_some()
            || !self.live.status.is_connected()
            || Plan::new(&snapshot.workspaces, workspace).is_none()
        {
            return;
        }
        let lift = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LIFT_DELAY).await;
            let _ = this.update(cx, |this, cx| this.lift_workspace(cx));
        });
        self.workspace_drag = Some(WorkspaceDrag {
            boot: snapshot.boot_id.clone(),
            workspace: workspace.to_owned(),
            origin: position,
            pointer: position,
            lifted: false,
            target: None,
            dropped: None,
            slides: RefCell::default(),
            _timer: lift,
        });
    }

    fn lift_workspace(&mut self, cx: &mut Context<Self>) {
        if let Some(drag) = &mut self.workspace_drag
            && !drag.lifted
        {
            drag.lifted = true;
            // The resting pointer is carrying a row, not asking for its menu.
            self.hover = None;
            cx.notify();
        }
    }

    /// Follows the pointer. `target` resolves a lifted drag's gap from how far
    /// the card has moved, against the geometry the sidebar last laid out. Returns whether the move belongs to
    /// the drag, so the terminal and hover never see it.
    pub(super) fn move_workspace_drag(
        &mut self,
        position: Point<Pixels>,
        held: bool,
        target: impl FnOnce(Pixels) -> Option<Target>,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(drag) = self.workspace_drag.as_mut().filter(|d| d.dropped.is_none()) else {
            return false;
        };
        // A release outside the window never reaches the sidebar.
        if !held {
            let lifted = drag.lifted;
            self.workspace_drag = None;
            cx.notify();
            return lifted;
        }
        drag.pointer = position;
        let moved = position - drag.origin;
        if !drag.lifted && f32::from(moved.x.abs().max(moved.y.abs())) > LIFT_DISTANCE {
            self.lift_workspace(cx);
        }
        let Some(drag) = self.workspace_drag.as_mut().filter(|drag| drag.lifted) else {
            return false;
        };
        drag.target = target(drag.offset());
        cx.notify();
        true
    }

    /// Ends the drag on release, sending its move if it was lifted over a gap.
    /// Returns whether it had lifted, in which case the release is not a click.
    pub(super) fn release_workspace_drag(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(mut drag) = self.workspace_drag.take() else {
            return false;
        };
        if !drag.floating() {
            return false;
        }
        cx.notify();
        let Some(target) = &drag.target else {
            return true;
        };
        let connection = &self.endpoints[self.selected_endpoint].connection;
        let (Some(handle), Some(snapshot)) = (&connection.handle, &self.live.snapshot) else {
            return true;
        };
        if snapshot.boot_id != drag.boot {
            return true;
        }
        match handle.request(
            &drag.boot,
            Method::WorkspaceMoveBlock,
            target.request.params(),
        ) {
            Ok(_) => {
                drag.dropped = Some(
                    snapshot
                        .workspaces
                        .iter()
                        .map(|workspace| workspace.workspace_id.clone())
                        .collect(),
                );
                drag._timer = cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(SETTLE_TIMEOUT).await;
                    let _ = this.update(cx, |this, cx| {
                        this.workspace_drag = None;
                        cx.notify();
                    });
                });
                self.workspace_drag = Some(drag);
            }
            Err(error) => self.local_error = Some(format!("Workspace move not sent: {error}")),
        }
        true
    }

    /// Drops a lifted row where it came from. Returns whether one was lifted.
    pub(crate) fn cancel_workspace_drag(&mut self, cx: &mut Context<Self>) -> bool {
        if !self
            .workspace_drag
            .as_ref()
            .is_some_and(WorkspaceDrag::floating)
        {
            return false;
        }
        self.workspace_drag = None;
        cx.notify();
        true
    }
}

/// Resolves the pointer to a gap, from each unit's rows and the move for every
/// gap, all prepared by the render the pointer is over.
pub(super) fn resolve(
    rows: &[(usize, usize, Pixels)],
    requests: &[Option<MoveBlock>],
    dragged: usize,
    scroll: &gpui::ScrollHandle,
    lift: Pixels,
) -> Option<Target> {
    let len = requests.len().checked_sub(1)?;
    let offset = scroll.offset().y;
    let mut spans: Vec<Option<(Pixels, Pixels)>> = vec![None; len];
    // Rows sit where the preview shifted them; the gaps are measured where
    // they rest, or the list would chase its own preview.
    for &(unit, row, shift) in rows {
        let Some(bounds) = scroll.bounds_for_item(row) else {
            continue;
        };
        let (top, bottom) = (
            bounds.top() + offset - shift,
            bounds.bottom() + offset - shift,
        );
        let span = &mut spans[unit];
        *span = Some(span.map_or((top, bottom), |(t, b)| (t.min(top), b.max(bottom))));
    }
    let spans: Vec<_> = spans
        .iter()
        .map(|span| span.map(|(top, bottom)| (f32::from(top), f32::from(bottom))))
        .collect();
    let (top, bottom) = (*spans.get(dragged)?)?;
    let lift = f32::from(lift);
    let slot = slot_for(&spans, dragged, (top + lift, bottom + lift));
    let request = requests.get(slot)?.clone()?;
    Some(Target { slot, request })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use herdr_client::protocol::ClientShellWorktree;

    fn workspace(id: &str, tree: Option<(&str, bool)>) -> ClientShellWorkspace {
        ClientShellWorkspace {
            workspace_id: id.into(),
            active_tab_id: String::new(),
            new_workspace_cwd: String::new(),
            number: 0,
            label: id.into(),
            custom_label: false,
            branch: None,
            git_ahead_behind: None,
            tokens: Vec::new(),
            worktree: tree.map(|(key, linked)| ClientShellWorktree {
                key: key.into(),
                label: key.into(),
                is_linked_worktree: linked,
            }),
            focused: false,
            agent_status: herdr_client::protocol::AgentStatus::Idle,
        }
    }

    /// `a` heads a group whose child `a2` sits after `b` in daemon order.
    fn list() -> Vec<ClientShellWorkspace> {
        vec![
            workspace("a", Some(("repo-a", false))),
            workspace("a1", Some(("repo-a", true))),
            workspace("b", None),
            workspace("a2", Some(("repo-a", true))),
            workspace("c", None),
        ]
    }

    fn request(ids: &[&str], before: Option<&str>) -> Option<MoveBlock> {
        Some(MoveBlock {
            workspace_ids: ids.iter().map(|&id| id.into()).collect(),
            before: before.map(Into::into),
        })
    }

    /// Every parent of a group carries the whole group, its other parents
    /// included; without a linked worktree, plain checkouts move alone.
    #[test]
    fn a_group_s_parents_move_together_and_plain_checkouts_alone() {
        let mut list = list();
        list.push(workspace("a3", Some(("repo-a", false))));
        for pressed in ["a", "a3"] {
            let plan = Plan::new(&list, pressed).unwrap();
            assert_eq!(plan.units, [vec![0, 5, 1, 3], vec![2], vec![4]]);
            assert_eq!(plan.dragged, 0);
            assert_eq!(
                plan.request(&list, 3),
                request(&["a", "a3", "a1", "a2"], None)
            );
        }
        // A child still moves only among its siblings.
        let plan = Plan::new(&list, "a2").unwrap();
        assert_eq!(plan.units, [vec![1], vec![3]]);

        list.retain(|w| !w.worktree.as_ref().is_some_and(|t| t.is_linked_worktree));
        let plan = Plan::new(&list, "a3").unwrap();
        assert_eq!(plan.units, [vec![0], vec![1], vec![2], vec![3]]);
        assert_eq!(plan.dragged, 3);
        assert_eq!(plan.request(&list, 1), request(&["a3"], Some("b")));
    }

    #[test]
    fn a_top_level_row_carries_its_whole_group() {
        let list = list();
        let plan = Plan::new(&list, "a").unwrap();
        assert_eq!(plan.units, [vec![0, 1, 3], vec![2], vec![4]]);
        assert_eq!(plan.dragged, 0);
        // The gaps around the group itself move nothing.
        assert_eq!(plan.request(&list, 0), None);
        assert_eq!(plan.request(&list, 1), None);
        assert_eq!(
            plan.request(&list, 2),
            request(&["a", "a1", "a2"], Some("c"))
        );
        assert_eq!(plan.request(&list, 3), request(&["a", "a1", "a2"], None));
        assert_eq!(plan.request(&list, 4), None);
    }

    #[test]
    fn a_standalone_row_lands_before_a_group_s_earliest_member() {
        let mut list = list();
        // The group shows where `a1` sits, ahead of its own main checkout.
        list.swap(0, 1);
        let plan = Plan::new(&list, "c").unwrap();
        assert_eq!(plan.units, [vec![1, 0, 3], vec![2], vec![4]]);
        assert_eq!(plan.request(&list, 0), request(&["c"], Some("a1")));
    }

    #[test]
    fn a_child_moves_only_among_its_siblings() {
        let list = list();
        let plan = Plan::new(&list, "a1").unwrap();
        assert!(plan.children);
        assert_eq!(plan.units, [vec![1], vec![3]]);
        assert_eq!(plan.unit_of(2), None);
        assert_eq!(plan.request(&list, 0), None);
        assert_eq!(plan.request(&list, 1), None);
        // Last among siblings stays ahead of what follows the group.
        assert_eq!(plan.request(&list, 2), request(&["a1"], Some("c")));
        let plan = Plan::new(&list, "a2").unwrap();
        assert_eq!(plan.request(&list, 0), request(&["a2"], Some("a1")));
    }

    #[test]
    fn a_last_child_moved_to_the_end_of_the_list_needs_no_anchor() {
        let list = vec![
            workspace("a", Some(("repo-a", false))),
            workspace("a1", Some(("repo-a", true))),
            workspace("a2", Some(("repo-a", true))),
        ];
        let plan = Plan::new(&list, "a1").unwrap();
        assert_eq!(plan.request(&list, 2), request(&["a1"], None));
    }

    #[test]
    fn rows_with_nowhere_to_go_do_not_arm() {
        let list = vec![
            workspace("a", Some(("repo-a", false))),
            workspace("a1", Some(("repo-a", true))),
        ];
        assert_eq!(Plan::new(&list, "a"), None);
        assert_eq!(Plan::new(&list, "a1"), None);
        assert_eq!(Plan::new(&list, "missing"), None);
    }
}
