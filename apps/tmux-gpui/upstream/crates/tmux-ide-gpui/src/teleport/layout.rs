//! Rebuild a tab's split tree on another host.
//!
//! A layout snapshot lists split rectangles keyed by their tree path and pane
//! rectangles. A pane's branch at each split follows from which side of the
//! split line its centre lies; the split ids name the tree exactly.

use super::snapshot::{Layout, LayoutSplit, Rect, SplitDirection};
use std::collections::HashMap;

/// A tab's layout as a binary tree of source pane ids.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Node {
    Pane(String),
    Split {
        direction: SplitDirection,
        ratio: f32,
        first: Box<Node>,
        second: Box<Node>,
    },
}

/// One `pane split` call: split the pane in `target`'s slot, keeping it as
/// the first child, and store the new second-child pane in slot `created`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SplitStep {
    pub(crate) target: usize,
    pub(crate) direction: SplitDirection,
    pub(crate) ratio: f32,
    pub(crate) created: usize,
}

/// How to grow one tab from its single root pane (slot 0).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BuildPlan {
    pub(crate) steps: Vec<SplitStep>,
    /// The source pane each slot stands for.
    pub(crate) slots: Vec<String>,
}

fn path_of(split: &LayoutSplit) -> Option<String> {
    let path = split.id.rsplit_once('_')?.1;
    if path == "root" {
        return Some(String::new());
    }
    path.bytes()
        .all(|b| matches!(b, b'0' | b'1'))
        .then(|| path.to_owned())
}

fn centre(rect: Rect) -> (f32, f32) {
    (
        f32::from(rect.x) + f32::from(rect.width) / 2.,
        f32::from(rect.y) + f32::from(rect.height) / 2.,
    )
}

fn second_side(split: &LayoutSplit, rect: Rect) -> bool {
    let (x, y) = centre(rect);
    let r = split.rect;
    match split.direction {
        SplitDirection::Right => x >= f32::from(r.x) + f32::from(r.width) * split.ratio,
        SplitDirection::Down => y >= f32::from(r.y) + f32::from(r.height) * split.ratio,
    }
}

/// Rebuild `layout`'s tree. `None` when the snapshot is inconsistent, in which
/// case callers fall back to one pane per source pane.
pub(crate) fn tree(layout: &Layout) -> Option<Node> {
    let splits: HashMap<String, &LayoutSplit> = layout
        .splits
        .iter()
        .map(|split| Some((path_of(split)?, split)))
        .collect::<Option<_>>()?;
    let mut leaves: HashMap<String, String> = HashMap::new();
    for pane in &layout.panes {
        let mut path = String::new();
        while let Some(split) = splits.get(&path) {
            path.push(if second_side(split, pane.rect) {
                '1'
            } else {
                '0'
            });
        }
        if leaves.insert(path, pane.pane_id.clone()).is_some() {
            return None;
        }
    }
    let node = build(&String::new(), &splits, &mut leaves)?;
    leaves.is_empty().then_some(node)
}

fn build(
    path: &String,
    splits: &HashMap<String, &LayoutSplit>,
    leaves: &mut HashMap<String, String>,
) -> Option<Node> {
    let Some(split) = splits.get(path) else {
        return leaves.remove(path).map(Node::Pane);
    };
    Some(Node::Split {
        direction: split.direction,
        ratio: split.ratio,
        first: Box::new(build(&format!("{path}0"), splits, leaves)?),
        second: Box::new(build(&format!("{path}1"), splits, leaves)?),
    })
}

impl Node {
    /// The split calls that grow a single pane into this tree. Splitting a
    /// leaf nests the new split exactly where the leaf was, so each subtree is
    /// grown inside the pane that currently covers it.
    pub(crate) fn plan(&self) -> BuildPlan {
        let mut plan = BuildPlan {
            steps: Vec::new(),
            slots: vec![String::new()],
        };
        self.grow(0, &mut plan);
        plan
    }

    fn grow(&self, slot: usize, plan: &mut BuildPlan) {
        match self {
            Node::Pane(id) => plan.slots[slot].clone_from(id),
            Node::Split {
                direction,
                ratio,
                first,
                second,
            } => {
                let created = plan.slots.len();
                plan.slots.push(String::new());
                plan.steps.push(SplitStep {
                    target: slot,
                    direction: *direction,
                    ratio: *ratio,
                    created,
                });
                first.grow(slot, plan);
                second.grow(created, plan);
            }
        }
    }

    /// A left-to-right row of `panes`, for a layout that could not be read.
    pub(crate) fn row(panes: &[String]) -> Option<Node> {
        let (last, rest) = panes.split_last()?;
        let mut node = Node::Pane(last.clone());
        for (index, pane) in rest.iter().enumerate().rev() {
            node = Node::Split {
                direction: SplitDirection::Right,
                // Equal shares: this pane takes 1/(remaining panes).
                ratio: 1. / (panes.len() - index) as f32,
                first: Box::new(Node::Pane(pane.clone())),
                second: Box::new(node),
            };
        }
        Some(node)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::super::snapshot::LayoutPane;
    use super::*;

    fn rect(x: u16, y: u16, width: u16, height: u16) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn pane(id: &str, r: Rect) -> LayoutPane {
        LayoutPane {
            pane_id: id.into(),
            rect: r,
        }
    }

    fn split(path: &str, direction: SplitDirection, ratio: f32, r: Rect) -> LayoutSplit {
        LayoutSplit {
            id: format!("split_0_{}", if path.is_empty() { "root" } else { path }),
            direction,
            ratio,
            rect: r,
        }
    }

    fn layout(panes: Vec<LayoutPane>, splits: Vec<LayoutSplit>) -> Layout {
        Layout {
            tab_id: "t".into(),
            panes,
            splits,
        }
    }

    fn leaf(id: &str) -> Box<Node> {
        Box::new(Node::Pane(id.into()))
    }

    #[test]
    fn single_pane_is_a_leaf_with_no_splits() {
        let node = tree(&layout(vec![pane("a", rect(0, 0, 80, 24))], vec![])).unwrap();
        assert_eq!(node, Node::Pane("a".into()));
        assert_eq!(
            node.plan(),
            BuildPlan {
                steps: vec![],
                slots: vec!["a".into()]
            }
        );
    }

    #[test]
    fn nested_splits_rebuild_exactly_and_plan_in_tree_order() {
        // | a |  b  |
        // |   |-----|
        // |   |  c  |
        let snapshot = layout(
            vec![
                pane("c", rect(95, 18, 34, 18)),
                pane("a", rect(0, 0, 95, 36)),
                pane("b", rect(95, 0, 34, 18)),
            ],
            vec![
                split("", SplitDirection::Right, 0.74, rect(0, 0, 129, 36)),
                split("1", SplitDirection::Down, 0.5, rect(95, 0, 34, 36)),
            ],
        );
        let node = tree(&snapshot).unwrap();
        assert_eq!(
            node,
            Node::Split {
                direction: SplitDirection::Right,
                ratio: 0.74,
                first: leaf("a"),
                second: Box::new(Node::Split {
                    direction: SplitDirection::Down,
                    ratio: 0.5,
                    first: leaf("b"),
                    second: leaf("c"),
                }),
            }
        );
        let plan = node.plan();
        assert_eq!(plan.slots, ["a", "b", "c"]);
        assert_eq!(
            plan.steps,
            [
                SplitStep {
                    target: 0,
                    direction: SplitDirection::Right,
                    ratio: 0.74,
                    created: 1
                },
                SplitStep {
                    target: 1,
                    direction: SplitDirection::Down,
                    ratio: 0.5,
                    created: 2
                },
            ]
        );
    }

    #[test]
    fn inconsistent_snapshots_are_rejected() {
        // Two panes on the same side of the only split.
        let crowded = layout(
            vec![
                pane("a", rect(0, 0, 10, 10)),
                pane("b", rect(0, 10, 10, 10)),
            ],
            vec![split("", SplitDirection::Right, 0.5, rect(0, 0, 40, 20))],
        );
        assert_eq!(tree(&crowded), None);
        // A split with an empty side.
        let empty = layout(
            vec![pane("a", rect(0, 0, 10, 10))],
            vec![split("", SplitDirection::Right, 0.5, rect(0, 0, 20, 10))],
        );
        assert_eq!(tree(&empty), None);
        // An unparseable split id.
        let mut bad = split("", SplitDirection::Right, 0.5, rect(0, 0, 20, 10));
        bad.id = "split_0_2".into();
        assert_eq!(
            tree(&layout(vec![pane("a", rect(0, 0, 10, 10))], vec![bad])),
            None
        );
    }

    #[test]
    fn fallback_row_gives_equal_shares() {
        let panes = ["a".to_owned(), "b".into(), "c".into()];
        let plan = Node::row(&panes).unwrap().plan();
        assert_eq!(plan.slots, panes);
        let ratios: Vec<_> = plan.steps.iter().map(|s| s.ratio).collect();
        assert_eq!(ratios, [1. / 3., 0.5]);
        assert_eq!(Node::row(&[]), None);
    }
}
