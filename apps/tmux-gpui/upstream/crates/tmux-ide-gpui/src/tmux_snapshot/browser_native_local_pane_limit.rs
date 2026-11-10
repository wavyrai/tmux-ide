//! A session with more panes than the native stream carries can't be opened
//! here. Home stays live with the rest of its sessions and a notice that names
//! the session and says what to do instead (#754 follow-up).
use super::*;
use crate::tmux_snapshot::browser::NATIVE_STREAM_MAX_PANES;

impl Local {
    /// Refuses to open a session whose catalog pane count is already over the
    /// limit, before anything is sent to the daemon. Any open attempt clears
    /// the previous notice.
    pub(super) fn pane_limit_refused(&mut self, request: u64, key: &str) -> Result<bool, Error> {
        self.state.home_notice = None;
        if self.state.surface != Surface::Home {
            return Ok(false);
        }
        let Some((label, count)) = self.state.sessions.iter().find_map(|choice| {
            let count = choice.pane_count.filter(|c| *c > NATIVE_STREAM_MAX_PANES)?;
            (choice.id == key).then(|| (choice.label.clone(), count))
        }) else {
            return Ok(false);
        };
        self.state.request = request;
        self.state.home_notice = Some(self.too_many_panes(&label, count));
        self.publish()?;
        Ok(true)
    }
    /// Checks the panes an open returned. `None` lets the open continue. Over
    /// the limit, it goes back to a freshly loaded Home with the notice, the
    /// same as Refresh, so every other session stays usable.
    pub(super) fn pane_limit_exceeded(
        &mut self,
        target: &Target,
        panes: &[String],
    ) -> Option<Result<(), Error>> {
        if panes.is_empty() {
            return Some(self.unavailable("Session exceeds the native stream pane limit"));
        }
        let count = u64::try_from(panes.len()).unwrap_or(u64::MAX);
        if count <= NATIVE_STREAM_MAX_PANES {
            return None;
        }
        let label = (self.state.sessions.iter())
            .find(|choice| choice.id == target.live)
            .map_or_else(|| "This session".into(), |choice| choice.label.clone());
        let notice = self.too_many_panes(&label, count);
        let request = self.state.request;
        Some(self.home(request).and_then(|()| {
            self.state.home_notice = Some(notice);
            self.publish()
        }))
    }
    /// Home's own trouble outranks the notice: once Home reconnects, stops
    /// on a fault, or recovers an open session, the notice is dropped for
    /// good so the strip says what is happening now.
    pub(super) fn pane_limit_superseded(&mut self) {
        if self.home.active() || self.home.fault().is_some() || self.recovery.is_some() {
            self.state.home_notice = None;
        }
    }
    fn too_many_panes(&self, label: &str, count: u64) -> String {
        // No single command attaches reliably: a managed install's tmux is
        // bundled off PATH, and the session's server may not be on tmux's
        // default socket. So the notice names the machine, not a command.
        let place = if self.machine_id == "local" {
            "in Terminal".to_string()
        } else {
            format!("in a terminal on {}", self.machine_label)
        };
        format!(
            "“{label}” has {count} panes. This app opens sessions with up to \
             {NATIVE_STREAM_MAX_PANES}. Close panes until it has {NATIVE_STREAM_MAX_PANES} \
             or fewer, or attach to it with tmux {place}."
        )
    }
}
