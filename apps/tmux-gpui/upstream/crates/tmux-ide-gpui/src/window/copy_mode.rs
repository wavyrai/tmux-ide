//! The window's side of keyboard copy mode: entering and leaving it, routing
//! keys and input-method text to it instead of the terminal, sending the
//! daemon's motions, keeping the cursor on screen, and copying the selection
//! through `pane.selection.read`. The mode's own rules live in
//! [`crate::copy_mode`].

use super::HerdrWindow;
use crate::{
    copy_mode::{Command, CopyMode, Outcome},
    scrollback::Inbox,
    terminal_painter::Highlight,
};
use gpui::{prelude::*, *};
use herdr_client::{
    Method,
    protocol::{PaneSurfaceFrame, PaneSurfacePane},
    scrollback::{CopyMotionParams, ScrollbackResponse, SelectionReadParams, TextRange},
};
use std::sync::{Arc, Mutex};

pub(crate) struct CopyModeState {
    mode: CopyMode,
    boot_id: String,
    /// The mailbox of the connection copy mode began on; a reconnect
    /// replaces it, which ends copy mode with the connection.
    inbox: Arc<Mutex<Inbox>>,
}

impl HerdrWindow {
    /// Enters copy mode on the focused pane, at the terminal's cursor.
    pub(crate) fn enter_copy_mode(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.live.supports_copy_motion {
            self.show_flash(
                super::Flash::warning("Copy mode needs a newer Herdr daemon"),
                cx,
            );
            return;
        }
        let Some(pane) = self.focused_surface_pane() else {
            return;
        };
        let cursor = self
            .live
            .surface
            .as_deref()
            .and_then(|surface| surface.frame.cursor.as_ref())
            .filter(|cursor| cursor.visible)
            .map(|cursor| (cursor.x, cursor.y));
        let mode = CopyMode::new(pane, cursor);
        let Some(boot_id) = self.live.snapshot.as_ref().map(|s| s.boot_id.clone()) else {
            return;
        };
        self.leave_copy_mode(cx);
        self.selection = None;
        self.discard_composition(cx);
        self.copy_mode = Some(CopyModeState {
            mode,
            boot_id,
            inbox: self.endpoints[self.selected_endpoint]
                .connection
                .scrollback
                .clone(),
        });
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Leaves copy mode, scrolling the pane back to where it was when copy
    /// mode began.
    pub(crate) fn leave_copy_mode(&mut self, cx: &mut Context<Self>) {
        let Some(state) = self.copy_mode.take() else {
            return;
        };
        if let Some(request) = state.mode.in_flight()
            && let Ok(mut inbox) = state.inbox.try_lock()
        {
            inbox.discard(request);
        }
        if let Some(offset) = state.mode.entry_offset() {
            self.scroll_pane(&state.boot_id, state.mode.pane_id(), offset, cx);
        }
        cx.notify();
    }

    /// Whether copy mode holds the keyboard, so nothing typed reaches the
    /// terminal.
    pub(crate) fn copy_mode_active(&self) -> bool {
        self.copy_mode.is_some()
    }

    /// A keystroke while copy mode is on: a copy-mode key runs, and every
    /// other key is swallowed rather than typed into the pane.
    pub(crate) fn copy_mode_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        if modifiers.platform || modifiers.alt || modifiers.function {
            return;
        }
        if let Some(command) = Command::from_key(&keystroke.key, modifiers.shift, modifiers.control)
        {
            self.copy_mode_command(command, cx);
        }
    }

    /// Text an input method committed while copy mode is on, read as keys.
    pub(crate) fn copy_mode_text(&mut self, text: &str, cx: &mut Context<Self>) {
        for command in text.chars().filter_map(Command::from_char) {
            self.copy_mode_command(command, cx);
        }
    }

    fn copy_mode_command(&mut self, command: Command, cx: &mut Context<Self>) {
        let Some(state) = &mut self.copy_mode else {
            return;
        };
        let Some(pane) = pane_of(self.live.surface.as_deref(), state.mode.pane_id()) else {
            return;
        };
        match state.mode.command(command, pane) {
            Outcome::Nothing => {}
            Outcome::Moved => self.reveal_copy_cursor(cx),
            Outcome::Motion(params) => self.send_copy_motion(params, cx),
            Outcome::Copy(range) => {
                self.copy_range(range, cx);
                self.leave_copy_mode(cx);
            }
            Outcome::Exit => self.leave_copy_mode(cx),
        }
        cx.notify();
    }

    fn send_copy_motion(&mut self, params: CopyMotionParams, cx: &mut Context<Self>) {
        let Some(state) = &mut self.copy_mode else {
            return;
        };
        let Some(handle) = &self.endpoints[self.selected_endpoint].connection.handle else {
            return;
        };
        let sent = match state.inbox.try_lock() {
            Ok(mut inbox) => inbox.send(|| handle.copy_motion(&state.boot_id, &params)),
            Err(_) => Err(herdr_client::Error::Full),
        };
        match sent {
            Ok(request) => state.mode.sent(request, &params),
            Err(error) => {
                state.mode.send_failed();
                self.local_error = Some(format!("Copy mode motion not sent: {error}"));
                cx.notify();
            }
        }
    }

    /// Reads `range` from the daemon and copies it when it comes back, the
    /// same way a selection dragged past the screen is copied.
    fn copy_range(&mut self, range: TextRange, cx: &mut Context<Self>) {
        let Some(state) = &self.copy_mode else {
            return;
        };
        let Some(handle) = &self.endpoints[self.selected_endpoint].connection.handle else {
            return;
        };
        let params = SelectionReadParams {
            pane_id: state.mode.pane_id().to_owned(),
            anchor: range.start,
            cursor: range.end,
            content_revision: None,
        };
        let sent = match state.inbox.try_lock() {
            Ok(mut inbox) => inbox.send(|| handle.read_selection(&state.boot_id, &params)),
            Err(_) => Err(herdr_client::Error::Full),
        };
        match sent {
            Ok(request) => self.await_selection_read(state.inbox.clone(), request),
            Err(error) => {
                self.local_error = Some(format!("Selection not copied: {error}"));
                cx.notify();
            }
        }
    }

    fn reveal_copy_cursor(&mut self, cx: &mut Context<Self>) {
        let Some(state) = &mut self.copy_mode else {
            return;
        };
        let Some(pane) = pane_of(self.live.surface.as_deref(), state.mode.pane_id()) else {
            return;
        };
        if let Some(offset) = state.mode.reveal(pane) {
            let (boot, pane) = (state.boot_id.clone(), state.mode.pane_id().to_owned());
            self.scroll_pane(&boot, &pane, offset, cx);
        }
    }

    fn scroll_pane(&mut self, boot_id: &str, pane_id: &str, offset: u64, cx: &mut Context<Self>) {
        let Some(handle) = &self.endpoints[self.selected_endpoint].connection.handle else {
            return;
        };
        if let Err(error) = handle.request(
            boot_id,
            Method::PaneScroll,
            serde_json::json!({"pane_id": pane_id, "offset_from_bottom": offset}),
        ) {
            self.local_error = Some(format!("Scroll not sent: {error}"));
            cx.notify();
        }
    }

    /// Runs every tick: ends copy mode whose pane or connection is gone,
    /// applies a motion's answer, retries a stale one, and runs keys that
    /// waited behind it.
    pub(crate) fn poll_copy_mode(&mut self, cx: &mut Context<Self>) {
        let Some(state) = &mut self.copy_mode else {
            return;
        };
        let connection = &self.endpoints[self.selected_endpoint].connection;
        let current = Arc::ptr_eq(&state.inbox, &connection.scrollback)
            && self.live.snapshot.as_ref().is_some_and(|snapshot| {
                snapshot.boot_id == state.boot_id
                    && snapshot
                        .panes
                        .iter()
                        .any(|pane| pane.pane_id == state.mode.pane_id())
            });
        if !current {
            // Nothing to scroll back on a connection that is gone.
            self.copy_mode = None;
            cx.notify();
            return;
        }
        // Its pane left the screen with its tab; the keyboard must not stay
        // with a mode nobody can see.
        if self.live.surface_ready()
            && pane_of(self.live.surface.as_deref(), state.mode.pane_id()).is_none()
        {
            self.leave_copy_mode(cx);
            return;
        }
        let answer = state.mode.in_flight().and_then(|request| {
            let answer = state.inbox.try_lock().ok()?.take(request)?;
            Some((request.to_owned(), answer))
        });
        if let Some((request, answer)) = answer {
            let answer = answer.and_then(|answer| match answer {
                ScrollbackResponse::PaneCopyMotion(result) => Ok(result),
                _ => Err(herdr_client::Error::ResponseType),
            });
            match state.mode.answer(&request, answer) {
                Ok(true) => self.reveal_copy_cursor(cx),
                Ok(false) => {}
                Err(error) => self.local_error = Some(format!("Copy mode motion failed: {error}")),
            }
            cx.notify();
        }
        let Some(state) = &mut self.copy_mode else {
            return;
        };
        if let Some(params) = pane_of(self.live.surface.as_deref(), state.mode.pane_id())
            .and_then(|pane| state.mode.due_retry(pane))
        {
            self.send_copy_motion(params, cx);
        }
        while let Some(command) = self
            .copy_mode
            .as_mut()
            .and_then(|state| state.mode.next_queued())
        {
            self.copy_mode_command(command, cx);
        }
    }

    /// The copy-mode cursor and selection to paint over `surface`.
    pub(crate) fn copy_mode_highlights(&self, surface: &PaneSurfaceFrame) -> Vec<Highlight> {
        let Some(state) = &self.copy_mode else {
            return Vec::new();
        };
        if surface.popup.is_some() {
            return Vec::new();
        }
        pane_of(Some(surface), state.mode.pane_id())
            .map(|pane| state.mode.highlights(pane))
            .unwrap_or_default()
    }

    /// A small marker in the bottom right corner of the pane in copy mode.
    pub(crate) fn render_copy_mode_badge(
        &self,
        surface: Option<&PaneSurfaceFrame>,
        gap: f32,
    ) -> Option<Div> {
        let state = self.copy_mode.as_ref()?;
        let surface = surface.filter(|surface| surface.popup.is_none())?;
        let pane = pane_of(Some(surface), state.mode.pane_id())?;
        let cell_height = self.config.terminal.line_height();
        let rect = pane.rect;
        Some(
            div()
                .absolute()
                .left(px(gap + f32::from(rect.x) * self.cell_width))
                .w(px(f32::from(rect.width) * self.cell_width))
                .top(px(f32::from(rect.y.saturating_add(rect.height))
                    * cell_height
                    - 32.))
                .flex()
                .justify_end()
                .px(px(6.))
                .child(
                    div()
                        .debug_selector(|| "copy-mode".into())
                        .px(px(8.))
                        .py(px(2.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .bg(rgb(self.theme.palette[3]))
                        .text_color(rgb(self.theme.text_on(self.theme.palette[3])))
                        .text_size(px(self.config.ui.size))
                        .child("Copy mode"),
                ),
        )
    }
}

fn pane_of<'a>(
    surface: Option<&'a PaneSurfaceFrame>,
    pane_id: &str,
) -> Option<&'a PaneSurfacePane> {
    surface?.panes.iter().find(|pane| pane.pane_id == pane_id)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    // `super::*` brings in gpui's `test`, which `#[gpui::test]` expands to.
    use crate::{controls::Command, sidebar::layout_tests::fixture_window, window::MockPeer};
    use core::prelude::v1::test;
    use gpui::{TestAppContext, VisualTestContext};
    use herdr_client::protocol::{ClientMessage, PaneSurfaceScrollMetrics};
    use serde_json::{Value, json};

    /// The next scrollback or scroll request on the wire, answering others;
    /// terminal input must never appear.
    fn next_request(peer: &mut MockPeer) -> Value {
        loop {
            match peer.receive() {
                ClientMessage::ClientShellEndpointRequest { request, .. } => {
                    let request: Value = serde_json::from_str(&request).unwrap();
                    if request["method"]
                        .as_str()
                        .is_some_and(|method| method.starts_with("pane."))
                    {
                        return request;
                    }
                    let id = request["id"].as_str().unwrap();
                    peer.respond("boot-v1", id, &json!({"id": id, "result": {"type": "ok"}}));
                }
                message @ (ClientMessage::ClientShellPaneInput { .. }
                | ClientMessage::ClientShellPopupInput { .. }) => {
                    panic!("copy mode typed into the terminal: {message:?}")
                }
                _ => {}
            }
        }
    }

    #[gpui::test]
    fn copy_mode_walks_the_history_and_copies_without_typing(cx: &mut TestAppContext) {
        let mut peer =
            MockPeer::advertising(&["pane.copy_motion", "pane.selection.read", "pane.scroll"]);
        let (view, cx) = cx.add_window_view(|window, cx| {
            let mut view = fixture_window(window, cx);
            peer.prepare(&mut view, cx);
            view.live.supports_copy_motion = true;
            let surface = Arc::make_mut(view.live.surface.as_mut().unwrap());
            surface.panes[0].content_revision = 2;
            surface.panes[0].scroll = Some(PaneSurfaceScrollMetrics {
                offset_from_bottom: 0,
                max_offset_from_bottom: 100,
                viewport_rows: 24,
            });
            view
        });
        let redraw = |cx: &mut VisualTestContext| {
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })
        };
        redraw(cx);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| view.command(Command::CopyMode, window, cx))
        });
        redraw(cx);
        assert!(cx.debug_bounds("copy-mode").is_some());
        let poll = |cx: &mut VisualTestContext| {
            view.update(cx, |view, cx| {
                view.poll_copy_mode(cx);
                view.follow_selection(cx);
            })
        };
        let inbox = view.read_with(cx, |view, _| {
            view.endpoints[0].connection.scrollback.clone()
        });
        let answer = |peer: &mut MockPeer, request: &Value, result: Value| {
            let id = request["id"].as_str().unwrap();
            let event = peer.respond("boot-v1", id, &json!({"id": id, "result": result}));
            assert!(inbox.lock().unwrap().apply(event).is_none());
        };

        // Up a row locally, then a word motion goes to the daemon; a key
        // typed meanwhile waits for it. An unknown key types nothing.
        cx.simulate_keystrokes("k x w l");
        let motion = next_request(&mut peer);
        assert_eq!(motion["method"], "pane.copy_motion");
        assert_eq!(
            motion["params"],
            json!({"pane_id": "w1:p1", "cursor": {"row": 122, "col": 0},
                "motion": "next_word_start", "content_revision": 2})
        );
        answer(
            &mut peer,
            &motion,
            json!({"type": "pane_copy_motion", "pane_id": "w1:p1",
                "cursor": {"row": 122, "col": 4}, "content_revision": 2}),
        );
        poll(cx);
        // Text an input method commits runs as keys too: mark, then the top
        // of history, which scrolls the pane there.
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                EntityInputHandler::replace_text_in_range(view, None, "vg", window, cx)
            })
        });
        let scroll = next_request(&mut peer);
        assert_eq!(scroll["method"], "pane.scroll");
        assert_eq!(scroll["params"]["offset_from_bottom"], 100);
        // A scroll is a plain request, answered outside the scrollback mailbox.
        let id = scroll["id"].as_str().unwrap();
        peer.respond("boot-v1", id, &json!({"id": id, "result": {"type": "ok"}}));

        // Yank reads the marked range, from the history to the queued key's
        // column, and leaves copy mode where the pane was.
        cx.simulate_keystrokes("y");
        let read = next_request(&mut peer);
        assert_eq!(read["method"], "pane.selection.read");
        assert_eq!(
            read["params"],
            json!({"pane_id": "w1:p1", "anchor": {"row": 0, "col": 0},
                "cursor": {"row": 122, "col": 5}})
        );
        view.read_with(cx, |view, _| assert!(view.copy_mode.is_none()));
        answer(
            &mut peer,
            &read,
            json!({"type": "pane_selection", "pane_id": "w1:p1", "text": "copied lines"}),
        );
        // The scroll back to where copy mode began follows the read.
        let back = next_request(&mut peer);
        assert_eq!(back["method"], "pane.scroll");
        assert_eq!(back["params"]["offset_from_bottom"], 0);
        poll(cx);
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some("copied lines".into())
        );
    }

    #[gpui::test]
    fn copy_mode_explains_an_old_daemon(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(fixture_window);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.command(Command::CopyMode, window, cx);
                assert!(view.copy_mode.is_none());
                assert!(view.flash.is_some());
            })
        });
    }
}
