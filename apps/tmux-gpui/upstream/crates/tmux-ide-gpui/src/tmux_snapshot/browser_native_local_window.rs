//! A session with more panes than one stream carries opens one window at a
//! time (#806): the stream is issued for that window's panes only. A session
//! that fits is still streamed whole, so its window switches stay local.
use super::{Error, Local, Stage, Target};
use crate::tmux_snapshot::browser::NATIVE_STREAM_MAX_PANES;
use herdr_client::tmux_daemon::InventoryWindow;

/// The window a session opens on, and why when it is not the one asked for.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Scoped {
    pub(super) window: String,
    pub(super) panes: Vec<String>,
    pub(super) notice: Option<&'static str>,
}

pub(super) const OTHER_WINDOW: &str =
    "That window has too many panes to open here, so another window is shown.";

fn fits(window: &InventoryWindow) -> bool {
    u64::try_from(window.panes.len()).is_ok_and(|count| count <= NATIVE_STREAM_MAX_PANES)
}

/// `None` streams the whole session: it fits, or the daemon named no windows,
/// or no window fits (the caller's pane limit then refuses it). Otherwise the
/// wanted window (the one holding `preferred`, else the active one) when it
/// fits, else the active one, else the first in tmux order that fits; passing
/// over the wanted window comes with a notice.
pub(super) fn scope(
    panes: &[String],
    windows: Option<&[InventoryWindow]>,
    preferred: Option<&str>,
) -> Option<Scoped> {
    if u64::try_from(panes.len()).is_ok_and(|count| count <= NATIVE_STREAM_MAX_PANES) {
        return None;
    }
    let windows = windows?;
    let active = windows.iter().find(|window| window.active);
    let wanted = preferred
        .and_then(|pane| windows.iter().find(|w| w.panes.iter().any(|p| p == pane)))
        .or(active);
    let chosen = wanted
        .filter(|w| fits(w))
        .or_else(|| active.filter(|w| fits(w)))
        .or_else(|| windows.iter().find(|w| fits(w)))?;
    let passed_over = wanted.is_some_and(|w| w.id != chosen.id);
    Some(scoped(chosen, passed_over.then_some(OTHER_WINDOW)))
}

fn scoped(window: &InventoryWindow, notice: Option<&'static str>) -> Scoped {
    Scoped {
        window: window.id.clone(),
        panes: window.panes.clone(),
        notice,
    }
}

impl Local {
    /// An open's answer becomes the issue: the whole session when it fits,
    /// else one window of it (#806), else Home with the pane-limit notice.
    pub(super) fn opened(
        &mut self,
        target: Target,
        workspace: String,
        panes: Vec<String>,
        windows: Option<Vec<InventoryWindow>>,
        preferred: Option<String>,
    ) -> Result<(), Error> {
        let scoped = scope(&panes, windows.as_deref(), preferred.as_deref());
        let (panes, window, notice) = match scoped {
            Some(scoped) => (scoped.panes, Some(scoped.window), scoped.notice),
            None => {
                if let Some(done) = self.pane_limit_exceeded(&target, &panes, windows.as_deref()) {
                    return done;
                }
                (panes, None, None)
            }
        };
        let Some(selected) = preferred
            .filter(|id| panes.contains(id))
            .or_else(|| panes.first().cloned())
        else {
            return self.unavailable("Session exceeds the native stream pane limit");
        };
        self.window_notice = notice;
        self.stage = Some(Stage::Issue {
            target,
            workspace,
            panes,
            selected,
            window,
        });
        Ok(())
    }
}

#[cfg(test)]
#[path = "browser_native_local_window_tests.rs"]
mod tests;
