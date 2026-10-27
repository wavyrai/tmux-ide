//! Selecting terminal cells with the pointer and copying them. The gesture
//! never sends input to the daemon and writes the clipboard only when the user
//! releases a selection they made or asks to copy one still highlighted. A drag held past a pane's top or bottom
//! scrolls the pane, and a selection reaching rows the pane no longer shows is
//! read back with `pane.selection.read`; everything else is copied from the
//! painted cells.

use super::HerdrWindow;
use crate::{scrollback::Inbox, terminal::Selection};
use gpui::{ClipboardItem, Context, Pixels, Point};
use herdr_client::{
    Method,
    scrollback::{ScrollbackResponse, SelectionReadParams},
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// How often a drag held past a pane's edge scrolls it by another step.
const AUTOSCROLL_INTERVAL: Duration = Duration::from_millis(50);

/// What a drag needs beyond the selection itself: where the pointer last was,
/// so the selection can follow the pane as it scrolls under a still pointer,
/// and the copy the daemon is reading for a released selection.
#[derive(Default)]
pub(crate) struct Follow {
    pointer: Option<Point<Pixels>>,
    scrolled: Option<Instant>,
    read: Option<(Arc<Mutex<Inbox>>, String)>,
}

impl HerdrWindow {
    /// Starts a selection under the pointer, discarding the previous one. A
    /// double click starts on the link or word under it and a triple click on
    /// its row. A press that lands outside the painted cells only clears.
    pub(crate) fn begin_selection(
        &mut self,
        position: Point<Pixels>,
        clicks: usize,
        cx: &mut Context<Self>,
    ) {
        // A click hands the terminal back from copy mode.
        self.leave_copy_mode(cx);
        let cleared = self.selection.take().is_some();
        if let Some(surface) = self.selectable_surface(position) {
            let (x, y) = Self::terminal_offset(self.bounds, position);
            self.selection = Selection::begin(
                surface,
                x,
                y,
                self.cell_width,
                self.config.terminal.line_height(),
                clicks,
            );
        }
        if cleared || self.selection.is_some() {
            cx.notify();
        }
    }

    /// Follows the pointer while the button that started the drag is down.
    /// Returns whether a drag is in progress, so the caller can keep the
    /// gesture to itself.
    pub(crate) fn extend_selection(
        &mut self,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) -> bool {
        let (x, y) = Self::terminal_offset(self.bounds, position);
        let cell_width = self.cell_width;
        let cell_height = self.config.terminal.line_height();
        let (Some(selection), Some(surface)) = (&mut self.selection, &self.live.surface) else {
            return false;
        };
        if !selection.dragging() {
            return false;
        }
        self.selection_follow.pointer = Some(position);
        if selection.extend(surface, x, y, cell_width, cell_height) {
            cx.notify();
        }
        true
    }

    /// Herdr's shared `ui.copy_on_select`, on until the shared config loads.
    pub(super) fn copy_on_select(&self) -> bool {
        self.settings
            .shared
            .as_ref()
            .is_none_or(|shared| shared.copy_on_select)
    }

    /// Ends a drag: what it chose goes to the clipboard and the flash says so.
    /// The highlight stays while `keep_selection_after_copy` is on, so tools
    /// that read the selection find it and Cmd-C copies it again. With Herdr's
    /// `copy_on_select` off, nothing is copied yet and the highlight stays for
    /// [`Self::copy_retained_selection`]. Returns
    /// whether the release belonged to the selection, since a press that
    /// chose no cells is still the click that opens a link under the pointer.
    pub(crate) fn release_selection(&mut self, cx: &mut Context<Self>) -> bool {
        if !self
            .selection
            .as_mut()
            .is_some_and(|selection| selection.release())
        {
            return false;
        }
        self.selection_follow.pointer = None;
        let selected = !self.selection_is_empty();
        if selected && !self.copy_on_select() {
            cx.notify();
            return true;
        }
        self.finish_copy(selected, cx);
        selected
    }

    /// Whether a released selection is still highlighted, waiting for an
    /// explicit copy or kept after one.
    pub(crate) fn selection_retained(&self) -> bool {
        self.selection
            .as_ref()
            .is_some_and(|selection| !selection.dragging())
            && !self.selection_is_empty()
    }

    /// Copies a selection kept on release, as Herdr's Ctrl-C or Cmd-C does,
    /// and clears it unless `keep_selection_after_copy` is on. `false` when no
    /// released selection is waiting.
    pub(crate) fn copy_retained_selection(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.selection_retained() {
            return false;
        }
        self.finish_copy(true, cx);
        true
    }

    /// Drops a selection kept on release, as any other key does in Herdr.
    pub(crate) fn clear_retained_selection(&mut self, cx: &mut Context<Self>) {
        if self
            .selection
            .as_ref()
            .is_some_and(|selection| !selection.dragging())
        {
            self.selection = None;
            cx.notify();
        }
    }

    fn finish_copy(&mut self, selected: bool, cx: &mut Context<Self>) {
        // A kept selection stays readable by selection tools and screen
        // readers until the next click or keystroke. Otherwise the gesture is
        // over either way: nothing stays highlighted behind it.
        let keep = selected && self.config.keep_selection_after_copy;
        if selected && self.read_offscreen_selection() {
            if !keep {
                self.selection = None;
            }
            cx.notify();
            return;
        }
        let copied = selected && self.copy_selection(cx);
        if !keep {
            self.selection = None;
        }
        if copied && self.config.clipboard_toast.enabled {
            self.show_flash(super::Flash::success("copied to clipboard"), cx);
        }
        cx.notify();
    }

    /// Asks the daemon for a selection that reaches rows the pane does not
    /// show. `false` when the painted cells hold all of it.
    fn read_offscreen_selection(&mut self) -> bool {
        let cell_height = self.config.terminal.line_height();
        let (Some(selection), Some(surface)) = (&self.selection, self.live.surface.as_deref())
        else {
            return false;
        };
        let Some((pane_id, range)) =
            selection.offscreen_range(surface, self.cell_width, cell_height)
        else {
            return false;
        };
        let params = SelectionReadParams {
            pane_id: pane_id.to_owned(),
            anchor: range.start,
            cursor: range.end,
            // An explicit selection reads the live terminal: output since the
            // frame on screen must not refuse the copy.
            content_revision: None,
        };
        let connection = &self.endpoints[self.selected_endpoint].connection;
        let result = if !self.live.supports_selection_read {
            Err(crate::Error::SelectionOffscreen)
        } else if let (Some(handle), Some(snapshot)) = (&connection.handle, &self.live.snapshot) {
            let inbox = connection.scrollback.clone();
            let sent = inbox
                .try_lock()
                .map_err(|_| crate::Error::ConnectionBusy)
                .and_then(|mut mailbox| {
                    Ok(mailbox.send(|| handle.read_selection(&snapshot.boot_id, &params))?)
                });
            sent.map(|request| (inbox, request))
        } else {
            Err(crate::Error::NotConnected)
        };
        match result {
            Ok((inbox, request)) => self.await_selection_read(inbox, request),
            Err(error) => self.local_error = Some(format!("Selection not copied: {error}")),
        }
        true
    }

    /// Copies what `request` reads once it comes back. A read still waiting
    /// is given up: the newer selection is the one the user wants.
    pub(super) fn await_selection_read(&mut self, inbox: Arc<Mutex<Inbox>>, request: String) {
        if let Some((inbox, request)) = self.selection_follow.read.replace((inbox, request))
            && let Ok(mut inbox) = inbox.try_lock()
        {
            inbox.discard(&request);
        }
    }

    /// Runs every tick while a drag or a daemon read is under way: scrolls a
    /// pane the pointer is held past, keeps the selection under the pointer
    /// as the pane moves, and copies a read that has come back.
    pub(crate) fn follow_selection(&mut self, cx: &mut Context<Self>) {
        self.finish_selection_read(cx);
        let Some(pointer) = self.selection_follow.pointer else {
            return;
        };
        if !self.selection.as_ref().is_some_and(Selection::dragging) {
            self.selection_follow.pointer = None;
            return;
        }
        // The pane may have scrolled under a pointer that has not moved.
        self.extend_selection(pointer, cx);
        let now = Instant::now();
        if self.live.drag_request.is_some()
            || self
                .selection_follow
                .scrolled
                .is_some_and(|last| now.saturating_duration_since(last) < AUTOSCROLL_INTERVAL)
        {
            return;
        }
        let Some((pane_id, offset)) = self.selection_autoscroll(pointer) else {
            return;
        };
        let connection = &self.endpoints[self.selected_endpoint].connection;
        let (Some(handle), Some(snapshot)) = (&connection.handle, &self.live.snapshot) else {
            return;
        };
        // One scroll in flight at a time, registered like a scrollbar drag's.
        let Ok(mut state) = connection.inbox.try_lock() else {
            return;
        };
        match handle.request(
            &snapshot.boot_id,
            Method::PaneScroll,
            serde_json::json!({"pane_id": pane_id, "offset_from_bottom": offset}),
        ) {
            Ok(request) => {
                state.drag_request = Some(request.clone());
                self.live.drag_request = Some(request);
                self.selection_follow.scrolled = Some(now);
            }
            Err(error) => {
                drop(state);
                self.local_error = Some(format!("Scroll not sent: {error}"));
                self.selection_follow.pointer = None;
                cx.notify();
            }
        }
    }

    /// The pane under a pane selection and the offset one step further in the
    /// direction the pointer is held past its edge, faster the further out.
    fn selection_autoscroll(&self, pointer: Point<Pixels>) -> Option<(String, u64)> {
        let selection = self.selection.as_ref()?;
        let pane_id = selection.pane_id()?;
        let surface = self.live.surface.as_deref()?;
        let pane = surface.panes.iter().find(|pane| pane.pane_id == pane_id)?;
        let scroll = pane.scroll?;
        let cell_height = self.config.terminal.line_height();
        let (_, y) = Self::terminal_offset(self.bounds, pointer);
        let top = f32::from(pane.inner_rect.y) * cell_height;
        let bottom = top + f32::from(pane.inner_rect.height) * cell_height;
        let rows = |distance: f32| ((distance / cell_height).ceil() as u64).clamp(1, 5);
        let offset = if y < top {
            scroll
                .offset_from_bottom
                .saturating_add(rows(top - y))
                .min(scroll.max_offset_from_bottom)
        } else if y >= bottom {
            scroll
                .offset_from_bottom
                .saturating_sub(rows(y - bottom + 1.))
        } else {
            return None;
        };
        (offset != scroll.offset_from_bottom).then(|| (pane_id.to_owned(), offset))
    }

    /// Copies a selection the daemon has read back, once.
    fn finish_selection_read(&mut self, cx: &mut Context<Self>) {
        let Some((inbox, request)) = &self.selection_follow.read else {
            return;
        };
        let answer = match inbox.try_lock() {
            Ok(mut inbox) => inbox.take(request),
            Err(_) => return,
        };
        let Some(answer) = answer else {
            // A replaced connection never answers its old mailbox.
            if !Arc::ptr_eq(
                inbox,
                &self.endpoints[self.selected_endpoint].connection.scrollback,
            ) {
                self.selection_follow.read = None;
            }
            return;
        };
        self.selection_follow.read = None;
        match answer {
            Ok(ScrollbackResponse::PaneSelection(selection))
                if selection.text.len() <= crate::terminal::MAX_SELECTION_BYTES =>
            {
                cx.write_to_clipboard(ClipboardItem::new_string(selection.text));
                if self.config.clipboard_toast.enabled {
                    self.show_flash(super::Flash::success("copied to clipboard"), cx);
                }
            }
            Ok(ScrollbackResponse::PaneSelection(_)) => {
                self.local_error = Some(format!(
                    "Selection not copied: {}",
                    crate::Error::SelectionSize
                ));
            }
            Ok(_) => {
                self.local_error = Some(format!(
                    "Selection not copied: {}",
                    herdr_client::Error::ResponseType
                ));
            }
            Err(error) => self.local_error = Some(format!("Selection not copied: {error}")),
        }
        cx.notify();
    }

    /// Writes the current selection to the clipboard, reporting whether the
    /// text got there.
    fn copy_selection(&mut self, cx: &mut Context<Self>) -> bool {
        let text = {
            let (Some(selection), Some(surface)) = (&self.selection, &self.live.surface) else {
                return false;
            };
            selection.text(surface, self.cell_width, self.config.terminal.line_height())
        };
        match text {
            Ok(text) => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                true
            }
            Err(error) => {
                self.local_error = Some(format!("Selection not copied: {error}"));
                false
            }
        }
    }

    /// Whether the selection covers no cell the client can still show, either
    /// because the pointer never left the half-cell it pressed in or because
    /// the surface behind it is gone.
    fn selection_is_empty(&self) -> bool {
        let (Some(selection), Some(surface)) = (&self.selection, &self.live.surface) else {
            return true;
        };
        !self.live.surface_ready()
            || selection
                .rows(surface, self.cell_width, self.config.terminal.line_height())
                .next()
                .is_none()
    }

    /// The surface a press at `position` may select from, if the terminal area
    /// is showing one. Hit testing reads the live surface, never the frame a
    /// gap may still be presenting.
    fn selectable_surface(
        &self,
        position: Point<Pixels>,
    ) -> Option<&herdr_client::protocol::PaneSurfaceFrame> {
        if self.menu.page.is_some()
            || !self.live.surface_ready()
            || !self.bounds.contains(&position)
        {
            return None;
        }
        self.live.surface.as_deref()
    }

    fn terminal_offset(bounds: gpui::Bounds<Pixels>, position: Point<Pixels>) -> (f32, f32) {
        (
            f32::from(position.x - bounds.origin.x),
            f32::from(position.y - bounds.origin.y),
        )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
