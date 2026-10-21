//! A baseline miss revokes terminal input while keeping the publication reader alive.
use super::*;
impl Reader {
    pub(super) fn recover(&mut self, p: &Publication, epoch: String, base_seq: u64) -> State {
        if self.request != p.request {
            self.resync_epoch = None;
        }
        if self.resync_epoch.as_ref() != Some(&epoch) {
            self.resync = Some(Command::FrameResync {
                connection: p.connection.clone(),
                request: p.request,
                epoch: epoch.clone(),
                base_seq,
            });
            self.resync_epoch = Some(epoch);
        }
        self.frames.reset();
        self.connection = Some(p.connection.clone());
        self.sequence = p.sequence;
        self.request = p.request;
        State {
            surface: Surface::Workspace,
            request: p.request,
            presence_revision: p.presence_revision,
            sessions: p.sessions.clone(),
            panes: p.panes.clone(),
            selected_session: p.selected_session.clone(),
            status: String::from("Resynchronizing terminal"),
            ..State::default()
        }
    }
}
