//! Explicit history-header activation starts a new input gesture, never a replay.
use super::*;
use gpui::Window;

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn return_to_live(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The header callback already validates its painted frame and target.
        // This identity is not authority: buffered input still needs live targets.
        let target = self.browser_state.native_focus_target.clone();
        let session = self.browser_state.selected_session.clone();
        let (Some(target), Some(session)) = (target, session) else {
            self.queue_input(Input::Scroll(0), cx);
            return;
        };
        if !self.historical_selection_ready()
            || self.browser_state.selected_pane.as_ref() != Some(&target.id)
            || self.browser_state.input_target_rejected
        {
            return;
        }
        let command = browser::Command::Input {
            input_target: None,
            request: self.browser_request,
            id: target.id.clone(),
            input: Input::Scroll(0),
        };
        if self
            .browser_commands
            .as_ref()
            .is_none_or(|s| s.try_send(command).is_err())
        {
            self.interrupt_input(cx);
            return;
        }
        self.cancel_pending_input(cx);
        self.discard_composition(cx);
        self.input_interrupted = false;
        self.pending_input = Some(Pending {
            kind: Kind::History {
                offset: self.browser_state.history_offset,
            },
            request: self.browser_request,
            id: target.id,
            token: target.token,
            session,
            presence: self.browser_state.presence_revision,
            started: Instant::now(),
            inputs: Vec::new(),
            bytes: 0,
        });
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }
}
