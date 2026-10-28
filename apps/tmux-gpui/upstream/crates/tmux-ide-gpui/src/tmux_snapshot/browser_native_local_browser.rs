//! Separate bounded browser RPC worker; terminal delivery never waits for it.
use super::*;
use herdr_client::tmux_daemon::{BrowserCommand, EditorTarget};
#[derive(Default)]
pub(super) struct Gate {
    worker: Option<CatalogWorker>,
    pending: Option<(String, u64, String)>,
    writing: bool,
    reads: std::collections::VecDeque<(u64, String)>,
    queued: Option<(String, u64, String, BrowserCommand)>,
}
impl Local {
    pub(super) fn browser_controls(
        &mut self,
        request: u64,
        pane: String,
        command: Option<BrowserCommand>,
    ) -> Result<(), Error> {
        let Some(route) = self.active.as_ref().filter(|r| r.request == request) else {
            return Ok(());
        };
        if !self.foreground || !self.state.browser_pane_visible(&pane) {
            return Ok(());
        }
        if let Some(command) = &command {
            let Some(state) = self.state.browser_controls.get(&pane) else {
                return Ok(());
            };
            if !command.valid()
                || !state.enabled
                || command.instance != state.instance
                || command.revision != state.revision
                || command.tab != state.tab
                || command.pane != state.pane
            {
                return Ok(());
            }
        }
        if self.browser_controls.pending.is_some() {
            if command.is_none()
                && self.browser_controls.reads.len() < 24
                && !self
                    .browser_controls
                    .reads
                    .iter()
                    .any(|(r, p)| *r == request && p == &pane)
            {
                self.browser_controls
                    .reads
                    .push_back((request, pane.clone()));
            }
            // A read may be in flight when a user clicks. Keep one captured intent,
            // then revalidate it against the reply before dispatching it once.
            if !self.browser_controls.writing
                && self.browser_controls.queued.is_none()
                && let Some(command) = command
            {
                self.browser_controls.queued = Some((route.id.clone(), request, pane, command));
            }
            return Ok(());
        }
        self.browser_controls.writing = command.is_some();
        if self.browser_controls.worker.is_none() {
            self.browser_controls.worker = Some(CatalogWorker::spawn_source(
                self.sources.observation_source()?,
            )?);
        }
        let action = CatalogAction::NativeBrowser {
            scope: route.target.scope.clone(),
            target: EditorTarget {
                generation: route.target.scope.generation.clone(),
                workspace_name: route.workspace.clone(),
                live_session_id: route.target.live.clone(),
                semantic_pane_id: pane.clone(),
            },
            command,
        };
        if let Some(worker) = &mut self.browser_controls.worker {
            worker.submit(action)?;
            self.browser_controls.pending = Some((route.id.clone(), request, pane));
        }
        Ok(())
    }
    pub(super) fn browser_controls_tick(&mut self) -> Result<(), Error> {
        // Closed/replaced panes must not accumulate observations over a long session.
        let panes = &self.state.panes;
        self.state
            .browser_controls
            .retain(|id, _| panes.iter().any(|pane| &pane.id == id));
        let Some(worker) = &mut self.browser_controls.worker else {
            return Ok(());
        };
        let Some(result) = worker.poll()? else {
            return Ok(());
        };
        let Some((id, request, pane)) = self.browser_controls.pending.take() else {
            return Ok(());
        };
        let queued = self.browser_controls.queued.take();
        self.browser_controls.writing = false;
        if !self.foreground
            || !self
                .active
                .as_ref()
                .is_some_and(|r| r.id == id && r.request == request)
            || !self.state.browser_pane_visible(&pane)
        {
            return Ok(());
        }
        let previous = self.state.browser_controls.get(&pane).cloned();
        match result {
            Ok(CatalogResult::NativeBrowser(Some(state))) => {
                self.state.browser_controls.insert(pane.clone(), state);
            }
            _ => {
                self.state.browser_controls.remove(&pane);
            }
        }
        if self.state.browser_controls.get(&pane) != previous.as_ref() {
            self.publish()?;
        }
        if let Some((queued_id, queued_request, queued_pane, command)) = queued
            && queued_id == id
            && queued_request == request
        {
            self.browser_controls(queued_request, queued_pane, Some(command))?;
        }
        while self.browser_controls.pending.is_none() {
            let Some((request, pane)) = self.browser_controls.reads.pop_front() else {
                break;
            };
            self.browser_controls(request, pane, None)?;
        }
        Ok(())
    }
}
