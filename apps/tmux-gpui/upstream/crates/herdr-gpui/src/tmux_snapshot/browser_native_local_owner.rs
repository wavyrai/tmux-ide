//! Semantic owner actions arrive only after the controller's authority barrier.
//! This layer binds them to the active catalog route and never retries a mutation.
use super::*;
use crate::tmux_snapshot::browser_native_owner::{Action, Harness, Request, Response};
use herdr_client::tmux_daemon::{AgentHarness, CreatedPane, NewPane, PaneCreation};
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
        pane: Option<&str>,
        foreground: bool,
        request: &Request,
    ) -> Option<(ServerScope, uuid::Uuid, PaneCreation)> {
        let route = route?;
        if !foreground
            || request.version != 1
            || request.id != route.id
            || request.request != route.request
            || request.generation != route.target.scope.generation
            || request.live_session_id != route.target.live
            || pane != Some(request.pane.as_str())
            || request.sequence <= self.highest
            || self.used.len() >= 256
            || self.used.contains(&request.operation_id)
        {
            return None;
        }
        let operation = uuid::Uuid::parse_str(&request.operation_id).ok()?;
        self.highest = request.sequence;
        self.used.insert(request.operation_id.clone());
        let kind = match &request.action {
            Action::NewWindow => NewPane::Terminal,
            Action::NewAgent { name, harness } => NewPane::Agent {
                name: name.clone(),
                harness: match harness {
                    Harness::Claude => AgentHarness::Claude,
                    Harness::Codex => AgentHarness::Codex,
                },
            },
        };
        Some((
            route.target.scope.clone(),
            operation,
            PaneCreation {
                workspace_name: route.workspace.clone(),
                live_session_id: route.target.live.clone(),
                source_pane: request.pane.clone(),
                kind,
            },
        ))
    }
}
impl Local {
    pub(super) fn owner_action(&mut self, request: Request) -> Result<(), Error> {
        // A duplicate cannot settle or cancel the original in-flight action.
        if self.owner.used.contains(&request.operation_id) {
            return Ok(());
        }
        let Some((scope, operation_id, creation)) = self.owner.admit(
            self.active.as_ref(),
            self.state.selected_pane.as_deref(),
            self.foreground,
            &request,
        ) else {
            return self.emit(Incoming::NativeOwner(Box::new(Response::native(
                &request, None, false,
            ))));
        };
        if self.stage.is_some() {
            return self.emit(Incoming::NativeOwner(Box::new(Response::native(
                &request, None, true,
            ))));
        }
        self.stage = Some(Stage::Owner {
            scope,
            operation_id,
            creation,
            request,
        });
        Ok(())
    }
    pub(super) fn owner_completed(
        &self,
        request: Request,
        receipt: Option<CreatedPane>,
    ) -> Result<(), Error> {
        if !self
            .active
            .as_ref()
            .is_some_and(|r| r.id == request.id && r.request == request.request)
        {
            return Ok(());
        }
        self.emit(Incoming::NativeOwner(Box::new(Response::native(
            &request, receipt, false,
        ))))
    }
}
#[cfg(test)]
#[path = "browser_native_local_owner_tests.rs"]
mod tests;
