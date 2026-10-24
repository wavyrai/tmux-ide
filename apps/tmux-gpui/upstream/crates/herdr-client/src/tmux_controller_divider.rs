//! Canonical ancestry handles come only from correlated owner HTTP observations.
use super::{Controller, Error, Update};
use crate::{
    tmux_control::{
        self, Authority, Axis, Intent, IntentOutcome, Lifetime, SplitLayout, SplitSuccessor,
        SplitTarget, WindowLink,
    },
    tmux_topology::Layout,
};
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq, Eq)]
struct Scope {
    window: WindowLink,
    members: BTreeMap<String, Lifetime>,
}
#[derive(Clone, Debug)]
pub struct SplitRead {
    pub sequence: u64,
    pub window: WindowLink,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitPhase {
    Dragging,
    Pending,
    Settled,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug)]
pub struct SplitPublication {
    pub gesture: String,
    pub phase: SplitPhase,
    pub revision: u64,
    pub boundary: u16,
    pub target: Option<SplitTarget>,
}
struct Gesture {
    id: String,
    target: SplitTarget,
    axis: Axis,
    desired: u16,
    released: bool,
    operation: Option<String>,
    successor: Option<SplitSuccessor>,
    deadline: u64,
    geometry_requested: bool,
    cancelled: bool,
}
#[derive(Default)]
pub struct DividerState {
    scope: Option<Scope>,
    geometry: Option<Layout>,
    lifetime: String,
    resource: Option<SplitLayout>,
    read: Option<SplitRead>,
    read_sequence: u64,
    active: Option<Gesture>,
    publication: Option<SplitPublication>,
    revision: u64,
}
impl DividerState {
    pub fn busy(&self) -> bool {
        self.active.is_some()
    }
    pub fn matches_gesture(&self, gesture: &str) -> bool {
        self.active.as_ref().is_some_and(|g| g.id == gesture)
    }
    /// Report a local admission rejection without disrupting another accepted operation.
    pub fn reject(&mut self, gesture: &str, boundary: u16) {
        if uuid::Uuid::parse_str(gesture).is_err() || boundary > 4096 {
            return;
        }
        if let Some(g) = &self.active {
            if g.id != gesture || g.operation.is_some() {
                return;
            }
            self.fail(SplitPhase::Failed);
            return;
        }
        self.revision = self.revision.saturating_add(1);
        self.publication = Some(SplitPublication {
            gesture: gesture.into(),
            phase: SplitPhase::Failed,
            revision: self.revision,
            boundary,
            target: None,
        });
    }
    pub fn waiting(&self) -> bool {
        self.active.as_ref().is_some_and(|g| g.operation.is_none())
    }
    pub fn publication(&self) -> Option<&SplitPublication> {
        self.publication.as_ref()
    }
    pub fn resource(&self) -> Option<&SplitLayout> {
        self.resource.as_ref()
    }
    pub fn take_read(&mut self) -> Option<SplitRead> {
        self.read.take()
    }
    /// Observe every controller update before admitting a gesture. No read is triggered by focus alone.
    pub fn observe(&mut self, c: &mut Controller, update: &Update, now: u64) -> Result<(), Error> {
        let next = capture(c);
        if next.as_ref().map(|(scope, _)| scope) != self.scope.as_ref() {
            self.cancel();
            self.scope = next.as_ref().map(|(scope, _)| scope.clone());
            self.geometry = None;
            self.resource = None;
            self.read = None;
            self.lifetime = uuid::Uuid::new_v4().to_string();
        }
        self.finish_cancelled(update, now);
        let Some((scope, geometry)) = next else {
            self.cancel();
            self.finish_cancelled(update, now);
            return Ok(());
        };
        if c.actionable
            && !c.topology.awaiting_authority()
            && self
                .geometry
                .as_ref()
                .is_none_or(|old| !same_geometry(old, &geometry))
        {
            self.geometry = Some(geometry);
            self.resource = None;
            c.policy
                .bind_split_layout(&self.lifetime, scope.window.clone(), None)?;
            self.read_sequence = self.read_sequence.checked_add(1).ok_or(Error::Invalid)?;
            self.read = Some(SplitRead {
                sequence: self.read_sequence,
                window: scope.window,
            });
            if self
                .active
                .as_ref()
                .is_some_and(|g| g.operation.is_none() && g.successor.is_none())
            {
                self.fail(SplitPhase::Failed);
            }
        }
        if let Some(g) = self.active.as_mut()
            && let Some(operation) = &g.operation
        {
            if let Some(receipt) = update.intents.iter().find(|r| &r.operation_id == operation) {
                let successor = match &receipt.outcome {
                    IntentOutcome::Applied {
                        result: Some(result),
                    } if receipt.current => {
                        serde_json::from_value::<SplitSuccessor>(result["successor"].clone()).ok()
                    }
                    _ => None,
                };
                if g.cancelled {
                    self.fail(SplitPhase::Cancelled);
                    return Ok(());
                }
                let Some(successor) = successor else {
                    self.fail(SplitPhase::Failed);
                    return Ok(());
                };
                successor.validate()?;
                g.operation = None;
                g.successor = Some(successor);
                g.deadline = now.saturating_add(5000);
                // A successor is only a receipt. Read its canonical resource separately,
                // including unchanged rectangles with newly issued ancestry handles.
                self.resource = None;
                self.read_sequence = self.read_sequence.checked_add(1).ok_or(Error::Invalid)?;
                if let Some(scope) = &self.scope {
                    c.policy
                        .bind_split_layout(&self.lifetime, scope.window.clone(), None)?;
                    self.read = Some(SplitRead {
                        sequence: self.read_sequence,
                        window: scope.window.clone(),
                    });
                }
            } else if update.intent_timeouts.contains(operation) {
                self.fail(SplitPhase::Failed);
                return Ok(());
            }
        }
        self.advance(c, now)
    }
    /// Rebind an aborted broker read after same-window request advancement.
    /// Existing canonical handles remain valid; no mutation is replayed.
    pub fn rebind_request(&mut self) -> Result<(), Error> {
        if self.resource.is_some() || self.active.is_some() || self.geometry.is_none() {
            return Ok(());
        }
        let Some(scope) = &self.scope else {
            return Ok(());
        };
        self.read_sequence = self.read_sequence.checked_add(1).ok_or(Error::Invalid)?;
        self.read = Some(SplitRead {
            sequence: self.read_sequence,
            window: scope.window.clone(),
        });
        Ok(())
    }
    /// A failed metadata read disables handles until geometry changes; never retry it automatically.
    pub fn read_failed(&mut self, sequence: u64) {
        if sequence != self.read_sequence || self.resource.is_some() {
            return;
        }
        self.read = None;
        if self.active.as_ref().is_some_and(|g| g.operation.is_none()) {
            self.fail(SplitPhase::Failed);
        }
    }
    /// Install only the exact response to this geometry's read, never a mutation successor.
    pub fn accept_resource(
        &mut self,
        c: &mut Controller,
        sequence: u64,
        resource: SplitLayout,
    ) -> Result<bool, Error> {
        resource.validate()?;
        if !c.actionable || c.topology.awaiting_authority() {
            return Ok(false);
        }
        if sequence != self.read_sequence || self.resource.is_some() {
            return Ok(false);
        }
        let Some((scope, geometry)) = capture(c) else {
            return Ok(false);
        };
        if self.scope.as_ref() != Some(&scope)
            || self
                .geometry
                .as_ref()
                .is_none_or(|old| !same_geometry(old, &geometry))
            || resource.window != scope.window
            || !matches_geometry(&resource, &geometry)
        {
            return Ok(false);
        }
        c.policy
            .bind_split_layout(&self.lifetime, scope.window, Some(resource.clone()))?;
        self.resource = Some(resource);
        Ok(true)
    }
    pub fn begin(
        &mut self,
        c: &mut Controller,
        gesture: &str,
        target: SplitTarget,
        axis: Axis,
        now: u64,
    ) -> Result<(), Error> {
        if !c.actionable || c.topology.awaiting_authority() || !c.owns(Authority::Input) {
            return Err(Error::Invalid);
        }
        if self.busy()
            || c.pending_selection.is_some()
            || c.viewport.is_some()
            || c.inflight_viewport.is_some()
            || !c.policy.barrier_ready()
        {
            return Err(tmux_control::Error::Busy.into());
        }
        if uuid::Uuid::parse_str(gesture).is_err()
            || self
                .publication
                .as_ref()
                .is_some_and(|p| p.gesture == gesture)
        {
            return Err(Error::Invalid);
        }
        let Some((scope, geometry)) = capture(c) else {
            return Err(Error::Invalid);
        };
        let resource = self.resource.as_ref().ok_or(Error::Invalid)?;
        if self.scope.as_ref() != Some(&scope)
            || !matches_geometry(resource, &geometry)
            || resource.window != target.window
            || resource.layout_id != target.layout_id
            || !resource.splits.iter().any(|s| {
                s.split_id == target.split_id && s.axis == axis && s.boundary == target.boundary
            })
        {
            return Err(Error::Invalid);
        }
        self.active = Some(Gesture {
            id: gesture.into(),
            desired: target.boundary,
            target,
            axis,
            released: false,
            operation: None,
            successor: None,
            deadline: now.saturating_add(5000),
            geometry_requested: false,
            cancelled: false,
        });
        self.publish(SplitPhase::Dragging);
        self.advance(c, now)
    }
    pub fn release(
        &mut self,
        c: &mut Controller,
        gesture: &str,
        boundary: u16,
        now: u64,
    ) -> Result<(), Error> {
        if boundary > 4096 {
            return Err(Error::Invalid);
        }
        let g = self
            .active
            .as_mut()
            .filter(|g| g.id == gesture && !g.released)
            .ok_or(Error::Invalid)?;
        g.desired = boundary;
        g.released = true;
        self.advance(c, now)
    }
    pub fn cancel(&mut self) {
        if let Some(g) = self.active.as_mut() {
            if g.operation.is_some() {
                if !g.cancelled {
                    g.cancelled = true;
                    self.publish(SplitPhase::Cancelled);
                }
            } else {
                self.fail(SplitPhase::Cancelled);
            }
        }
    }
    // Accepted mutations remain correlated even after focus or membership is lost.
    fn finish_cancelled(&mut self, update: &Update, now: u64) {
        if self.active.as_ref().is_some_and(|g| {
            g.cancelled
                && (now >= g.deadline
                    || g.operation.as_ref().is_some_and(|id| {
                        update.intents.iter().any(|r| &r.operation_id == id)
                            || update.intent_timeouts.contains(id)
                    }))
        }) {
            self.fail(SplitPhase::Cancelled);
        }
    }
    fn advance(&mut self, c: &mut Controller, now: u64) -> Result<(), Error> {
        let Some(g) = self.active.as_ref() else {
            return Ok(());
        };
        if now >= g.deadline {
            self.fail(SplitPhase::Failed);
            return Ok(());
        }
        if g.operation.is_some() {
            return Ok(());
        }
        if !c.owns(Authority::Input)
            || capture(c).as_ref().map(|(scope, _)| scope) != self.scope.as_ref()
        {
            self.fail(SplitPhase::Failed);
            return Ok(());
        }
        if let Some(successor) = &g.successor {
            if self.resource.as_ref() != Some(&successor.resource) {
                return Ok(());
            }
            let boundary = successor
                .resource
                .splits
                .iter()
                .find(|s| s.split_id == successor.split_id)
                .ok_or(Error::Invalid)?
                .boundary;
            let target = SplitTarget {
                window: successor.resource.window.clone(),
                layout_id: successor.resource.layout_id.clone(),
                split_id: successor.split_id.clone(),
                boundary,
            };
            if let Some(g) = self.active.as_mut() {
                g.target = target;
                g.successor = None;
            }
            self.publish(SplitPhase::Settled);
            self.active = None;
            return Ok(());
        }
        if !g.released {
            return Ok(());
        }
        if g.desired == g.target.boundary {
            self.publish(SplitPhase::Settled);
            self.active = None;
            return Ok(());
        }
        if !c.actionable || c.topology.awaiting_authority() || !c.policy.barrier_ready() {
            return Ok(());
        }
        if !c.owns(Authority::Geometry) {
            if !g.geometry_requested {
                let command = match c.policy.request_authority(
                    Authority::Geometry,
                    &uuid::Uuid::new_v4().to_string(),
                    now,
                ) {
                    Ok(command) => command,
                    Err(tmux_control::Error::Busy) => return Ok(()),
                    Err(error) => return Err(error.into()),
                };
                c.send(command)?;
                if let Some(g) = self.active.as_mut() {
                    g.geometry_requested = true;
                }
            }
            return Ok(());
        }
        let resource = self.resource.as_ref().ok_or(Error::Invalid)?;
        if resource.layout_id != g.target.layout_id
            || !resource
                .splits
                .iter()
                .any(|s| s.split_id == g.target.split_id && s.axis == g.axis)
        {
            self.fail(SplitPhase::Failed);
            return Ok(());
        }
        let mut target = g.target.clone();
        target.boundary = g.desired;
        let operation = uuid::Uuid::new_v4().to_string();
        let command = c
            .policy
            .submit_intent(&operation, Intent::ResizeSplit { target }, now)?;
        if let Some(g) = self.active.as_mut() {
            g.operation = Some(operation);
            g.deadline = now.saturating_add(12000);
        }
        self.publish(SplitPhase::Pending);
        c.send(command)
    }
    fn publish(&mut self, phase: SplitPhase) {
        if let Some(g) = &self.active {
            self.revision = self.revision.saturating_add(1);
            self.publication = Some(SplitPublication {
                gesture: g.id.clone(),
                phase,
                revision: self.revision,
                boundary: g.target.boundary,
                target: matches!(phase, SplitPhase::Dragging | SplitPhase::Settled)
                    .then(|| g.target.clone()),
            });
        }
    }
    fn fail(&mut self, phase: SplitPhase) {
        self.publish(phase);
        self.active = None;
    }
}
fn capture(c: &Controller) -> Option<(Scope, Layout)> {
    if c.retired {
        return None;
    }
    let layout = c.topology.layouts().values().find(|l| {
        l.panes
            .iter()
            .any(|p| p.pane.as_deref() == Some(c.selected()))
    })?;
    if layout.zoomed {
        return None;
    }
    let links = c.topology.links()?;
    let link = links.links.iter().find(|link| {
        link.link_id == links.active_link_id
            && Some(&link.semantic_window_id) == layout.semantic_window_id.as_ref()
    })?;
    let mut members = BTreeMap::new();
    for p in &layout.panes {
        let id = p.pane.as_ref()?;
        let proof = c.current.get(id)?;
        proof.snapshot.as_ref()?;
        members.insert(
            id.clone(),
            Lifetime {
                generation: proof.identity.generation.clone(),
                incarnation: proof.identity.incarnation.clone(),
            },
        );
    }
    Some((
        Scope {
            window: WindowLink {
                live_session_id: links.live_session_id.clone(),
                link_id: link.link_id.clone(),
                expected_semantic_window_id: link.semantic_window_id.clone(),
                link_revision: links.link_revision,
            },
            members,
        },
        layout.clone(),
    ))
}
fn same_geometry(a: &Layout, b: &Layout) -> bool {
    a.cols == b.cols
        && a.rows == b.rows
        && a.pane_border_status == b.pane_border_status
        && a.panes.len() == b.panes.len()
        && a.panes.iter().all(|p| {
            b.panes.iter().any(|q| {
                p.pane == q.pane
                    && p.left == q.left
                    && p.top == q.top
                    && p.width == q.width
                    && p.height == q.height
            })
        })
}
fn matches_geometry(resource: &SplitLayout, layout: &Layout) -> bool {
    !layout.zoomed
        && resource.cols as usize == layout.cols
        && resource.rows as usize == layout.rows
        && resource.panes.len() == layout.panes.len()
        && resource.panes.iter().all(|p| {
            layout.panes.iter().any(|q| {
                q.pane.as_deref() == Some(&p.semantic_pane_id)
                    && q.left == usize::from(p.left)
                    && q.top == usize::from(p.top)
                    && q.width == usize::from(p.width)
                    && q.height == usize::from(p.height)
            })
        })
}
#[cfg(test)]
#[path = "tmux_controller_divider_tests.rs"]
mod tests;
