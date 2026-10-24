use super::*;
use tmux_control::{Intent, IntentCompletion, IntentOutcome, WindowLink};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    pane: String,
    lifetime: Lifetime,
    window: String,
    link: Option<WindowLink>,
}
pub(super) struct PendingSelection {
    operation_id: String,
    source: Target,
    target: Target,
}
#[derive(Debug)]
pub struct SelectionCompletion {
    pub operation_id: String,
    pub pane: String,
    pub selected: bool,
}
fn resolve(
    topology: &Topology,
    current: &BTreeMap<String, Arc<CommittedPane>>,
    pane: &str,
) -> Option<Target> {
    if topology.awaiting_authority() {
        return None;
    }
    let mut layouts = topology
        .layouts()
        .values()
        .filter(|l| l.panes.iter().any(|p| p.pane.as_deref() == Some(pane)));
    let layout = layouts.next()?;
    if layouts.next().is_some() {
        return None;
    }
    let window = layout.semantic_window_id.clone()?;
    let committed = current.get(pane)?;
    committed.snapshot.as_ref()?;
    let link = if let Some(links) = topology.links() {
        let mut matching = links
            .links
            .iter()
            .filter(|l| l.semantic_window_id == window);
        let first = matching.next()?;
        // Linked windows may appear more than once. Use the exact active link if
        // present; otherwise ambiguity cannot authorize native pane selection.
        let selected = if first.link_id == links.active_link_id {
            first
        } else if let Some(active) = matching.clone().find(|l| l.link_id == links.active_link_id) {
            active
        } else if matching.next().is_none() {
            first
        } else {
            return None;
        };
        Some(WindowLink {
            live_session_id: links.live_session_id.clone(),
            link_id: selected.link_id.clone(),
            expected_semantic_window_id: window.clone(),
            link_revision: links.link_revision,
        })
    } else {
        None
    };
    Some(Target {
        pane: pane.into(),
        lifetime: Lifetime {
            generation: committed.identity.generation.clone(),
            incarnation: committed.identity.incarnation.clone(),
        },
        window,
        link,
    })
}
impl Controller {
    pub fn selected(&self) -> &str {
        &self.selected
    }
    pub fn selection_pending(&self) -> bool {
        self.pending_selection.is_some()
    }
    /// A target must already belong to the same coherent, leased native window.
    /// The returned lifetime is a local fence, not authority to send input.
    pub fn selectable(&self, pane: &str) -> Option<Lifetime> {
        if !self.actionable || self.retired || self.pending_selection.is_some() {
            return None;
        }
        let source = resolve(&self.topology, &self.current, &self.selected)?;
        let target = resolve(&self.topology, &self.current, pane)?;
        (source.window == target.window && source.link == target.link).then_some(target.lifetime)
    }
    /// false means already selected; true means one ACK-fenced selection was sent.
    /// Busy preserves the caller's barrier; never retry a sent operation automatically.
    pub fn select_pane(
        &mut self,
        pane: &str,
        expected: &Lifetime,
        operation_id: &str,
        now: u64,
    ) -> Result<bool, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        if self.pending_selection.is_some() || !self.policy.barrier_ready() {
            return Err(tmux_control::Error::Busy.into());
        }
        if !self.owns(Authority::Input) {
            return Err(tmux_control::Error::Authority.into());
        }
        if self.selectable(pane).as_ref() != Some(expected) {
            return Err(tmux_control::Error::Lifetime.into());
        }
        if self.selected == pane {
            return Ok(false);
        }
        let source =
            resolve(&self.topology, &self.current, &self.selected).ok_or(Error::Invalid)?;
        let target = resolve(&self.topology, &self.current, pane).ok_or(Error::Invalid)?;
        let command = self.policy.submit_intent(
            operation_id,
            Intent::Select {
                pane: pane.into(),
                window_link: target.link.clone(),
            },
            now,
        )?;
        self.pending_selection = Some(PendingSelection {
            operation_id: operation_id.into(),
            source,
            target,
        });
        self.actionable = false;
        self.send(command)?;
        Ok(true)
    }
    pub(super) fn finish_selection(
        &mut self,
        intents: &[IntentCompletion],
        timeouts: &[String],
    ) -> Result<Option<SelectionCompletion>, Error> {
        let Some(pending) = self.pending_selection.as_ref() else {
            return Ok(None);
        };
        let receipt = intents
            .iter()
            .find(|i| i.operation_id == pending.operation_id);
        if receipt.is_none() && !timeouts.contains(&pending.operation_id) {
            return Ok(None);
        }
        let selected = receipt.is_some_and(|receipt| {
            receipt.current && matches!(&receipt.outcome, IntentOutcome::Applied { .. })
        }) && self.desired_presence.is_none()
            && self.policy.owns(Authority::Input)
            && resolve(&self.topology, &self.current, &pending.source.pane).as_ref()
                == Some(&pending.source)
            && resolve(&self.topology, &self.current, &pending.target.pane).as_ref()
                == Some(&pending.target);
        let completion = SelectionCompletion {
            operation_id: pending.operation_id.clone(),
            pane: pending.target.pane.clone(),
            selected,
        };
        if selected {
            self.presentation = Presentation::new(pending.target.pane.clone())?;
            self.selected = pending.target.pane.clone();
        }
        self.pending_selection = None;
        Ok(Some(completion))
    }
}
