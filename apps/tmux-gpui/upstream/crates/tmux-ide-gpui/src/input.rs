use super::{
    HerdrWindow,
    terminal::{input_area, input_cursor_bounds},
};
use gpui::*;
use herdr_client::protocol::ClientPaneInputEvent;
use std::ops::Range;

#[cfg(target_os = "linux")]
mod linux;
// The platform input handler for every view-backed text field. It is not named
// ElementInputHandler, so a `gpui::*` glob cannot silently replace it with
// GPUI's strong handler on Linux.
#[cfg(not(target_os = "linux"))]
pub(crate) use gpui::ElementInputHandler as ViewInputHandler;
#[cfg(target_os = "linux")]
pub(crate) use linux::WeakInputHandler as ViewInputHandler;

/// Which Option keys the keystroke being handled was made with. GPUI's
/// modifiers merge the two, so macOS's event in progress is asked; a key
/// event is handled while AppKit dispatches it, so that event is this one.
#[cfg(target_os = "macos")]
pub(crate) fn held_option_keys() -> crate::config::OptionKeys {
    use crate::config::OptionKeys;
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return OptionKeys::LEFT;
    };
    objc2_app_kit::NSApplication::sharedApplication(mtm)
        .currentEvent()
        .map_or(OptionKeys::LEFT, |event| {
            OptionKeys::from_device_flags(event.modifierFlags().0)
        })
}

/// Tells macOS's input method to drop its composition, once the update
/// that dropped the window's own has finished: the input method may call
/// back into the window, which must not be in use then.
#[cfg(target_os = "macos")]
fn discard_platform_composition(cx: &mut Context<HerdrWindow>) {
    cx.spawn(async move |_, _| {
        if let Some(mtm) = objc2::MainThreadMarker::new()
            && let Some(input) = objc2_app_kit::NSTextInputContext::currentInputContext(mtm)
        {
            input.discardMarkedText();
        }
    })
    .detach();
}

/// Elsewhere the platform keeps no composition the window must end.
#[cfg(not(target_os = "macos"))]
fn discard_platform_composition(_: &mut Context<HerdrWindow>) {}

impl HerdrWindow {
    /// Drops the terminal's composition, here and in the platform's input
    /// method, when its pane or connection changes under it. Otherwise the
    /// next keystroke would carry on the dropped text into the new pane.
    pub(crate) fn discard_composition(&mut self, cx: &mut Context<Self>) {
        if self.marked.is_empty() {
            return;
        }
        self.marked.clear();
        self.marked_selection = None;
        #[cfg(feature = "integration-test")]
        {
            self.input_probe.compositions_discarded += 1;
        }
        discard_platform_composition(cx);
    }
}

/// Elsewhere Alt has no sides that matter: it always reaches the pane.
#[cfg(not(target_os = "macos"))]
pub(crate) fn held_option_keys() -> crate::config::OptionKeys {
    crate::config::OptionKeys::LEFT
}

impl EntityInputHandler for HerdrWindow {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        if self.menu.page.is_some() {
            let input = self.menu.input.as_ref()?;
            let range = input.range_from_utf16(range);
            *adjusted = Some(input.to_utf16(range.clone()));
            return Some(input.text[range].to_owned());
        }
        let text: Vec<u16> = self.marked.encode_utf16().collect();
        let range = range.start.min(text.len())..range.end.min(text.len());
        *adjusted = Some(range.clone());
        Some(String::from_utf16_lossy(&text[range]))
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        if self.menu.page.is_some() {
            let input = self.menu.input.as_ref()?;
            return Some(UTF16Selection {
                range: input.to_utf16(input.selection.clone()),
                reversed: input.reversed,
            });
        }
        let end = self.marked.encode_utf16().count();
        let range = self
            .marked_selection
            .clone()
            .filter(|range| range.start <= range.end && range.end <= end)
            .unwrap_or(end..end);
        Some(UTF16Selection {
            range,
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        if self.menu.page.is_some() {
            let input = self.menu.input.as_ref()?;
            return input.marked.clone().map(|range| input.to_utf16(range));
        }
        (!self.marked.is_empty()).then(|| 0..self.marked.encode_utf16().count())
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(input) = self.menu.input.as_mut() {
            input.marked = None;
        }
        self.marked.clear();
        self.marked_selection = None;
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.shift_taps.cancel();
        if self.menu.page.is_some() {
            if let Some(input) = self.menu.input.as_mut() {
                input.replace(range, text, false, None);
                cx.notify();
            }
            return;
        }
        if self.copy_mode_active() {
            self.copy_mode_text(text, cx);
            return;
        }
        #[cfg(feature = "integration-test")]
        {
            self.input_probe.text += 1;
        }
        self.marked.clear();
        self.marked_selection = None;
        if !text.is_empty() {
            self.send(ClientPaneInputEvent::TextCommit(text.into()), cx);
        }
        cx.notify();
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.shift_taps.cancel();
        if self.menu.page.is_some() {
            if let Some(input) = self.menu.input.as_mut() {
                input.replace(range, text, true, selected);
                cx.notify();
            }
            return;
        }
        // Copy mode has no composition: a key it does not know types nothing.
        if !self.input_ready() || self.copy_mode_active() {
            return;
        }
        self.marked = text.into();
        // The IME's caret, or the clause it is converting, so it asks for
        // the candidate window's place there rather than after the text.
        self.marked_selection = selected;
        cx.notify();
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        if self.menu.page.is_some() {
            return self.menu.input.as_ref()?.range_bounds(range);
        }
        let surface = self.live.surface.as_deref();
        let cell_height = self.config.terminal.line_height();
        let cursor = input_cursor_bounds(surface, self.bounds.origin, self.cell_width, cell_height);
        Some(self.painter.borrow().composition_bounds(
            &self.marked,
            range,
            cursor,
            input_area(surface, self.bounds, self.cell_width, cell_height),
            &self.config.terminal.font(),
            window,
        ))
    }
    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        if self.menu.page.is_some() {
            let input = self.menu.input.as_ref()?;
            let index = input.index_at(point)?;
            return Some(input.to_utf16(index..index).start);
        }
        None
    }
}

/// The terminal's platform input handler. A terminal repeats a held key, so
/// it opts out of macOS press-and-hold, which would otherwise swallow the
/// repeats and open the accent picker. Menu text fields keep the picker.
pub(crate) struct TerminalInputHandler {
    inner: ViewInputHandler<HerdrWindow>,
    press_and_hold: bool,
}

impl TerminalInputHandler {
    pub(crate) fn new(bounds: Bounds<Pixels>, view: Entity<HerdrWindow>, menu_open: bool) -> Self {
        Self {
            inner: ViewInputHandler::new(bounds, view),
            press_and_hold: menu_open,
        }
    }
}

impl InputHandler for TerminalInputHandler {
    fn selected_text_range(
        &mut self,
        ignore_disabled_input: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<UTF16Selection> {
        self.inner
            .selected_text_range(ignore_disabled_input, window, cx)
    }
    fn marked_text_range(&mut self, window: &mut Window, cx: &mut App) -> Option<Range<usize>> {
        self.inner.marked_text_range(window, cx)
    }
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        adjusted_range: &mut Option<Range<usize>>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<String> {
        self.inner
            .text_for_range(range_utf16, adjusted_range, window, cx)
    }
    fn replace_text_in_range(
        &mut self,
        replacement_range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.inner
            .replace_text_in_range(replacement_range, text, window, cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.inner.replace_and_mark_text_in_range(
            range_utf16,
            new_text,
            new_selected_range,
            window,
            cx,
        );
    }
    fn unmark_text(&mut self, window: &mut Window, cx: &mut App) {
        self.inner.unmark_text(window, cx);
    }
    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        self.inner.bounds_for_range(range_utf16, window, cx)
    }
    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<usize> {
        self.inner.character_index_for_point(point, window, cx)
    }
    fn apple_press_and_hold_enabled(&mut self) -> bool {
        self.press_and_hold
    }
}
