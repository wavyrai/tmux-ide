//! Per-connection native state and ordered publication.
use super::*;
impl Active {
    pub(super) fn owner_completed(&mut self, completion: browser_native_owner::Completion) {
        self.action_status = match completion.outcome {
            herdr_client::tmux_controller::OwnerOutcome::Applied => None,
            herdr_client::tmux_controller::OwnerOutcome::TimedOut => {
                Some("Pane creation outcome unknown — refreshing")
            }
            _ => Some("Pane creation was not confirmed"),
        };
        self.reissue |= completion.reissue;
        self.preferred_pane = completion.target_pane;
    }
    pub(super) fn action(
        &mut self,
        pane: &str,
        token: &str,
        action: crate::tmux_snapshot::pane_actions::Action,
        now: u64,
    ) -> Result<(), NativeError> {
        use crate::tmux_snapshot::pane_actions::{Action, Harness};
        let owner_action = match action {
            Action::NewWindow => browser_native_owner::Action::NewWindow,
            Action::NewAgent { name, harness } => browser_native_owner::Action::NewAgent {
                name,
                harness: match harness {
                    Harness::Claude => browser_native_owner::Harness::Claude,
                    Harness::Codex => browser_native_owner::Harness::Codex,
                },
            },
            other => {
                self.actions.submit(
                    &mut self.controller,
                    &self.presentation,
                    browser_native_actions::ActionTarget {
                        pane,
                        token,
                        operation: &uuid::Uuid::new_v4().to_string(),
                    },
                    other,
                    now,
                )?;
                self.presentation.consume_action()?;
                return Ok(());
            }
        };
        self.owner.submit(
            &self.controller,
            &self.presentation,
            pane,
            Some(token),
            owner_action,
            now,
        )?;
        self.presentation.consume_action()?;
        Ok(())
    }
    pub(super) fn input(
        &mut self,
        pane: &str,
        token: Option<&str>,
        input: crate::tmux_snapshot::keys::Input,
        now: u64,
    ) -> Result<(), NativeError> {
        self.input.input(
            &mut self.controller,
            &mut self.presentation,
            browser_native_input::InputRequest {
                epoch: self.input_epoch,
                pane,
                token,
                input,
            },
            now,
        )?;
        Ok(())
    }
    pub(super) fn select(&mut self, pane: &str, request: u64, now: u64) -> Result<(), NativeError> {
        if request <= self.request {
            return Ok(());
        }
        self.input.select(
            &mut self.controller,
            &mut self.presentation,
            browser_native_input::SelectionRequest {
                epoch: self.input_epoch,
                pane,
                operation: uuid::Uuid::new_v4().to_string(),
                request,
            },
            now,
        )?;
        Ok(())
    }
    pub(super) fn poll(&mut self, state: &mut State, now: u64) -> Result<bool, NativeError> {
        if self.stream_interrupted {
            if let Some(done) = self.owner.poll_interrupted(now) {
                self.owner_completed(done);
                return Ok(true);
            }
            return Ok(false);
        }
        let prior_actions = state.pane_actions.clone();
        let prior_status = state.status.clone();
        let update = self.controller.poll(now)?;
        if let Some(value) = self.editor.poll(
            &self.controller,
            &self.presentation,
            self.request,
            update.presence_revision.unwrap_or(state.presence_revision),
            now,
        ) {
            self.editor_notice = Some(Command::NativeEditorCancel { value });
        }
        let prior_split = state.split_layout.clone();
        let prior_gesture = state.split_gesture.clone();
        if let Some(event) = self.owner.poll(&mut self.controller, now)? {
            match event {
                browser_native_owner::Event::Request(request) => {
                    self.owner_notice = Some(Command::NativeOwnerAction { request })
                }
                browser_native_owner::Event::Completed(completion) => {
                    self.owner_completed(completion)
                }
            }
        }
        if let Some(completion) = self.actions.poll(&mut self.controller, &update, now)? {
            self.reissue |= completion.reissue;
            if completion.outcome != herdr_client::tmux_controller::ActionOutcome::Applied {
                self.action_status = Some("Pane action was not applied");
            }
        }
        let mut selection_rejected = false;
        if let Some(notice) =
            self.input
                .complete(&mut self.controller, &mut self.presentation, &update, now)?
            && notice.request > self.request
        {
            let from_request = self.request;
            self.owner.update_request(notice.request)?;
            self.request = notice.request;
            if notice.selected {
                self.input_epoch = notice.request;
            }
            self.divider.rebind_request()?;
            let pane = self.controller.selected().to_owned();
            if notice.selected && notice.pane != pane {
                return Err(Error::Invalid("native selection acknowledgement mismatch").into());
            }
            state.request = notice.request;
            state.selected_pane = Some(pane.clone());
            selection_rejected = !notice.selected;
            state.input_target_rejected = selection_rejected;
            self.selection_notice = Some(Command::NativePaneSelected {
                id: self.id.clone(),
                from_request,
                request: notice.request,
                pane,
            });
        }
        if !self.catalog_only {
            self.divider.poll(&mut self.controller, &update, now)?;
            if let Some(read) = self.divider.take_read() {
                self.split_notice = Some(Command::NativeSplitLayout {
                    version: 1,
                    id: self.id.clone(),
                    request: self.request,
                    sequence: read.sequence,
                    window: read.window,
                });
            }
        }
        let graphics_changed = self
            .graphics
            .accept(update.graphics, update.graphics_placements)?;
        if state.request != self.request || state.selected_session.as_deref() != Some(&self.session)
        {
            return Ok(false);
        }
        let metadata_key = (
            self.request,
            update.presence_revision.unwrap_or(state.presence_revision),
            self.controller.selected().to_owned(),
        );
        let topology = self.controller.topology();
        if let Some(epoch) = topology.epoch()
            && !topology.awaiting_authority()
            && self.topology_sent.changed(
                metadata_key.0,
                metadata_key.1,
                &metadata_key.2,
                epoch,
                topology.layouts(),
            )
        {
            self.topology_notice = Some(Command::NativeTerminalCatalog {
                version: 1,
                id: self.id.clone(),
                request: self.request,
                pane: self.controller.selected().into(),
                live_session_id: self.session.clone(),
                generation: self.generation.clone(),
                presence_revision: metadata_key.1,
                layouts: topology.layouts().values().cloned().collect(),
            });
        }
        if self.catalog_only {
            return Ok(false);
        }
        let history_changed = self.presentation.tick_history(now);
        let prior = state.frame.clone();
        let ready = state.input_ready;
        let presence = state.presence_revision;
        #[cfg(target_os = "macos")]
        let surfaces_changed;
        #[cfg(not(target_os = "macos"))]
        let surfaces_changed = false;
        if let Some(window) = update.window {
            self.history
                .before_pane(&window.paint.selected_pane, &self.presentation);
            let mut applied = self.presentation.apply(
                state,
                &window,
                self.controller.input_ready(),
                update.presence_revision.unwrap_or(presence),
                now,
            )?;
            if self.history.after_pane(&mut self.presentation, now) {
                applied |= self.presentation.apply(
                    state,
                    &window,
                    self.controller.input_ready(),
                    update.presence_revision.unwrap_or(presence),
                    now,
                )?;
            }
            publish_pane_actions(
                state,
                &window.paint.selected_pane,
                window.paint.zoomed,
                self.presentation.action_revision(),
                self.actions.busy() || self.owner.busy() || self.divider.busy(),
            );
            if applied || graphics_changed {
                state.graphics = self
                    .graphics
                    .placements(&window, self.presentation.history_offset())?;
            }
            #[cfg(target_os = "macos")]
            {
                surfaces_changed =
                    self.surfaces
                        .apply(state, &window, self.presentation.history_offset())?;
            }
        } else {
            #[cfg(target_os = "macos")]
            {
                surfaces_changed = self.surfaces.clear(state);
            }
            self.presentation.invalidate_overlay();
            revoke(&mut None, state);
        }
        if selection_rejected {
            state.input_target_rejected = true;
        }
        // Attachment acceptance concerns coherent live authority. Restored
        // scrollback intentionally disables UI typing, but must not prevent
        // session navigation/history from acknowledging the live attachment.
        let attachment_ready =
            self.controller.input_ready() && state.frame.is_some() && !state.retained_preview;
        if attachment_ready && self.metadata_sent.as_ref() != Some(&metadata_key) {
            self.metadata_notice = Some(Command::NativeTerminalReady {
                version: 1,
                id: self.id.clone(),
                request: self.request,
                pane: self.controller.selected().into(),
                live_session_id: self.session.clone(),
                generation: self.generation.clone(),
                presence_revision: metadata_key.1,
                input_ready: true,
                coherent: true,
            });
            self.metadata_sent = Some(metadata_key);
        }
        state.diagnostics = if state.input_ready && !state.retained_preview {
            state.native_diagnostics.as_ref().and_then(|d| {
                d.versions(
                    &self.id,
                    self.request,
                    self.controller.selected(),
                    &self.generation,
                    state.presence_revision,
                )
            })
        } else {
            None
        };
        if state.input_ready {
            self.divider.publish(state);
        }
        if let Some(status) = self.action_status.take() {
            state.status = status.into();
        }
        if self.presentation.needs_materialization() {
            let pane = self.controller.selected().to_owned();
            self.controller.materialize_history(&pane)?;
        }
        self.history_notice = self.history.request(
            &mut self.presentation,
            &self.id,
            self.request,
            &self.session,
            now,
        )?;
        Ok(prior_split != state.split_layout
            || prior_gesture != state.split_gesture
            || prior_actions != state.pane_actions
            || prior_status != state.status
            || history_changed
            || graphics_changed
            || surfaces_changed
            || ready != state.input_ready
            || presence != state.presence_revision
            || match (prior.as_ref(), state.frame.as_ref()) {
                (Some(a), Some(b)) => !a.same(b),
                (None, None) => false,
                _ => true,
            })
    }
}
impl Drop for Active {
    fn drop(&mut self) {
        self.history.save(&self.presentation);
    }
}

fn publish_pane_actions(
    state: &mut State,
    selected: &str,
    zoomed: bool,
    action_revision: u64,
    busy: bool,
) {
    state.pane_actions = if busy {
        None
    } else {
        state
            .input_targets
            .iter()
            .find(|t| t.id == selected)
            .map(|t| PaneActions {
                id: t.id.clone(),
                token: crate::tmux_snapshot::browser_direct::action_token(
                    &t.token,
                    state.presence_revision,
                    action_revision,
                ),
                zoomed,
            })
    };
}
#[cfg(test)]
#[path = "browser_native_active_tests.rs"]
mod idle_tests;
