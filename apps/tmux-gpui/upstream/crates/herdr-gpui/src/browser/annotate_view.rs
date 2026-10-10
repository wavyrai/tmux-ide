//! Annotating a page in a window: the picker's reports, the notes panel
//! beside the page, and sending the notes to the agent that opened it. The
//! notes are written in the app, never in the page, and nothing reaches an
//! agent until the user presses Send.
use super::{
    TabId,
    annotate::{self, Anchor, MAX_NOTES, Note, Rect, Report},
};
use crate::{
    HerdrWindow,
    motion::{self, ENTER, Toggle},
    search_input::SearchInput,
    window::Flash,
};
use gpui::{prelude::*, *};
use std::{collections::HashMap, sync::Arc, time::Instant};

mod delivery;
mod panel;
mod screenshots;

/// What the next note will be about, picked but not yet written, and its
/// screenshot once WebKit delivers it.
struct Draft {
    anchor: Anchor,
    image: Option<Arc<Image>>,
    capture: Option<u64>,
}

#[derive(Default)]
struct TabNotes {
    /// Whether the picker is running in the page.
    armed: bool,
    /// Whether a drag draws a region rather than selecting text.
    regions: bool,
    pending: Option<Draft>,
    notes: Vec<Note>,
}

pub(crate) struct Annotations {
    tabs: HashMap<TabId, TabNotes>,
    /// Each tab's notes panel, sliding open and closed beside its page.
    panels: HashMap<TabId, Toggle>,
    /// When each note a tab's panel draws was added, while it grows into the
    /// list; `None` for a note that is whole.
    drawn: HashMap<TabId, Vec<Option<Instant>>>,
    pub(super) input: Entity<SearchInput>,
    /// Numbers screenshots, to match each to its draft or note.
    captures: u64,
}

impl Annotations {
    pub(crate) fn new(cx: &mut App) -> Self {
        let input = cx.new(|cx| {
            let mut input = SearchInput::new(cx);
            input.set_placeholder("Describe the change\u{2026}", cx);
            input
        });
        Self {
            tabs: HashMap::new(),
            panels: HashMap::new(),
            drawn: HashMap::new(),
            input,
            captures: 0,
        }
    }

    pub(crate) fn armed(&self, id: TabId) -> bool {
        self.tabs.get(&id).is_some_and(|tab| tab.armed)
    }

    /// Whether the notes panel shows beside the page.
    pub(crate) fn open(&self, id: TabId) -> bool {
        self.tabs
            .get(&id)
            .is_some_and(|tab| tab.armed || tab.pending.is_some() || !tab.notes.is_empty())
    }

    pub(crate) fn ids(&self) -> impl Iterator<Item = TabId> + '_ {
        self.tabs.keys().copied()
    }

    #[cfg(test)]
    pub(super) fn queued(&self, id: TabId) -> usize {
        self.tabs.get(&id).map_or(0, |tab| tab.notes.len())
    }

    pub(crate) fn forget(&mut self, id: TabId) {
        self.tabs.remove(&id);
        self.panels.remove(&id);
        self.drawn.remove(&id);
    }

    #[cfg(test)]
    fn tab_notes_mut(&mut self, id: TabId) -> &mut TabNotes {
        self.tabs.entry(id).or_default()
    }

    /// How much of `id`'s notes panel shows at `now`, as it slides open or
    /// closed. A panel already open when first drawn is simply there.
    pub(crate) fn panel_shown(&mut self, id: TabId, now: Instant) -> f32 {
        let open = self.open(id);
        match self.panels.get_mut(&id) {
            Some(panel) => panel.set(open, now, false),
            None => {
                let mut panel = Toggle::default();
                panel.set(open, now, true);
                self.panels.insert(id, panel);
            }
        }
        self.panels.get(&id).map_or(0., |panel| panel.shown(now))
    }

    /// Records how many notes `id`'s panel draws at `now`; notes added
    /// since the last draw start growing in. Notes there when the panel first
    /// drew are whole.
    fn observe_notes(&mut self, id: TabId, count: usize, now: Instant) {
        let added = self.drawn.entry(id).or_insert_with(|| vec![None; count]);
        added.truncate(count);
        added.resize(count, Some(now));
    }

    /// How far note `index` of `id` has grown in at `now`, or `None` once
    /// it is whole.
    fn note_growth(&self, id: TabId, index: usize, now: Instant) -> Option<f32> {
        let since = (*self.drawn.get(&id)?.get(index)?)?;
        motion::progress(since, now, ENTER)
    }

    /// Whether a panel or a note is still moving, so the window draws
    /// another frame.
    pub(crate) fn moving(&self, now: Instant) -> bool {
        self.panels.values().any(|panel| panel.moving(now))
            || self
                .drawn
                .values()
                .flatten()
                .flatten()
                .any(|since| motion::progress(*since, now, ENTER).is_some())
    }
}

impl HerdrWindow {
    fn tab_notes(&mut self, id: TabId) -> &mut TabNotes {
        self.browser.annotations.tabs.entry(id).or_default()
    }

    /// Starts the picker in the page again, drawing the queued notes. A page
    /// loses it whenever it navigates.
    pub(crate) fn arm_page(&mut self, id: TabId, cx: &mut Context<Self>) {
        #[cfg(any(target_os = "macos", windows))]
        {
            let tab = self.tab_notes(id);
            let script = annotate::arm_script(&tab.notes);
            let regions = tab.regions;
            self.browser.pages.script(id, &script, cx);
            if regions {
                self.browser
                    .pages
                    .script(id, &annotate::mode_script(true), cx);
            }
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        let _ = (id, cx);
    }

    fn disarm_page(&mut self, id: TabId, cx: &mut Context<Self>) {
        #[cfg(any(target_os = "macos", windows))]
        self.browser.pages.script(id, annotate::disarm_script(), cx);
        #[cfg(not(any(target_os = "macos", windows)))]
        let _ = (id, cx);
    }

    pub(crate) fn toggle_annotating(
        &mut self,
        id: TabId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let notes = self.tab_notes(id);
        notes.armed = !notes.armed;
        if notes.armed {
            self.arm_page(id, cx);
            self.show_flash(
                Flash::success("Click an element or select text to note it"),
                cx,
            );
        } else {
            notes.pending = None;
            self.disarm_page(id, cx);
            window.focus(&self.focus, cx);
        }
        cx.notify();
    }

    /// Switches the picker between picking elements and drawing regions.
    fn toggle_regions(&mut self, id: TabId, cx: &mut Context<Self>) {
        let tab = self.tab_notes(id);
        tab.regions = !tab.regions;
        let regions = tab.regions;
        #[cfg(any(target_os = "macos", windows))]
        self.browser
            .pages
            .script(id, &annotate::mode_script(regions), cx);
        let _ = regions;
        cx.notify();
    }

    /// The picker lost its page to a navigation; put it back.
    pub(crate) fn page_loaded(&mut self, id: TabId, cx: &mut Context<Self>) {
        if self.browser.annotations.armed(id) {
            self.arm_page(id, cx);
        }
    }

    /// Applies what the picker posted. Only a tab being annotated listens,
    /// and a pick only fills the draft: the user still writes and sends.
    pub(crate) fn page_posted(
        &mut self,
        id: TabId,
        body: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.browser.annotations.armed(id) {
            return;
        }
        match Report::parse(body) {
            Some(Report::Picked { anchor, shot }) => {
                self.begin_note(id, anchor, shot, window, cx);
            }
            Some(Report::Cancelled) => {
                if self.tab_notes(id).pending.take().is_none() {
                    self.toggle_annotating(id, window, cx);
                }
                cx.notify();
            }
            None => tracing::debug!("Ignored a malformed annotation message"),
        }
    }

    pub(super) fn begin_note(
        &mut self,
        id: TabId,
        anchor: Anchor,
        shot: Option<Rect>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.tab_notes(id).notes.len() >= MAX_NOTES {
            self.reveal_page(id, cx);
            self.show_flash(
                Flash::warning("Send or remove notes before adding more"),
                cx,
            );
            return;
        }
        // The picker hid its overlay for the screenshot; WebKit takes it
        // after the next screen update, then the overlay comes back.
        let capture = shot.and_then(|rect| {
            self.browser.annotations.captures += 1;
            let capture = self.browser.annotations.captures;
            #[cfg(any(target_os = "macos", windows))]
            let asked = self.browser.pages.capture(id, rect, capture, cx);
            #[cfg(not(any(target_os = "macos", windows)))]
            let asked = {
                let _ = rect;
                false
            };
            asked.then_some(capture)
        });
        if capture.is_none() {
            self.reveal_page(id, cx);
        }
        self.tab_notes(id).pending = Some(Draft {
            anchor,
            image: None,
            capture,
        });
        // The page holds the keyboard natively; the note is typed here.
        #[cfg(any(target_os = "macos", windows))]
        self.browser.pages.blur(id, cx);
        let input = self.browser.annotations.input.clone();
        input.update(cx, |input, cx| input.clear(cx));
        let focus = input.read(cx).focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    fn reveal_page(&mut self, id: TabId, cx: &mut Context<Self>) {
        #[cfg(any(target_os = "macos", windows))]
        self.browser.pages.script(id, annotate::reveal_script(), cx);
        #[cfg(not(any(target_os = "macos", windows)))]
        let _ = (id, cx);
    }

    /// A screenshot arrived from WebKit: bring the overlay back, turn the
    /// capture into a PNG off the UI thread, and give it to its draft or note.
    #[cfg(target_os = "macos")]
    pub(crate) fn page_captured(
        &mut self,
        id: TabId,
        capture: u64,
        tiff: Option<Vec<u8>>,
        cx: &mut Context<Self>,
    ) {
        self.reveal_page(id, cx);
        let Some(tiff) = tiff else {
            return;
        };
        let png = cx
            .background_executor()
            .spawn(async move { super::snapshot::png(&tiff) });
        cx.spawn(async move |this, cx| {
            let Some(png) = png.await else {
                return;
            };
            let image = Arc::new(Image::from_bytes(ImageFormat::Png, png));
            this.update(cx, |this, cx| {
                this.attach_screenshot(id, capture, image);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    #[cfg(target_os = "macos")]
    fn attach_screenshot(&mut self, id: TabId, capture: u64, image: Arc<Image>) {
        let Some(tab) = self.browser.annotations.tabs.get_mut(&id) else {
            return;
        };
        if let Some(draft) = tab
            .pending
            .as_mut()
            .filter(|draft| draft.capture == Some(capture))
        {
            draft.image = Some(image);
            draft.capture = None;
        } else if let Some(note) = tab
            .notes
            .iter_mut()
            .find(|note| note.capture == Some(capture))
        {
            note.image = Some(image);
            note.capture = None;
        }
    }

    pub(super) fn add_note(&mut self, id: TabId, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.browser.annotations.input.read(cx).text().to_owned();
        let Some(draft) = self.tab_notes(id).pending.take() else {
            return;
        };
        let Some(mut note) = Note::new(draft.anchor.clone(), &text) else {
            self.tab_notes(id).pending = Some(draft);
            self.show_flash(Flash::warning("Write what should change first"), cx);
            return;
        };
        note.image = draft.image;
        note.capture = draft.capture;
        let notes = self.tab_notes(id);
        notes.notes.push(note);
        self.browser
            .annotations
            .input
            .update(cx, |input, cx| input.clear(cx));
        self.refresh_markers(id, cx);
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn refresh_markers(&mut self, id: TabId, cx: &mut Context<Self>) {
        if self.browser.annotations.armed(id) {
            self.arm_page(id, cx);
        }
    }

    fn remove_note(&mut self, id: TabId, index: usize, cx: &mut Context<Self>) {
        let notes = self.tab_notes(id);
        if index < notes.notes.len() {
            notes.notes.remove(index);
        }
        self.refresh_markers(id, cx);
        cx.notify();
    }

    fn clear_notes(&mut self, id: TabId, cx: &mut Context<Self>) {
        self.tab_notes(id).notes.clear();
        self.refresh_markers(id, cx);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::{Annotations, ENTER, Instant, TabId};

    #[gpui::test]
    fn new_notes_grow_in_and_the_panel_slides(cx: &mut gpui::TestAppContext) {
        let id = TabId::test(7);
        cx.update(|cx| {
            let mut annotations = Annotations::new(cx);
            let start = Instant::now();
            // Notes a panel has when it first draws are whole.
            annotations.observe_notes(id, 2, start);
            assert_eq!(annotations.note_growth(id, 1, start), None);
            assert!(!annotations.moving(start));
            // One added since grows in, then is whole.
            annotations.observe_notes(id, 3, start);
            assert_eq!(annotations.note_growth(id, 2, start), Some(0.));
            assert_eq!(annotations.note_growth(id, 1, start), None);
            assert!(annotations.moving(start));
            assert_eq!(annotations.note_growth(id, 2, start + ENTER), None);
            // Sent notes leave; the next one grows in again.
            annotations.observe_notes(id, 0, start + ENTER);
            annotations.observe_notes(id, 1, start + ENTER);
            assert!(annotations.note_growth(id, 0, start + ENTER).is_some());

            // A closed panel first drawn closed shows nothing; opening slides.
            let page = TabId::test(8);
            assert_eq!(annotations.panel_shown(page, start), 0.);
            annotations.tab_notes_mut(page).armed = true;
            assert_eq!(annotations.panel_shown(page, start), 0.);
            assert_eq!(annotations.panel_shown(page, start + ENTER), 1.);
            annotations.forget(page);
            annotations.forget(id);
            assert!(!annotations.moving(start + ENTER));
        });
    }
}
