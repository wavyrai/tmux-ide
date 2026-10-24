//! Captured native pane-action tokens. Owner HTTP actions stay with the catalog broker.
use super::{browser_direct::NativePresentation, divider, pane_actions};
use herdr_client::{
    tmux_control::{Axis, Direction, Zoom},
    tmux_controller::{ActionCompletion, ActionState, Controller, PaneAction, Update},
};
#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error("native pane action target is stale")]
    Stale,
    #[error("pane action requires the owner HTTP broker")]
    BrokerRequired,
    #[error("native pane action failed")]
    Controller(#[from] herdr_client::tmux_controller::Error),
}
/// Captured pane identity and operation identity travel together through admission.
pub(super) struct ActionTarget<'a> {
    pub pane: &'a str,
    pub token: &'a str,
    pub operation: &'a str,
}
#[derive(Default)]
pub(super) struct ActionOwner {
    state: ActionState,
}
impl ActionOwner {
    pub fn busy(&self) -> bool {
        self.state.busy()
    }
    pub fn submit(
        &mut self,
        c: &mut Controller,
        p: &NativePresentation,
        target: ActionTarget<'_>,
        action: pane_actions::Action,
        now: u64,
    ) -> Result<(), Error> {
        let ActionTarget {
            pane,
            token,
            operation,
        } = target;
        let action = adapt(action)?;
        let lifetime = p.resolve_action(pane, token).ok_or(Error::Stale)?;
        self.state
            .submit(c, pane, &lifetime, operation, action, now)?;
        Ok(())
    }
    pub fn resize(
        &mut self,
        c: &mut Controller,
        p: &NativePresentation,
        target: ActionTarget<'_>,
        axis: divider::Axis,
        cells: u16,
        now: u64,
    ) -> Result<(), Error> {
        let ActionTarget {
            pane,
            token,
            operation,
        } = target;
        let lifetime = p.resolve(pane, Some(token)).ok_or(Error::Stale)?;
        self.state.submit(
            c,
            pane,
            &lifetime,
            operation,
            PaneAction::Resize {
                axis: match axis {
                    divider::Axis::Cols => Axis::Cols,
                    divider::Axis::Rows => Axis::Rows,
                },
                cells,
            },
            now,
        )?;
        Ok(())
    }
    pub fn poll(
        &mut self,
        c: &mut Controller,
        update: &Update,
        now: u64,
    ) -> Result<Option<ActionCompletion>, Error> {
        Ok(self.state.poll(c, update, now)?)
    }
    pub fn interrupted(&mut self) -> Option<ActionCompletion> {
        self.state.interrupted()
    }
    pub fn focus_loss(&mut self) -> Option<ActionCompletion> {
        self.state.cancel_waiting()
    }
}
fn adapt(action: pane_actions::Action) -> Result<PaneAction, Error> {
    Ok(match action {
        pane_actions::Action::Rename { name } => PaneAction::Rename(name),
        pane_actions::Action::Zoom { desired } => PaneAction::Zoom(match desired {
            pane_actions::Zoom::Zoomed => Zoom::Zoomed,
            pane_actions::Zoom::Unzoomed => Zoom::Unzoomed,
        }),
        pane_actions::Action::Split { direction } => PaneAction::Split(match direction {
            pane_actions::SplitDirection::Right => Direction::Right,
            pane_actions::SplitDirection::Down => Direction::Down,
        }),
        pane_actions::Action::Close => PaneAction::Close,
        pane_actions::Action::NewWindow | pane_actions::Action::NewAgent { .. } => {
            return Err(Error::BrokerRequired);
        }
    })
}
#[cfg(test)]
#[path = "browser_native_actions_tests.rs"]
mod tests;
