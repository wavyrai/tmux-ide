//! One run of the terminal loop: what it is given and what it leaves (card
//! #878). A supervisor starts a new run with what the last one saw.
use super::*;

/// What one run of the terminal loop is given. The window's command receiver
/// and mailbox are borrowed: they outlive the run, so a new run can take them.
pub(super) struct Run<'a> {
    pub(super) kitty: crate::tmux_snapshot::kitty_graphics::Store,
    pub(super) events: mpsc::Receiver<Incoming>,
    pub(super) commands: &'a mpsc::Receiver<Command>,
    pub(super) mailbox: &'a Mailbox,
    pub(super) hold_frames: bool,
    /// Starts the run's focus, and keeps what it last published.
    pub(super) seen: &'a mut Seen,
}
/// What the window was last shown: where a new run picks up (card #878).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Seen {
    pub(super) request: u64,
    /// The window's focus and its revision.
    pub(super) presence: (bool, u64),
    /// The open session's live id, on a workspace.
    pub(super) session: Option<String>,
    pub(super) pane: Option<String>,
}
impl Default for Seen {
    fn default() -> Self {
        Self {
            request: 0,
            presence: (true, 0),
            session: None,
            pane: None,
        }
    }
}
impl Seen {
    /// What the window is shown while a run that left nothing is replaced:
    /// where it was, with no stream and no input.
    pub(super) fn reconnecting(&self) -> State {
        let workspace = self.session.is_some();
        State {
            request: self.request,
            presence_revision: self.presence.1,
            surface: if workspace {
                Surface::Workspace
            } else {
                Surface::Home
            },
            selected_session: self.session.clone(),
            selected_pane: self.pane.clone(),
            status: "Connection lost. Reconnecting…".into(),
            ..State::default()
        }
    }
    pub(super) fn observe(&mut self, shown: &State, presence: (bool, u64)) {
        self.request = shown.request;
        self.presence = presence;
        let workspace = shown.surface == Surface::Workspace;
        self.session = shown.selected_session.clone().filter(|_| workspace);
        self.pane = shown.selected_pane.clone().filter(|_| workspace);
    }
}
/// Why a run ended, and the state it ended with, the stream revoked.
pub(super) struct Ended {
    pub(super) reason: &'static str,
    pub(super) state: State,
}
