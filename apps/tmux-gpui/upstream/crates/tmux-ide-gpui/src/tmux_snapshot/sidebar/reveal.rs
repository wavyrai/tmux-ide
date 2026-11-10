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
        Target::Home => return None,
        Target::HomeAgent { key, .. } => Identity::FleetAgent(key.clone()),
    })
}

#[derive(Default)]
pub(super) struct Reveal {
    selected: Option<Identity>,
    measured_rows: Vec<Option<Identity>>,
    retry_scheduled: bool,
    pending: Option<Identity>,
    /// The reveal gliding over SCROLL_GLIDE (#761).
    glide: Option<crate::tmux_snapshot::motion::Glide>,
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
        cx: &App,
    ) {
        self.glide(scroll, keyboard_active, window, cx);
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
            let target = crate::tmux_snapshot::motion::reveal_offset(
                (scroll.bounds().top(), scroll.bounds().bottom()),
                (bounds.top(), bounds.bottom()),
                offset,
                scroll.max_offset().y,
            );
            if cx.reduce_motion() {
                scroll.scroll_to_item(index + 1);
            } else if self.glide.is_none_or(|g| g.target() != target) {
                let now = cx.background_executor().now();
                self.glide = Some(crate::tmux_snapshot::motion::Glide::new(
                    offset, target, now,
                ));
                window.request_animation_frame();
            }
        }
        self.selected = Some(selected);
        self.pending = None;
        self.retry_scheduled = false;
    }
}

impl Reveal {
    /// Moves a running glide on one frame. The user's own scrolling, or
    /// the keyboard taking over, ends it where it is.
    fn glide(
        &mut self,
        scroll: &ScrollHandle,
        keyboard_active: bool,
        window: &mut Window,
        cx: &App,
    ) {
        let Some(glide) = self.glide.as_mut().filter(|_| !keyboard_active) else {
            self.glide = None;
            return;
        };
        let offset = scroll.offset();
        match glide.step(offset.y, cx.background_executor().now(), cx.reduce_motion()) {
            Some((y, more)) => {
                scroll.set_offset(point(offset.x, y));
                if more {
                    window.request_animation_frame();
                } else {
                    self.glide = None;
                }
            }
            None => self.glide = None,
        }
    }
}

#[cfg(test)]
#[path = "reveal_state_tests.rs"]
mod tests;
