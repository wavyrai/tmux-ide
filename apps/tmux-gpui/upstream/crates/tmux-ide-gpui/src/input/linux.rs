//! GPUI 0.3.6 retains Wayland input handlers past its entity leak check at quit.
//! The view's UI owner keeps it alive; the platform handler must not extend that
//! lifetime. The backend (Wayland or X11) is chosen at runtime, so every Linux
//! build uses this handler. Other platforms use GPUI's own ElementInputHandler.
use gpui::*;
use std::ops::Range;

/// Forwards to the view like GPUI's `ElementInputHandler`, but through a weak
/// reference. Callbacks after the view is released return the default value.
pub(crate) struct WeakInputHandler<V: EntityInputHandler> {
    view: WeakEntity<V>,
    bounds: Bounds<Pixels>,
}

impl<V: EntityInputHandler> WeakInputHandler<V> {
    pub(crate) fn new(bounds: Bounds<Pixels>, view: Entity<V>) -> Self {
        Self {
            view: view.downgrade(),
            bounds,
        }
    }

    fn update<R: Default>(
        &self,
        cx: &mut App,
        callback: impl FnOnce(&mut V, &mut Context<V>) -> R,
    ) -> R {
        self.view.update(cx, callback).unwrap_or_default()
    }
}

impl<V: EntityInputHandler> InputHandler for WeakInputHandler<V> {
    fn selected_text_range(
        &mut self,
        ignore_disabled_input: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<UTF16Selection> {
        self.update(cx, |view, cx| {
            view.selected_text_range(ignore_disabled_input, window, cx)
        })
    }

    fn marked_text_range(&mut self, window: &mut Window, cx: &mut App) -> Option<Range<usize>> {
        self.update(cx, |view, cx| view.marked_text_range(window, cx))
    }

    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        adjusted_range: &mut Option<Range<usize>>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<String> {
        self.update(cx, |view, cx| {
            view.text_for_range(range_utf16, adjusted_range, window, cx)
        })
    }

    fn replace_text_in_range(
        &mut self,
        replacement_range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.update(cx, |view, cx| {
            view.replace_text_in_range(replacement_range, text, window, cx)
        });
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.update(cx, |view, cx| {
            view.replace_and_mark_text_in_range(
                range_utf16,
                new_text,
                new_selected_range,
                window,
                cx,
            )
        });
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut App) {
        self.update(cx, |view, cx| view.unmark_text(window, cx));
    }

    fn paste(&mut self, item: ClipboardItem, window: &mut Window, cx: &mut App) {
        self.update(cx, |view, cx| view.paste(item, window, cx));
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        let bounds = self.bounds;
        self.update(cx, |view, cx| {
            view.bounds_for_range(range_utf16, bounds, window, cx)
        })
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<usize> {
        self.update(cx, |view, cx| {
            view.character_index_for_point(point, window, cx)
        })
    }

    fn set_selected_text_range(
        &mut self,
        range_utf16: Range<usize>,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.update(cx, |view, cx| {
            view.set_selected_text_range(range_utf16, window, cx)
        });
    }

    fn element_bounds(&mut self, _: &mut Window, _: &mut App) -> Option<Bounds<Pixels>> {
        self.view.upgrade().map(|_| self.bounds)
    }

    fn text_length_utf16(&mut self, window: &mut Window, cx: &mut App) -> Option<usize> {
        self.update(cx, |view, cx| view.text_length_utf16(window, cx))
    }

    fn accepts_text_input(&mut self, window: &mut Window, cx: &mut App) -> bool {
        self.update(cx, |view, cx| view.accepts_text_input(window, cx))
    }

    // Matches GPUI's ElementInputHandler, which answers from accepts_text_input.
    fn prefers_ime_for_printable_keys(&mut self, window: &mut Window, cx: &mut App) -> bool {
        self.update(cx, |view, cx| view.accepts_text_input(window, cx))
    }

    fn text_input_configuration(
        &mut self,
        window: &mut Window,
        cx: &mut App,
    ) -> TextInputConfiguration {
        self.update(cx, |view, cx| view.text_input_configuration(window, cx))
    }

    fn text_input_editable_range(
        &mut self,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Range<usize>> {
        self.update(cx, |view, cx| view.text_input_editable_range(window, cx))
    }
}

#[cfg(test)]
mod tests;
