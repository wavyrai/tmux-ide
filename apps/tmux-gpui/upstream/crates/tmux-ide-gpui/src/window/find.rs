//! The find bar: a native search field over one pane, searching its
//! scrollback through the daemon. What to ask and how answers map onto the
//! grid lives in [`crate::find`]; this is the window's side of it, owning the
//! field, its focus, the mailbox poll, and scrolling a match into view.
//!
//! Typing in the field never reaches the terminal. Printable keys must stay
//! unhandled for the platform to insert them (and to compose them through an
//! IME), so the terminal's own key handler steps aside while the field has
//! focus instead of the field stopping every key.

use super::HerdrWindow;
use crate::{
    find::{Search, Step, memory::Left},
    scrollback::{Inbox, reveal_offset},
    search_input::{self, SearchInput},
    terminal_painter::Highlight,
};
use gpui::{prelude::*, *};
use herdr_client::{
    Method,
    protocol::{PaneSurfaceFrame, PaneSurfacePane},
    scrollback::{ScrollbackResponse, TextRange},
};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub(crate) struct FindBar {
    input: Entity<SearchInput>,
    search: Search,
    boot_id: String,
    /// The mailbox of the connection the bar was opened on. A reconnect
    /// replaces it, which retires the bar with the connection.
    inbox: Arc<Mutex<Inbox>>,
    _changed: Subscription,
}

impl HerdrWindow {
    /// Opens the bar over the focused pane, or returns to it with its query
    /// selected when it is already open there. A new bar starts from the
    /// query last searched over that pane.
    pub(crate) fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.live.supports_copy_search {
            self.show_flash(super::Flash::warning("Find needs a newer Herdr daemon"), cx);
            return;
        }
        let Some(pane) = self.focused_surface_pane().cloned() else {
            return;
        };
        let Some(boot_id) = self.live.snapshot.as_ref().map(|s| s.boot_id.clone()) else {
            return;
        };
        if let Some(bar) = &self.find
            && bar.search.pane_id() == pane.pane_id
        {
            let input = bar.input.clone();
            input.update(cx, |input, cx| {
                let text = input.text().to_owned();
                input.set_text_selected(&text, cx);
            });
            let focus = input.read(cx).focus.clone();
            window.focus(&focus, cx);
            cx.notify();
            return;
        }
        let query = self
            .find_memory
            .query(&boot_id, &pane.pane_id)
            .unwrap_or_default()
            .to_owned();
        self.show_find(&pane, boot_id, &query, true, window, cx);
    }

    /// Puts a bar over `pane` searching `query`, replacing one over another
    /// pane, whose query is kept for when it opens there again.
    fn show_find(
        &mut self,
        pane: &PaneSurfacePane,
        boot_id: String,
        query: &str,
        focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_find(Some(Left::Closed), window, cx);
        let input = cx.new(SearchInput::new);
        input.update(cx, |input, cx| {
            input.set_placeholder("Find", cx);
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
        });
        if focus {
            let focus = input.read(cx).focus.clone();
            window.focus(&focus, cx);
        }
        let changed = cx.subscribe(&input, |this, input, _: &search_input::Changed, cx| {
            let query = input.read(cx).text().to_owned();
            if let Some(bar) = &mut this.find {
                bar.search.set_query(&query);
            }
            this.flush_find(cx);
            cx.notify();
        });
        self.find = Some(FindBar {
            input: input.clone(),
            search: Search::new(pane),
            boot_id,
            inbox: self.endpoints[self.selected_endpoint]
                .connection
                .scrollback
                .clone(),
            _changed: changed,
        });
        // After the subscription, so the query is searched like a typed one.
        input.update(cx, |input, cx| input.set_text_selected(query, cx));
        cx.notify();
    }

    /// Closes the bar and hands the keyboard back to the terminal. A search
    /// still in flight is answered into nothing.
    pub(crate) fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_find(Some(Left::Closed), window, cx);
    }

    /// Takes the bar down, remembering it over its pane as `left` says. A bar
    /// whose connection is gone is not remembered: its pane IDs mean nothing
    /// to the next one.
    fn dismiss_find(&mut self, left: Option<Left>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bar) = self.find.take() else {
            return;
        };
        if let Some(request) = bar.search.in_flight()
            && let Ok(mut inbox) = bar.inbox.lock()
        {
            inbox.discard(request);
        }
        let input = bar.input.read(cx);
        if let Some(left) = left {
            self.find_memory
                .remember(&bar.boot_id, bar.search.pane_id(), input.text(), left);
        }
        if input.focus.is_focused(window) {
            window.focus(&self.focus, cx);
        }
        cx.notify();
    }

    /// Whether the find field holds the keyboard, so the terminal must not
    /// act on a keystroke bubbling out of it.
    pub(crate) fn find_focused(&self, window: &Window, cx: &App) -> bool {
        self.find
            .as_ref()
            .is_some_and(|bar| bar.input.read(cx).focus.is_focused(window))
    }

    pub(crate) fn find_step(&mut self, step: Step, cx: &mut Context<Self>) {
        let Some(bar) = &mut self.find else {
            return;
        };
        bar.search.step(step);
        self.flush_find(cx);
        cx.notify();
    }

    /// Runs every tick: retires a bar whose pane or connection is gone,
    /// applies an answer, and sends whatever search is due.
    pub(crate) fn poll_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.follow_find_pane(window, cx);
        let Some(bar) = &mut self.find else {
            return;
        };
        let connection = &self.endpoints[self.selected_endpoint].connection;
        let current = Arc::ptr_eq(&bar.inbox, &connection.scrollback)
            && self.live.snapshot.as_ref().is_some_and(|snapshot| {
                snapshot.boot_id == bar.boot_id
                    && snapshot
                        .panes
                        .iter()
                        .any(|pane| pane.pane_id == bar.search.pane_id())
            });
        if !current {
            self.dismiss_find(None, window, cx);
            return;
        }
        // The reader holds this lock only to deliver; a busy mailbox is read
        // on the next tick rather than waited on.
        let answer = bar.search.in_flight().and_then(|request| {
            let answer = bar.inbox.try_lock().ok()?.take(request)?;
            Some((request.to_owned(), answer))
        });
        if let Some((request, answer)) = answer {
            let answer = answer.and_then(|answer| match answer {
                ScrollbackResponse::PaneCopySearch(result) => Ok(result),
                _ => Err(herdr_client::Error::ResponseType),
            });
            if let Some(range) = bar.search.answer(&request, answer) {
                self.reveal_find_match(range, cx);
            }
            cx.notify();
        }
        if let Some(bar) = &mut self.find
            && let Some(pane) = self
                .live
                .surface
                .as_deref()
                .and_then(|surface| pane_of(surface, bar.search.pane_id()))
        {
            bar.search.content_changed(pane, Instant::now());
        }
        self.flush_find(cx);
    }

    /// Keeps the bar with its pane as the user moves between tabs: a bar
    /// whose pane left the screen is put away, giving the terminal the
    /// keyboard it may hold, and comes back when that pane is focused again.
    /// A pane beside the focused one keeps its bar, as before.
    fn follow_find_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(surface) = self
            .live
            .surface
            .clone()
            .filter(|_| self.live.surface_ready())
        else {
            return;
        };
        if let Some(bar) = &self.find {
            if pane_of(&surface, bar.search.pane_id()).is_some() {
                return;
            }
            let left = if bar.input.read(cx).focus.is_focused(window) {
                Left::Typing
            } else {
                Left::Open
            };
            self.dismiss_find(Some(left), window, cx);
        }
        let Some(pane) = self.focused_surface_pane().cloned() else {
            return;
        };
        let Some(boot_id) = self.live.snapshot.as_ref().map(|s| s.boot_id.clone()) else {
            return;
        };
        if let Some(resume) = self.find_memory.resume(&boot_id, &pane.pane_id) {
            self.show_find(&pane, boot_id, &resume.query, resume.focus, window, cx);
        }
    }

    /// Sends the search that is due, if any, registering it in the mailbox
    /// before the worker can answer it.
    fn flush_find(&mut self, cx: &mut Context<Self>) {
        let Some(bar) = &mut self.find else {
            return;
        };
        let Some(pane) = self
            .live
            .surface
            .as_deref()
            .and_then(|surface| pane_of(surface, bar.search.pane_id()))
        else {
            return;
        };
        let Some((step, params)) = bar.search.next_request(pane) else {
            return;
        };
        let Some(handle) = &self.endpoints[self.selected_endpoint].connection.handle else {
            return;
        };
        let Ok(mut inbox) = bar.inbox.try_lock() else {
            return;
        };
        match inbox.send(|| handle.copy_search(&bar.boot_id, &params)) {
            Ok(request) => bar.search.sent(request, &params, step, Instant::now()),
            Err(error) => bar.search.send_failed(&error),
        }
        cx.notify();
    }

    /// Scrolls the bar's pane so `range` shows, when it does not already.
    fn reveal_find_match(&mut self, range: TextRange, cx: &mut Context<Self>) {
        let Some(bar) = &self.find else {
            return;
        };
        let Some(offset) = self
            .live
            .surface
            .as_deref()
            .and_then(|surface| pane_of(surface, bar.search.pane_id()))
            .and_then(|pane| reveal_offset(pane, range))
        else {
            return;
        };
        let Some(handle) = &self.endpoints[self.selected_endpoint].connection.handle else {
            return;
        };
        if let Err(error) = handle.request(
            &bar.boot_id,
            Method::PaneScroll,
            serde_json::json!({"pane_id": bar.search.pane_id(), "offset_from_bottom": offset}),
        ) {
            self.local_error = Some(format!("Scroll not sent: {error}"));
            cx.notify();
        }
    }

    /// The match highlights to paint over `surface`. A popup covers the
    /// panes, so nothing under it is tinted.
    pub(crate) fn find_highlights(&self, surface: &PaneSurfaceFrame) -> Vec<Highlight> {
        let Some(bar) = &self.find else {
            return Vec::new();
        };
        if surface.popup.is_some() {
            return Vec::new();
        }
        pane_of(surface, bar.search.pane_id())
            .map(|pane| bar.search.highlights(pane))
            .unwrap_or_default()
    }

    /// The focused pane as the live surface paints it.
    pub(super) fn focused_surface_pane(&self) -> Option<&PaneSurfacePane> {
        if !self.live.surface_ready() {
            return None;
        }
        let surface = self.live.surface.as_deref()?;
        if surface.popup.is_some() {
            return None;
        }
        let focused = self.live.snapshot.as_ref()?.focused_pane_id.as_deref()?;
        pane_of(surface, focused)
    }

    /// Keys the field leaves alone: Escape closes, Enter and the arrows move
    /// between matches. Everything else is the field's or the platform's.
    fn find_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bar) = &self.find else {
            return;
        };
        if bar.input.read(cx).is_composing() {
            return;
        }
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        let step = match keystroke.key.as_str() {
            "escape" if !modifiers.modified() => {
                self.close_find(window, cx);
                None
            }
            "enter" if modifiers.shift => Some(Step::Newer),
            "enter" => Some(Step::Older),
            "up" if !modifiers.modified() => Some(Step::Older),
            "down" if !modifiers.modified() => Some(Step::Newer),
            "g" if modifiers.secondary() && modifiers.shift => Some(Step::Newer),
            "g" if modifiers.secondary() => Some(Step::Older),
            _ => return,
        };
        if let Some(step) = step {
            self.find_step(step, cx);
        }
        cx.stop_propagation();
        window.prevent_default();
    }

    /// The bar, laid over the top right of its pane in the frame on screen.
    /// `gap` is the terminal's left padding, which absolute children sit
    /// inside of.
    pub(crate) fn render_find_bar(
        &self,
        surface: Option<&PaneSurfaceFrame>,
        gap: f32,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let bar = self.find.as_ref()?;
        let surface = surface.filter(|surface| surface.popup.is_none())?;
        let pane = pane_of(surface, bar.search.pane_id())?;
        let cell_height = self.config.terminal.line_height();
        let theme = &self.theme;
        let has_matches = bar.search.has_matches();
        let label = bar
            .search
            .error()
            .map_or_else(|| bar.search.label(), str::to_owned);
        let button = |id: &'static str, icon: &'static str, step: Option<Step>| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .flex_none()
                .size(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(crate::config::corners::CONTROL))
                .when(step.is_none() || has_matches, |button| {
                    button
                        .cursor_pointer()
                        .hover(|button| button.bg(rgba((theme.foreground << 8) | 0x14)))
                })
                .child(svg().path(icon).size(px(14.)).text_color(rgb(
                    if step.is_none() || has_matches {
                        theme.foreground
                    } else {
                        theme.muted
                    },
                )))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    match step {
                        Some(step) => this.find_step(step, cx),
                        None => this.close_find(window, cx),
                    }
                }))
        };
        Some(
            div()
                .absolute()
                .left(px(gap + f32::from(pane.rect.x) * self.cell_width))
                .top(px(f32::from(pane.rect.y) * cell_height))
                .w(px(f32::from(pane.rect.width) * self.cell_width))
                .flex()
                .justify_end()
                .p(px(6.))
                .child(
                    div()
                        .id("find-bar")
                        .debug_selector(|| "find-bar".into())
                        .occlude()
                        .min_w_0()
                        .w(px(320.))
                        .flex_shrink(1.)
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .p(px(4.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .border_1()
                        .border_color(rgb(theme.active))
                        .bg(rgb(theme.surface))
                        .text_color(rgb(theme.foreground))
                        .text_size(px(self.config.ui.size))
                        .shadow_md()
                        .on_key_down(cx.listener(Self::find_key_down))
                        .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                        .child(div().flex_1().min_w_0().child(bar.input.clone()))
                        .child(
                            div()
                                .debug_selector(|| "find-count".into())
                                .flex_none()
                                .px(px(4.))
                                .text_color(rgb(if bar.search.error().is_some() {
                                    theme.ink(theme.palette[1])
                                } else {
                                    theme.muted
                                }))
                                .child(label),
                        )
                        .child(button(
                            "find-older",
                            "icons/chevron-up.svg",
                            Some(Step::Older),
                        ))
                        .child(button(
                            "find-newer",
                            "icons/chevron-down.svg",
                            Some(Step::Newer),
                        ))
                        .child(button("find-close", "icons/x.svg", None)),
                ),
        )
    }
}

fn pane_of<'a>(surface: &'a PaneSurfaceFrame, pane_id: &str) -> Option<&'a PaneSurfacePane> {
    surface.panes.iter().find(|pane| pane.pane_id == pane_id)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
