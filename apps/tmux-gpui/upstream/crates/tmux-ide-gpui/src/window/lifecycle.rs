//! Keeping the window's view of the daemon current: resending geometry only
//! when it actually changed, renaming the OS window after the focused space,
//! and reporting focus to the authoritative inbox as well as the wire.

use super::HerdrWindow;
use crate::{WINDOW_TITLE, sidebar, state::LiveState};
use gpui::{Context, Window};
use herdr_client::Method;
use serde_json::json;
use std::time::{Duration, Instant};

/// A drag or the full screen animation passes through many sizes, and each
/// resize makes every pane's program redraw, agents re-rendering whole
/// transcripts. Only the size the window settles on is sent.
pub(crate) const RESIZE_SETTLE: Duration = Duration::from_millis(150);

/// A frame another client took is re-claimed more slowly than a settled
/// window resize, so the request is not resent while the daemon answers it.
pub(crate) const RESIZE_REASSERT: Duration = Duration::from_secs(1);

const BELL_PREVIEW_DELAY: Duration = Duration::from_secs(3);

impl HerdrWindow {
    pub(crate) fn resize(&mut self) {
        self.resize_at(Instant::now());
    }

    pub(crate) fn resize_at(&mut self, now: Instant) {
        // Another client (a CLI, or another window) can resize the tab the
        // window shows. The window's own options still hold, so the early
        // return below would leave a frame that no longer matches them: ask
        // for the size again whenever the daemon's frame disagrees.
        let stale = self.live.surface.is_some() && !self.surface_matches_options();
        let changed = self.last_queued_options != Some(self.options);
        if self.last_queued_options == Some(self.options) && !stale {
            self.pending_resize = None;
            return;
        }
        // The first geometry goes out at once; later changes wait to settle.
        if self.last_queued_options.is_some() {
            match self.pending_resize {
                Some((options, since)) if options == self.options => {
                    let wait = if changed {
                        RESIZE_SETTLE
                    } else {
                        RESIZE_REASSERT
                    };
                    if now.duration_since(since) < wait {
                        return;
                    }
                }
                _ => {
                    self.pending_resize = Some((self.options, now));
                    return;
                }
            }
        }
        if let (Some(handle), Some(snapshot)) = (
            &self.endpoints[self.selected_endpoint].connection.handle,
            &self.live.snapshot,
        ) {
            match handle.resize(&snapshot.boot_id, self.options) {
                Ok(()) => {
                    self.last_queued_options = Some(self.options);
                    // The daemon sizes a tab for the client that last
                    // focused, selected or interacted with it. A resize
                    // alone does not claim it back from another client (a
                    // CLI, another window, or a TUI attached to the same
                    // tab), so claim it: select the tab again and re-report
                    // the window's focus.
                    self.sent_focus = None;
                    if let Some(tab) = snapshot.focused_tab_id.clone() {
                        let _ = handle.request(
                            &snapshot.boot_id,
                            Method::TabFocus,
                            json!({ "tab_id": tab }),
                        );
                    }
                }
                Err(error) => self.local_error = Some(format!("Resize: {error}")),
            }
        }
    }

    /// Rings the bell the selected connection forwarded, as `[bell]` asks.
    pub(crate) fn ring_bell(&mut self, window: &mut Window) {
        let Some(ring) =
            self.bell
                .take(self.config.bell, window.is_window_active(), Instant::now())
        else {
            return;
        };
        ring_bell(window, ring);
    }

    /// QA > Ring Bell: both reactions, whatever `[bell]` says, after a delay
    /// long enough to switch to another app, since attention is only asked
    /// for while the window is inactive.
    pub(crate) fn preview_bell(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(BELL_PREVIEW_DELAY).await;
            let _ = this.update_in(cx, |_, window, _| {
                ring_bell(
                    window,
                    crate::bell::Ring {
                        attention: !window.is_window_active(),
                        sound: true,
                    },
                );
            });
        })
        .detach();
    }

    /// The daemon's title for the selected connection wins: an agent's
    /// `client.window_title.set` or Herdr's rendered `ui.window_title`.
    /// Otherwise macOS lists every window in the Window menu by title, and
    /// windows onto the same daemon are told apart by the space each shows.
    pub(crate) fn sync_window_title(&mut self, window: &mut Window) {
        let title = window_title(&self.live);
        if self.title != title {
            window.set_window_title(&title);
            self.title = title;
        }
    }

    pub(crate) fn report_focus(&mut self) {
        // The first positive report acknowledges the daemon's active tab. Wait
        // until its surface is coherent, but not necessarily our size: focus
        // claims tab geometry, so waiting for that size can deadlock startup.
        // Do not flap focus on later frame gaps.
        let focused = self.active
            && self.endpoints[self.selected_endpoint].surface_requested()
            && (self.sent_focus == Some(true)
                || (self.pending_toast.is_none() && self.surface_activation_ready()));
        // Update the authoritative event inbox, not just the rendered clone.
        if let Ok(mut state) = self.endpoints[self.selected_endpoint]
            .connection
            .inbox
            .try_lock()
        {
            state.set_outer_focus(self.active && self.input_ready());
        }
        if self.sent_focus == Some(focused) {
            return;
        }
        if let (Some(handle), Some(snapshot)) = (
            &self.endpoints[self.selected_endpoint].connection.handle,
            &self.live.snapshot,
        ) && handle.set_focus(&snapshot.boot_id, focused).is_ok()
        {
            self.sent_focus = Some(focused);
        }
    }
}

fn ring_bell(window: &Window, ring: crate::bell::Ring) {
    if ring.attention {
        window.request_attention();
    }
    if ring.sound {
        window.play_system_bell();
    }
}

fn window_title(live: &LiveState) -> String {
    if let Some(title) = &live.window_title {
        return title.clone();
    }
    live.snapshot
        .as_ref()
        .and_then(|snapshot| {
            let focused = snapshot.focused_workspace_id.as_deref()?;
            snapshot
                .workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == focused)
        })
        .map_or_else(
            || WINDOW_TITLE.to_owned(),
            |workspace| {
                format!(
                    "{WINDOW_TITLE} \u{2014} {}",
                    sidebar::workspace_label(workspace, false)
                )
            },
        )
}
