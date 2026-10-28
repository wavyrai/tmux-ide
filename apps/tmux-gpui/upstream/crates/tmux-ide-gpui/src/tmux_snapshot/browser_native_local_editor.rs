//! Native editor click ownership. Selection and presence retire pending work;
//! replay tracking is bounded and belongs to a single terminal selection.
use super::*;
use crate::tmux_snapshot::browser_native_editor::{Cancel, Request, Response, Status};
use herdr_client::tmux_daemon::EditorTarget;
use std::collections::HashSet;
#[derive(Default)]
pub(super) struct Gate {
    highest: u64,
    used: HashSet<String>,
}
impl Gate {
    fn admit(
        &mut self,
        route: Option<&Route>,
        selected: Option<&str>,
        foreground: bool,
        presence: u64,
        request: &Request,
    ) -> Result<EditorTarget, Status> {
        let Some(route) = route else {
            return Err(Status::Stale);
        };
        if !foreground
            || request.presence_revision != presence
            || request.id != route.id
            || request.request != route.request
            || request.generation != route.target.scope.generation
            || selected != Some(request.pane.as_str())
            || request.version != 1
            || request.incarnation.is_empty()
            || request.sequence <= self.highest
            || self.used.len() >= 128
            || self.used.contains(&request.operation_id)
        {
            return Err(Status::Stale);
        }
        // Request is produced only after the controller resolves the current
        // displayed action token and pane lifetime, not deserialized from peer IO.
        self.highest = request.sequence;
        self.used.insert(request.operation_id.clone());
        Ok(EditorTarget {
            generation: route.target.scope.generation.clone(),
            workspace_name: route.workspace.clone(),
            live_session_id: route.target.live.clone(),
            semantic_pane_id: request.pane.clone(),
        })
    }
}
impl Local {
    pub(super) fn open_editor(&mut self, request: Request) -> Result<(), Error> {
        // A duplicate cannot settle or cancel the original in-flight action.
        if self.editor.used.contains(&request.operation_id) {
            return Ok(());
        }
        let target = self.editor.admit(
            self.active.as_ref(),
            self.state.selected_pane.as_deref(),
            self.foreground,
            self.presence_revision,
            &request,
        );
        let target = match target {
            Ok(target) => target,
            Err(status) => return self.emit(Incoming::Editor(Response::native(&request, status))),
        };
        if self.stage.is_some() {
            return self.emit(Incoming::Editor(Response::native(&request, Status::Busy)));
        }
        let Some(route) = &self.active else {
            return Ok(());
        };
        self.stage = Some(Stage::Editor {
            scope: route.target.scope.clone(),
            target,
            request,
        });
        Ok(())
    }
    pub(super) fn cancel_editor(&mut self, cancel: Option<&Cancel>) {
        let Some(Stage::Editor { request, .. }) = &self.stage else {
            return;
        };
        if cancel.is_some_and(|c| {
            c.version != 1
                || c.id != request.id
                || c.request != request.request
                || c.operation_id != request.operation_id
        }) {
            return;
        }
        self.worker.cancel();
        self.stage = None;
        self.submitted = false;
    }
    pub(super) fn editor_completed(
        &self,
        request: Request,
        result: Result<(), herdr_client::tmux_daemon::Error>,
    ) -> Result<(), Error> {
        if !self
            .active
            .as_ref()
            .is_some_and(|r| r.id == request.id && r.request == request.request)
            || !self.foreground
            || self.presence_revision != request.presence_revision
        {
            return Ok(());
        }
        let status = match result {
            Ok(()) => Status::Opened,
            Err(herdr_client::tmux_daemon::Error::Retired) => Status::Stale,
            Err(herdr_client::tmux_daemon::Error::UnsupportedPlatform) => Status::Unavailable,
            Err(_) => Status::Failed,
        };
        self.emit(Incoming::Editor(Response::native(&request, status)))
    }
}
#[cfg(test)]
#[path = "browser_native_local_editor_tests.rs"]
mod tests;
