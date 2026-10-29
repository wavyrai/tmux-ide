//! Separate bounded browser RPC worker; terminal delivery never waits for it.
use super::*;
use crate::tmux_snapshot::browser_toolbar::{Mark, rebase};
use herdr_client::tmux_daemon::{BrowserCommand, BrowserState, EditorTarget};
use std::time::{Duration, Instant};
/// Consecutive failed reads after which kept controls are dropped (the browser is likely gone).
const STALE_LIMIT: u8 = 4;
/// How long a lost click stays reported in the pane header.
const REJECTED_FOR: Duration = Duration::from_secs(3);
/// One dispatched command and the observation the user clicked on.
pub(super) struct Write {
    command: BrowserCommand,
    basis: BrowserState,
    retried: bool,
}
#[derive(Default)]
pub(super) struct Gate {
    worker: Option<CatalogWorker>,
    pending: Option<(String, u64, String)>,
    writing: Option<Write>,
    reads: std::collections::VecDeque<(u64, String)>,
    queued: Option<(String, u64, String, BrowserCommand)>,
    /// A failed write waiting for a fresh read before its single retry.
    retry: Option<(String, u64, String, Write)>,
    /// The observation each pane's latest read replaced, so an older click can be re-targeted.
    previous: BTreeMap<String, BrowserState>,
    failures: BTreeMap<String, u8>,
    rejected: BTreeMap<String, Instant>,
    rejections: u64,
}
impl Local {
    pub(super) fn browser_controls(
        &mut self,
        request: u64,
        pane: String,
        command: Option<BrowserCommand>,
    ) -> Result<(), Error> {
        if self.active.as_ref().is_none_or(|r| r.request != request)
            || !self.foreground
            || !self.state.browser_pane_visible(&pane)
        {
            return Ok(());
        }
        let write = match command {
            Some(command) => match self.admit(&pane, command) {
                Some(write) => Some(write),
                None => return self.reject_browser(&pane),
            },
            None => None,
        };
        self.dispatch_browser(request, pane, write)
    }
    /// Admits a click against the current observation, re-targeting one made on the
    /// observation just replaced when it still means the same thing.
    fn admit(&self, pane: &str, command: BrowserCommand) -> Option<Write> {
        let current = self.state.browser_controls.get(pane)?;
        if !command.valid() || !current.enabled || command.pane != current.pane {
            return None;
        }
        if command.revision == current.revision
            && command.instance == current.instance
            && command.tab == current.tab
        {
            return Some(Write {
                command,
                basis: current.clone(),
                retried: false,
            });
        }
        let basis = self.browser_controls.previous.get(pane).filter(|b| {
            b.revision == command.revision && b.instance == command.instance && b.tab == command.tab
        })?;
        Some(Write {
            command: rebase(&command, basis, current)?,
            basis: basis.clone(),
            retried: false,
        })
    }
    fn dispatch_browser(
        &mut self,
        request: u64,
        pane: String,
        write: Option<Write>,
    ) -> Result<(), Error> {
        let Some(route) = self.active.as_ref().filter(|r| r.request == request) else {
            return Ok(());
        };
        if self.browser_controls.pending.is_some() {
            if write.is_none()
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
            if self.browser_controls.writing.is_none()
                && self.browser_controls.queued.is_none()
                && let Some(write) = write
            {
                self.browser_controls.queued =
                    Some((route.id.clone(), request, pane, write.command));
            }
            return Ok(());
        }
        if write.is_some()
            && self.browser_controls.rejected.remove(&pane).is_some()
            && matches!(self.state.browser_marks.get(&pane), Some(Mark::Rejected(_)))
        {
            self.state.browser_marks.remove(&pane);
        }
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
            command: write.as_ref().map(|w| w.command.clone()),
        };
        if let Some(worker) = &mut self.browser_controls.worker {
            worker.submit(action)?;
            self.browser_controls.pending = Some((route.id.clone(), request, pane));
            self.browser_controls.writing = write;
        }
        Ok(())
    }
    /// A click that cannot be applied is reported in the header, never dropped silently.
    fn reject_browser(&mut self, pane: &str) -> Result<(), Error> {
        self.browser_controls.rejections += 1;
        self.browser_controls
            .rejected
            .insert(pane.into(), Instant::now());
        self.state.browser_marks.insert(
            pane.into(),
            Mark::Rejected(self.browser_controls.rejections),
        );
        self.publish()
    }
    pub(super) fn browser_controls_tick(&mut self) -> Result<(), Error> {
        // Closed/replaced panes must not accumulate observations over a long session.
        let panes = &self.state.panes;
        let open = |id: &String| panes.iter().any(|pane| &pane.id == id);
        self.state.browser_controls.retain(|id, _| open(id));
        self.state.browser_marks.retain(|id, _| open(id));
        self.browser_controls.previous.retain(|id, _| open(id));
        self.browser_controls.failures.retain(|id, _| open(id));
        let expired: Vec<String> = self
            .browser_controls
            .rejected
            .iter()
            .filter(|(_, at)| at.elapsed() >= REJECTED_FOR)
            .map(|(pane, _)| pane.clone())
            .collect();
        for pane in &expired {
            self.browser_controls.rejected.remove(pane);
            if matches!(self.state.browser_marks.get(pane), Some(Mark::Rejected(_))) {
                self.state.browser_marks.remove(pane);
            }
        }
        if !expired.is_empty() {
            self.publish()?;
        }
        let Some(worker) = &mut self.browser_controls.worker else {
            return Ok(());
        };
        let Some(result) = worker.poll()? else {
            return Ok(());
        };
        self.browser_controls_reply(result)
    }
    pub(super) fn browser_controls_reply(
        &mut self,
        result: Result<CatalogResult, herdr_client::tmux_daemon::Error>,
    ) -> Result<(), Error> {
        let Some((id, request, pane)) = self.browser_controls.pending.take() else {
            return Ok(());
        };
        let queued = self.browser_controls.queued.take();
        let write = self.browser_controls.writing.take();
        let wrote = write.is_some();
        let retry = self
            .browser_controls
            .retry
            .take_if(|(i, r, p, _)| *i == id && *r == request && *p == pane);
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
        let mark = self.state.browser_marks.get(&pane).copied();
        let observed = match result {
            Ok(CatalogResult::NativeBrowser(Some(state))) => {
                self.browser_controls.failures.remove(&pane);
                if mark == Some(Mark::Stale) {
                    self.state.browser_marks.remove(&pane);
                }
                if let Some(old) = previous.as_ref().filter(|old| **old != state) {
                    self.browser_controls
                        .previous
                        .insert(pane.clone(), old.clone());
                }
                self.state
                    .browser_controls
                    .insert(pane.clone(), state.clone());
                Some(state)
            }
            Ok(CatalogResult::NativeBrowser(None)) => {
                self.forget_browser(&pane);
                None
            }
            _ => {
                match write {
                    // The daemon reports a stale revision like any other failure: re-read,
                    // then retry once if the click still applies to the fresh page.
                    Some(write) if !write.retried => {
                        self.browser_controls.retry =
                            Some((id.clone(), request, pane.clone(), write));
                    }
                    Some(_) => {
                        self.reject_browser(&pane)?;
                    }
                    None => self.keep_stale(&pane),
                }
                None
            }
        };
        // A finished write always republishes so the view can settle its pending click.
        if (wrote && self.browser_controls.retry.is_none())
            || self.state.browser_controls.get(&pane) != previous.as_ref()
            || self.state.browser_marks.get(&pane).copied() != mark
        {
            self.publish()?;
        }
        if let Some((_, _, _, write)) = retry {
            match observed
                .filter(|fresh| fresh.revision != write.command.revision)
                .and_then(|fresh| rebase(&write.command, &write.basis, &fresh))
            {
                Some(command) => {
                    let write = Write {
                        command,
                        retried: true,
                        ..write
                    };
                    return self.dispatch_browser(request, pane, Some(write));
                }
                None if self.state.browser_marks.get(&pane) != Some(&Mark::Stale) => {
                    self.reject_browser(&pane)?;
                }
                None => {}
            }
        }
        if let Some((queued_id, queued_request, queued_pane, command)) = queued
            && queued_id == id
            && queued_request == request
        {
            self.browser_controls(queued_request, queued_pane, Some(command))?;
        }
        if let Some((_, retry_request, retry_pane, _)) = &self.browser_controls.retry
            && self.browser_controls.pending.is_none()
        {
            let (retry_request, retry_pane) = (*retry_request, retry_pane.clone());
            self.browser_controls(retry_request, retry_pane.clone(), None)?;
            if self.browser_controls.pending.is_none() {
                self.browser_controls.retry = None;
                self.reject_browser(&retry_pane)?;
            }
        }
        while self.browser_controls.pending.is_none() {
            let Some((request, pane)) = self.browser_controls.reads.pop_front() else {
                break;
            };
            self.browser_controls(request, pane, None)?;
        }
        Ok(())
    }
    /// A failed read keeps the last good controls, marked stale, until the browser is
    /// confirmed gone or reads keep failing.
    fn keep_stale(&mut self, pane: &str) {
        let failures = self
            .browser_controls
            .failures
            .entry(pane.into())
            .or_default();
        *failures = failures.saturating_add(1);
        if *failures >= STALE_LIMIT {
            self.forget_browser(pane);
        } else if self.state.browser_controls.contains_key(pane)
            && !self.state.browser_marks.contains_key(pane)
        {
            self.state.browser_marks.insert(pane.into(), Mark::Stale);
        }
    }
    fn forget_browser(&mut self, pane: &str) {
        self.state.browser_controls.remove(pane);
        self.state.browser_marks.remove(pane);
        self.browser_controls.previous.remove(pane);
        self.browser_controls.failures.remove(pane);
        self.browser_controls.rejected.remove(pane);
    }
}
#[cfg(test)]
#[path = "browser_native_local_browser_tests.rs"]
mod tests;
