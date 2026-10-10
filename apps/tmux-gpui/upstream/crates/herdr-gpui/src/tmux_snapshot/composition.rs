//! Platform composition stays local until the input method commits it.
use super::{SnapshotView, keys::Input};
use gpui::*;
use std::ops::Range;

// AppKit replacement ranges are UTF-16 offsets within our local marked text.
// Never reinterpret a range outside that buffer as editing terminal history.
fn replacement(marked: &str, range: Option<Range<usize>>, text: &str) -> Option<(String, usize)> {
    let old: Vec<u16> = marked.encode_utf16().collect();
    let range = range.unwrap_or(0..old.len());
    let added = text.encode_utf16().count();
    if range.start > range.end
        || range.end > old.len()
        || text.contains('\0')
        || old.len() - (range.end - range.start) + added > 1024
    {
        return None;
    }
    let prefix = String::from_utf16(&old[..range.start]).ok()?;
    let suffix = String::from_utf16(&old[range.end..]).ok()?;
    Some((format!("{prefix}{text}{suffix}"), range.start))
}

impl SnapshotView {
    pub(super) fn discard_composition(&mut self, cx: &mut Context<Self>) {
        self.marked.clear();
        self.marked_selection = None;
        #[cfg(target_os = "macos")]
        cx.spawn(async move |entity, cx| {
            let terminal_owns_input = entity
                .update(cx, |view, _| {
                    view.picker.is_none()
                        && view.pane_actions.is_none()
                        && view.new_session.is_none()
                })
                .unwrap_or(false);
            if terminal_owns_input
                && let Some(mtm) = objc2::MainThreadMarker::new()
                && let Some(input) = objc2_app_kit::NSTextInputContext::currentInputContext(mtm)
            {
                input.discardMarkedText();
            }
        })
        .detach();
    }
    fn accepts_text(&mut self, window: &Window, cx: &mut Context<Self>) -> bool {
        self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
            && self.selection.is_none()
            && self.offer_terminal_input(cx)
            && self.terminal_focus.is_focused(window)
    }
}
impl EntityInputHandler for SnapshotView {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let text: Vec<u16> = self.marked.encode_utf16().collect();
        if range.start > range.end || range.end > text.len() {
            return None;
        }
        *actual = Some(range.clone());
        String::from_utf16(&text[range]).ok()
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.marked.encode_utf16().count();
        Some(UTF16Selection {
            range: self.marked_selection.clone().unwrap_or(end..end),
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        (!self.marked.is_empty()).then(|| 0..self.marked.encode_utf16().count())
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked.clear();
        self.marked_selection = None;
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let committed = replacement(&self.marked, range, text);
        self.marked.clear();
        self.marked_selection = None;
        if self.accepts_text(window, cx)
            && let Some((text, _)) = committed
            && !text.is_empty()
        {
            self.queue_input(Input::Text(text), cx);
        }
        cx.notify();
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selection: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.accepts_text(window, cx) {
            return;
        }
        let Some((marked, offset)) = replacement(&self.marked, range, text) else {
            self.discard_composition(cx);
            return;
        };
        let len = text.encode_utf16().count();
        self.marked = marked;
        self.marked_selection = selection
            .filter(|r| r.start <= r.end && r.end <= len)
            .map(|r| (offset + r.start)..(offset + r.end));
        cx.notify();
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let (bounds, cursor) = self.input_geometry?;
        Some(self.painter.borrow().composition_bounds(
            &self.marked,
            range,
            cursor,
            bounds,
            &font("Menlo"),
            window,
        ))
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

#[cfg(test)]
#[path = "composition_tests.rs"]
mod tests;
