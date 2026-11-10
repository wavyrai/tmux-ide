//! The reader's paint, header and keys. Selection, scroll and find belong to the
//! window; the document belongs to the worker's publication.
use super::{Published, Status, find};
use crate::{search_input::SearchInput, tmux_snapshot::SnapshotView};
use bezel_markdown::{
    Annotation, BlockLayouts, Cursor, Editing, Part, RevealMode, Selection,
    render::selectable::{self, Pointer},
};
use gpui::{prelude::*, *};
use std::{
    collections::HashMap,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

/// Side padding of the text column, and its widest measure.
const SIDE: f32 = 28.;
const COLUMN: f32 = 720.;
/// How long "Updated just now" stays after a reload.
const UPDATED_FOR: Duration = Duration::from_secs(3);
/// One arrow-key step.
const LINE: f32 = 40.;

#[derive(Default)]
struct PaneView {
    scroll: ScrollHandle,
    layouts: BlockLayouts,
    selection: Option<Selection>,
    dragging: bool,
    generation: u64,
    updated_at: Option<Instant>,
}

struct Find {
    pane: String,
    input: Entity<SearchInput>,
    matches: Vec<Selection>,
    current: Option<usize>,
    generation: u64,
    _changed: Subscription,
}

#[derive(Default)]
pub(in crate::tmux_snapshot) struct Views {
    panes: HashMap<String, PaneView>,
    find: Option<Find>,
}

struct LinksInstalled;
impl Global for LinksInstalled {}

impl SnapshotView {
    fn reader(&self, pane: &str) -> Option<&Arc<Published>> {
        self.browser_state.readers.get(pane)
    }

    /// A reader that paints over its pane: anything but a read that failed,
    /// where the pane's terminal (`tmux-ide show`) is the better view.
    fn painted_reader(&self, pane: &str) -> Option<Arc<Published>> {
        self.reader(pane)
            .filter(|r| !matches!(r.status, Status::Unavailable | Status::OldDaemon))
            .cloned()
    }

    pub(in crate::tmux_snapshot) fn is_reader_pane(&self, pane: &str) -> bool {
        self.painted_reader(pane).is_some()
    }

    /// The reader bodies, each over its pane card's content area.
    pub(in crate::tmux_snapshot) fn reader_overlays(
        &mut self,
        width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        if self.browser_state.readers.is_empty() {
            self.reader.panes.clear();
            return Vec::new();
        }
        let Some(cards) = self.card_layout(width) else {
            return Vec::new();
        };
        if !cx.has_global::<LinksInstalled>() {
            bezel_markdown::AppExt::set_links::<super::ReaderLinks>(&mut **cx);
            cx.set_global(LinksInstalled);
        }
        let readers = self.browser_state.readers.clone();
        self.reader
            .panes
            .retain(|pane, _| readers.contains_key(pane));
        let mut out = Vec::new();
        for region in &cards.regions {
            let Some(published) = self.painted_reader(&region.id) else {
                continue;
            };
            let rect = cards.content(region);
            out.push(self.reader_body(&region.id, &published, rect, window, cx));
        }
        out
    }

    fn reader_body(
        &mut self,
        pane: &str,
        published: &Published,
        rect: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = crate::tmux_snapshot::design::palette(&self.theme());
        let view = self.reader.panes.entry(pane.to_owned()).or_default();
        if view.generation != published.generation {
            // A later read is a reload: say so in the header for a moment.
            if view.generation != 0 {
                view.updated_at = Some(Instant::now());
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(UPDATED_FOR).await;
                    let _ = this.update(cx, |_, cx| cx.notify());
                })
                .detach();
            }
            view.generation = published.generation;
            view.selection = None;
        }
        let id = pane.to_owned();
        let shell = div()
            .id(SharedString::from(format!("reader:{pane}")))
            .debug_selector({
                let id = id.clone();
                move || format!("reader:{id}")
            })
            .absolute()
            .left(rect.origin.x)
            .top(rect.origin.y)
            .w(rect.size.width)
            .h(rect.size.height)
            .overflow_hidden()
            .occlude()
            .bg(palette.terminal_bg)
            .text_color(palette.text)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |view, _, window, cx| {
                    if view.browser_state.selected_pane.as_deref() != Some(id.as_str()) {
                        view.select(
                            crate::tmux_snapshot::browser_ui::Selection::Pane(id.clone()),
                            window,
                            cx,
                        );
                    }
                    view.terminal_focus.focus(window, cx);
                }),
            )
            .on_scroll_wheel(|_, _, cx| cx.stop_propagation());
        let notice = |text: String| {
            div()
                .p(px(SIDE))
                .text_color(palette.text_muted)
                .child(text)
                .into_any_element()
        };
        let Some(doc) = published.doc.clone() else {
            let text = match &published.status {
                Status::TooLarge(size) => format!(
                    "{} is too large to show here ({:.1} MB; the limit is 4 MB). Run tmux-ide show {} in a terminal to read it.",
                    published.name,
                    *size as f64 / (1024. * 1024.),
                    published.name
                ),
                Status::Missing => format!("{} was removed or renamed.", published.name),
                _ => format!("Opening {}…", published.name),
            };
            return shell.child(notice(text)).into_any_element();
        };
        let missing = published.status == Status::Missing;
        let view = &self.reader.panes[pane];
        let (scroll, layouts, selection, dragging) = (
            view.scroll.clone(),
            view.layouts.clone(),
            view.selection,
            view.dragging,
        );
        let annotations: Vec<(Selection, Annotation)> = self
            .reader
            .find
            .as_ref()
            .filter(|f| f.pane == pane)
            .map(|f| {
                f.matches
                    .iter()
                    .enumerate()
                    .map(|(at, s)| {
                        let kind = if Some(at) == f.current {
                            Annotation::Current
                        } else {
                            Annotation::Match
                        };
                        (*s, kind)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let jump_layouts = layouts.clone();
        let jump: bezel_markdown::OnJump = Rc::new(move |block, window, _| {
            jump_layouts.reveal_with(
                Selection::at(Cursor::new(block, Part::Body, 0)),
                RevealMode::Nearest,
            );
            window.refresh();
        });
        let pointer_pane = pane.to_owned();
        let body = selectable::render_with(
            SharedString::from(format!("reader-text:{pane}")),
            &doc,
            &layouts,
            selection,
            dragging,
            Editing {
                annotations: &annotations,
                scroll: Some(&scroll),
                jump: Some(jump),
                ..Editing::default()
            },
            window,
            cx,
            move |view: &mut SnapshotView, pointer, cx| {
                let Some(pane) = view.reader.panes.get_mut(&pointer_pane) else {
                    return;
                };
                match pointer {
                    Pointer::Down(at, unit) => {
                        let range = if unit == bezel_ui::input::Granularity::Char {
                            at..at
                        } else {
                            match view
                                .browser_state
                                .readers
                                .get(&pointer_pane)
                                .and_then(|r| r.doc.as_ref())
                            {
                                Some(doc) => at.span(unit, doc),
                                None => at..at,
                            }
                        };
                        pane.selection = Some(Selection::new(range.start, range.end));
                        pane.dragging = true;
                    }
                    Pointer::Move(at) => {
                        if let Some(selection) = pane.selection {
                            pane.selection = Some(selection.extend_to(at));
                        }
                    }
                    Pointer::Up => pane.dragging = false,
                }
                cx.notify();
            },
        );
        let mut column = div().w_full().max_w(px(COLUMN)).py(px(SIDE * 0.75));
        if missing {
            column = column.child(
                div()
                    .pb_3()
                    .text_color(palette.text_muted)
                    .child(format!("{} was removed or renamed.", published.name)),
            );
        }
        if published.lossy {
            column = column.child(
                div()
                    .pb_3()
                    .text_color(palette.text_muted)
                    .child("Some bytes in this file are not UTF-8 and show as \u{fffd}."),
            );
        }
        column = column.child(div().when(missing, |d| d.opacity(0.5)).child(body));
        shell
            .child(
                div()
                    .id(SharedString::from(format!("reader-scroll:{pane}")))
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&scroll)
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .justify_center()
                            .px(px(SIDE))
                            .child(column),
                    ),
            )
            .into_any_element()
    }

    /// The header for a reader pane: its name, its folder dimmed, a short
    /// "Updated just now" after a reload, and the find field while it is open.
    pub(in crate::tmux_snapshot) fn reader_header(
        &self,
        pane: &str,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let published = self.painted_reader(pane)?;
        let theme = self.theme();
        let palette = crate::tmux_snapshot::design::palette(&theme);
        let ink = crate::tmux_snapshot::pane_chrome::header_ink(&theme);
        let updated = self
            .reader
            .panes
            .get(pane)
            .and_then(|v| v.updated_at)
            .is_some_and(|at| at.elapsed() < UPDATED_FOR);
        let state = match published.status {
            Status::Missing => Some("Removed"),
            Status::TooLarge(_) => Some("Too large"),
            _ => updated.then_some("Updated just now"),
        };
        let mut row = div()
            .flex()
            .items_center()
            .gap(px(bezel_theme::Theme::SPACE))
            .flex_1()
            .min_w_0()
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .min_w(px(80.))
                    .flex_shrink_0()
                    .max_w(px(360.))
                    .overflow_hidden()
                    .child(div().min_w_0().truncate().child(published.name.clone()))
                    .when(!published.folder.is_empty(), |d| {
                        d.child(
                            div()
                                .flex_none()
                                .text_color(ink.muted)
                                .font_weight(FontWeight::NORMAL)
                                .child(format!(" · {}", published.folder)),
                        )
                    }),
            )
            .children(state.map(|s| {
                div()
                    .flex_none()
                    .text_color(palette.text_faint)
                    .font_weight(FontWeight::NORMAL)
                    .child(s)
            }));
        if let Some(find) = self.reader.find.as_ref().filter(|f| f.pane == pane) {
            let count = find::count_label(find.current, find.matches.len());
            let step = |name: &'static str, icon: &'static str, forward: bool| {
                div()
                    .id(name)
                    .flex_none()
                    .size(px(18.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_sm()
                    .cursor_pointer()
                    .hover(|d| d.bg(palette.element_hover))
                    .child(svg().path(icon).size(px(12.)).text_color(ink.muted))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.reader_find_step(forward, cx);
                    }))
            };
            row = row.child(div().flex_1()).child(
                div()
                    .id("reader-find")
                    .flex_shrink(1.)
                    .min_w(px(140.))
                    .w(px(300.))
                    .h(px(24.))
                    .px_2()
                    .gap_1()
                    .flex()
                    .items_center()
                    .rounded_md()
                    .border_1()
                    .border_color(palette.accent)
                    .bg(palette.input_bg)
                    .font_weight(FontWeight::NORMAL)
                    .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                        let key = event.keystroke.key.as_str();
                        if view
                            .reader
                            .find
                            .as_ref()
                            .is_some_and(|f| f.input.read(cx).is_composing())
                        {
                            return;
                        }
                        match key {
                            "escape" => view.close_reader_find(window, cx),
                            "enter" => view.reader_find_step(!event.keystroke.modifiers.shift, cx),
                            _ => return,
                        }
                        cx.stop_propagation();
                    }))
                    .child(
                        svg()
                            .path("icons/search.svg")
                            .size(px(12.))
                            .flex_none()
                            .text_color(ink.muted),
                    )
                    .child(div().flex_1().min_w_0().child(find.input.clone()))
                    .child(
                        div()
                            .flex_none()
                            .text_xs()
                            .text_color(palette.text_faint)
                            .child(count),
                    )
                    .child(step("reader-find-previous", "icons/chevron-up.svg", false))
                    .child(step("reader-find-next", "icons/chevron-down.svg", true)),
            );
        }
        Some(row.into_any_element())
    }

    fn reader_doc(&self, pane: &str) -> Option<Arc<bezel_markdown::Doc>> {
        self.painted_reader(pane)?.doc.clone()
    }

    fn open_reader_find(&mut self, pane: String, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(find) = self.reader.find.as_ref().filter(|f| f.pane == pane) {
            find.input.read(cx).focus.clone().focus(window, cx);
            return;
        }
        let theme = self.theme();
        let input = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(256);
            input.set_placeholder("Find", cx);
            input.set_appearance(crate::config::Config::default().ui, theme, cx);
            input
        });
        let changed = cx.subscribe(&input, |view: &mut Self, _, _, cx| {
            view.refresh_reader_find(true, cx);
        });
        input.read(cx).focus.clone().focus(window, cx);
        self.reader.find = Some(Find {
            pane,
            input,
            matches: Vec::new(),
            current: None,
            generation: 0,
            _changed: changed,
        });
        cx.notify();
    }

    /// Dev-only: find open with a query typed, for `+reader` captures.
    #[cfg(feature = "visual-capture")]
    pub(in crate::tmux_snapshot) fn capture_reader_find(
        &mut self,
        pane: &str,
        query: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_reader_find(pane.to_owned(), window, cx);
        if let Some(find) = &self.reader.find {
            find.input
                .update(cx, |input, cx| input.set_text_selected(query, cx));
        }
        self.refresh_reader_find(true, cx);
        // The reload notice, as in the mockup.
        let view = self.reader.panes.entry(pane.to_owned()).or_default();
        view.generation = self
            .browser_state
            .readers
            .get(pane)
            .map_or(0, |r| r.generation);
        view.updated_at = Some(Instant::now());
    }

    fn close_reader_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reader.find = None;
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }

    /// Matches again after the query or the document changed. A new query
    /// starts at its first match and shows it.
    fn refresh_reader_find(&mut self, query_changed: bool, cx: &mut Context<Self>) {
        let Some(find) = &self.reader.find else {
            return;
        };
        let pane = find.pane.clone();
        let Some(doc) = self.reader_doc(&pane) else {
            return;
        };
        let generation = self.reader(&pane).map_or(0, |r| r.generation);
        let query = find.input.read(cx).text().to_owned();
        let matches = find::matches(&doc, &query);
        let Some(find) = &mut self.reader.find else {
            return;
        };
        find.current = if query_changed {
            find::step(None, matches.len(), true)
        } else {
            find.current.filter(|at| *at < matches.len())
        };
        find.matches = matches;
        find.generation = generation;
        let reveal = find.current.map(|at| find.matches[at]);
        if let (Some(range), Some(view)) = (reveal, self.reader.panes.get(&pane)) {
            view.layouts.reveal(range);
        }
        cx.notify();
    }

    fn reader_find_step(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Some(find) = &mut self.reader.find else {
            return;
        };
        find.current = find::step(find.current, find.matches.len(), forward);
        let pane = find.pane.clone();
        let reveal = find.current.map(|at| find.matches[at]);
        if let (Some(range), Some(view)) = (reveal, self.reader.panes.get(&pane)) {
            view.layouts.reveal(range);
        }
        cx.notify();
    }

    /// Keys for the focused reader pane: find, copy and scrolling. Plain keys
    /// stop here so typing never reaches the `tmux-ide show` process below.
    pub(in crate::tmux_snapshot) fn reader_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(pane) = self.browser_state.selected_pane.clone() else {
            return false;
        };
        if self
            .reader
            .find
            .as_ref()
            .is_some_and(|f| f.pane != pane || self.reader_doc(&f.pane).is_none())
        {
            self.reader.find = None;
        }
        if let Some(find) = &self.reader.find
            && find.generation != self.reader(&pane).map_or(0, |r| r.generation)
        {
            self.refresh_reader_find(false, cx);
        }
        let Some(doc) = self.reader_doc(&pane) else {
            return false;
        };
        if !self.terminal_focus.is_focused(window)
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || self.browser_address.is_some()
        {
            return false;
        }
        let keystroke = &event.keystroke;
        let m = keystroke.modifiers;
        let key = keystroke.key.as_str();
        let view = self.reader.panes.entry(pane.clone()).or_default();
        let scroll = view.scroll.clone();
        let page = f32::from(scroll.bounds().size.height) * 0.9;
        let by = |delta: f32| {
            let offset = scroll.offset();
            let max = scroll.max_offset().y;
            let y = (f32::from(offset.y) - delta).clamp(-f32::from(max), 0.);
            scroll.set_offset(point(offset.x, px(y)));
        };
        let handled = match (key, m.platform, m.control || m.alt) {
            ("f", true, false) if !m.shift => {
                self.open_reader_find(pane, window, cx);
                true
            }
            ("c", true, false) if !m.shift => match view.selection.filter(|s| !s.is_collapsed()) {
                Some(selection) => {
                    cx.write_to_clipboard(ClipboardItem::new_string(selectable::copied(
                        &doc, selection,
                    )));
                    true
                }
                None => false,
            },
            ("up", true, false) => {
                by(f32::MIN / 4.);
                true
            }
            ("down", true, false) => {
                by(f32::MAX / 4.);
                true
            }
            ("up", false, false) => {
                by(-LINE);
                true
            }
            ("down", false, false) => {
                by(LINE);
                true
            }
            ("pageup", false, false) => {
                by(-page);
                true
            }
            ("pagedown", false, false) => {
                by(page);
                true
            }
            ("space", false, false) => {
                by(if m.shift { -page } else { page });
                true
            }
            ("home", false, false) => {
                by(f32::MIN / 4.);
                true
            }
            ("end", false, false) => {
                by(f32::MAX / 4.);
                true
            }
            ("escape", false, false) => {
                view.selection = None;
                true
            }
            // Plain typing: swallowed so it never reaches `tmux-ide show`.
            (_, false, false) => true,
            _ => false,
        };
        if handled {
            cx.stop_propagation();
            window.prevent_default();
            cx.notify();
        }
        handled
    }
}
