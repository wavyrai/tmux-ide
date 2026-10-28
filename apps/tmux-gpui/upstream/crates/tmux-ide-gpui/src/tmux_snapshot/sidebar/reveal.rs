//! Herdr's one-time selection reveal, independent of routing and keyboard focus.
use super::*;

#[derive(Clone, PartialEq, Eq)]
enum Identity {
    Session(String),
    FleetSession(String, String, Option<(String, String)>),
    FleetAgent(String),
    Pane(String, String),
}
fn identity(target: &Target) -> Option<Identity> {
    Some(match target {
        Target::Session(id) => Identity::Session(id.clone()),
        Target::FleetSession {
            machine,
            id,
            server,
            ..
        } => Identity::FleetSession(machine.clone(), id.clone(), server.clone()),
        Target::FleetAgent { key, .. } => Identity::FleetAgent(key.clone()),
        Target::Pane { session, id } => Identity::Pane(session.clone(), id.clone()),
        Target::FleetServer { .. } | Target::Collapse { .. } => return None,
    })
}

#[derive(Default)]
pub(super) struct Reveal {
    selected: Option<Identity>,
    measured_rows: Vec<Option<Identity>>,
    retry_scheduled: bool,
    pending: Option<Identity>,
}
impl Reveal {
    fn prepare(
        &mut self,
        selected: &Identity,
        layout_changed: bool,
        keyboard_active: bool,
    ) -> bool {
        if keyboard_active {
            // Explicit keyboard movement owns reveal. Escape must not pull the
            // list back to the terminal's unchanged authoritative selection.
            self.selected = Some(selected.clone());
            self.pending = None;
            self.retry_scheduled = false;
            return false;
        }
        if self.selected.as_ref() == Some(selected) {
            return false;
        }
        if layout_changed || self.pending.as_ref() != Some(selected) {
            self.pending = Some(selected.clone());
            self.retry_scheduled = false;
        }
        true
    }

    pub(super) fn update(
        &mut self,
        rows: &[Row],
        scroll: &ScrollHandle,
        keyboard_active: bool,
        window: &mut Window,
    ) {
        let identities: Vec<_> = rows
            .iter()
            .map(|row| row.target.as_ref().and_then(identity))
            .collect();
        let selected = rows.iter().enumerate().find_map(|(index, row)| {
            row.selected
                .then(|| identities[index].clone().map(|id| (index, id)))
                .flatten()
        });
        let layout_changed = identities != self.measured_rows;
        self.measured_rows = identities;
        let Some((index, selected)) = selected else {
            self.selected = None;
            self.pending = None;
            self.retry_scheduled = false;
            return;
        };
        if !self.prepare(&selected, layout_changed, keyboard_active) {
            return;
        }
        // Bounds describe the preceding paint. Never reveal a new identity
        // using another row's old rectangle after a topology change.
        if layout_changed
            || scroll.bounds().size.height <= px(0.)
            || scroll.bounds_for_item(index + 1).is_none()
        {
            if !self.retry_scheduled {
                self.retry_scheduled = true;
                window.request_animation_frame();
            }
            return;
        }
        let Some(bounds) = scroll.bounds_for_item(index + 1) else {
            return;
        };
        let offset = scroll.offset().y;
        let visible = bounds.bottom() + offset > scroll.bounds().top()
            && bounds.top() + offset < scroll.bounds().bottom();
        // Like Herdr, leave even a partially visible selection where the user
        // placed it; only a newly selected off-screen row needs uncovering.
        if !visible {
            scroll.scroll_to_item(index + 1);
        }
        self.selected = Some(selected);
        self.pending = None;
        self.retry_scheduled = false;
    }
}

#[cfg(test)]
#[path = "reveal_state_tests.rs"]
mod tests;
