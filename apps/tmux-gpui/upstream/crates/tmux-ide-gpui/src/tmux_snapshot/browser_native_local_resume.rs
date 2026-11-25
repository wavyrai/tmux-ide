//! Card #878: a catalog started after the terminal loop ended picks up where
//! the window was: the same request, the same focus, and the open session,
//! found again by its live id once the first catalog lists it.
use super::*;

pub(super) struct Resume {
    session: String,
    pane: Option<String>,
}
impl Local {
    /// Seeds a new catalog with what the window was last shown.
    pub(super) fn resume_from(&mut self, seen: &Seen) {
        self.state.request = seen.request;
        self.foreground = seen.presence.0;
        self.presence_revision = seen.presence.1;
        if let Some(session) = seen.session.clone() {
            // The window stays on its workspace while the catalog loads.
            self.state.surface = Surface::Workspace;
            self.state.selected_session = Some(session.clone());
            self.state.status = reconnect::RECONNECTING.into();
            self.resume = Some(Resume {
                session,
                pane: seen.pane.clone(),
            });
        }
    }
    /// After the first catalog: reopens the session at the same request, its
    /// pane preferred. Whether it took over the publication.
    pub(super) fn resume_catalog(&mut self) -> Result<bool, Error> {
        let Some(Resume { session, pane }) = self.resume.take() else {
            return Ok(false);
        };
        let key = (self.targets.iter())
            .find(|(_, target)| target.live == session)
            .map(|(key, _)| key.clone());
        if let Some(key) = key {
            let request = self.state.request;
            self.open(request, key, pane)?;
            if matches!(self.stage, Some(Stage::Open { .. })) {
                return Ok(true);
            }
        }
        // The session is gone, or cannot be opened now: Home, as listed.
        self.state.surface = Surface::Home;
        self.state.selected_session = None;
        self.state.selected_pane = None;
        self.state.panes.clear();
        Ok(false)
    }
}
