use gpui::{prelude::*, *};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

use super::{HerdrWindow, input::ViewInputHandler};

// Byte offsets internally; only the platform input boundary uses UTF-16.
#[derive(Default)]
pub(super) struct DialogInput {
    pub text: String,
    pub selection: Range<usize>,
    pub reversed: bool,
    pub marked: Option<Range<usize>>,
    pub bounds: Bounds<Pixels>,
    line: Option<ShapedLine>,
    scroll: Pixels,
}

impl DialogInput {
    pub fn new(text: String) -> Self {
        Self {
            selection: 0..text.len(),
            text,
            ..Self::default()
        }
    }

    pub fn range_from_utf16(&self, range: Range<usize>) -> Range<usize> {
        let start = byte_offset(&self.text, range.start);
        start..byte_offset(&self.text, range.end).max(start)
    }

    pub fn to_utf16(&self, range: Range<usize>) -> Range<usize> {
        self.text[..range.start].encode_utf16().count()
            ..self.text[..range.end].encode_utf16().count()
    }

    pub fn replace(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        marked: bool,
        selected: Option<Range<usize>>,
    ) {
        let range = range
            .map(|r| self.range_from_utf16(r))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection.clone());
        let text: String = text
            .chars()
            .filter(|c| !c.is_control())
            .take(4096)
            .collect();
        if self.text.len() - range.len() + text.len() > 16384 {
            return;
        }
        self.text.replace_range(range.clone(), &text);
        let end = range.start + text.len();
        self.selection = if let Some(selected) = selected {
            let start = byte_offset(&text, selected.start);
            range.start + start..range.start + byte_offset(&text, selected.end).max(start)
        } else {
            end..end
        };
        self.reversed = false;
        self.marked = (marked && !text.is_empty()).then_some(range.start..end);
        self.line = None;
    }

    fn cursor(&self) -> usize {
        if self.reversed {
            self.selection.start
        } else {
            self.selection.end
        }
    }

    fn move_to(&mut self, offset: usize, extend: bool) {
        let anchor = if self.reversed {
            self.selection.end
        } else {
            self.selection.start
        };
        self.selection = if extend {
            anchor.min(offset)..anchor.max(offset)
        } else {
            offset..offset
        };
        self.reversed = extend && offset < anchor;
    }

    pub fn key(&mut self, key: &Keystroke, cx: &mut App) -> bool {
        if self.marked.is_some() {
            return false;
        }
        let cursor = self.cursor();
        let previous = self
            .text
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .rfind(|i| *i < cursor)
            .unwrap_or(0);
        let next = self
            .text
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .find(|i| *i > cursor)
            .unwrap_or(self.text.len());
        match key.key.as_str() {
            "a" if key.modifiers.platform => {
                self.selection = 0..self.text.len();
                self.reversed = false;
            }
            "v" if key.modifiers.platform => {
                if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    self.replace(None, &text, false, None);
                }
            }
            "c" | "x" if key.modifiers.platform => {
                if !self.selection.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        self.text[self.selection.clone()].into(),
                    ));
                    if key.key == "x" {
                        self.replace(None, "", false, None);
                    }
                }
            }
            "left" | "right" | "home" | "end" => {
                let offset = match key.key.as_str() {
                    "home" => 0,
                    "end" => self.text.len(),
                    "left" if key.modifiers.platform => 0,
                    "right" if key.modifiers.platform => self.text.len(),
                    "left" if !key.modifiers.shift && !self.selection.is_empty() => {
                        self.selection.start
                    }
                    "right" if !key.modifiers.shift && !self.selection.is_empty() => {
                        self.selection.end
                    }
                    "left" => previous,
                    _ => next,
                };
                self.move_to(offset, key.modifiers.shift);
            }
            "backspace" | "delete" => {
                if self.selection.is_empty() {
                    // Cmd deletes to the line's start or end, as macOS fields do.
                    self.selection = match (key.key.as_str(), key.modifiers.platform) {
                        ("backspace", true) => 0..cursor,
                        ("backspace", false) => previous..cursor,
                        (_, true) => cursor..self.text.len(),
                        (_, false) => cursor..next,
                    };
                }
                self.replace(None, "", false, None);
            }
            _ => return false,
        }
        true
    }

    pub fn index_at(&self, position: Point<Pixels>) -> Option<usize> {
        self.line
            .as_ref()
            .map(|line| line.closest_index_for_x(position.x - self.bounds.left() + self.scroll))
    }

    pub fn range_bounds(&self, range: Range<usize>) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(range);
        let line = self.line.as_ref()?;
        let x = |index| {
            (self.bounds.left() + line.x_for_index(index) - self.scroll)
                .clamp(self.bounds.left(), self.bounds.right())
        };
        Some(Bounds::from_corners(
            point(x(range.start), self.bounds.top()),
            point(x(range.end), self.bounds.bottom()),
        ))
    }
}

fn byte_offset(text: &str, offset: usize) -> usize {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units >= offset {
            return byte;
        }
        units += ch.len_utf16();
    }
    text.len()
}

impl HerdrWindow {
    pub(super) fn render_dialog_input(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let entity = cx.entity();
        let focus = self.menu.focus.clone();
        div()
            .id("dialog-input")
            .debug_selector(|| "dialog-input".into())
            .w_full()
            .h(px(self.config.ui.line_height() + 10.))
            .px(px(6.))
            .py(px(5.))
            .rounded(px(crate::config::corners::CONTROL))
            .bg(rgb(self.theme.active))
            .overflow_hidden()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    // Another field of the same dialog may hold focus.
                    window.focus(&this.menu.focus, cx);
                    if let Some(input) = this.menu.input.as_mut()
                        && input.marked.is_none()
                        && let Some(index) = input.index_at(event.position)
                    {
                        input.move_to(index, event.modifiers.shift);
                        cx.notify();
                    }
                }),
            )
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, cx| {
                        // Unfocused, the draft reads as plain text: no caret or
                        // selection that would look like it is about to be replaced.
                        let focused = focus.is_focused(window);
                        window.handle_input(
                            &focus,
                            ViewInputHandler::new(bounds, entity.clone()),
                            cx,
                        );
                        entity.update(cx, |this, cx| {
                            let Some(input) = this.menu.input.as_mut() else {
                                return;
                            };
                            let run = TextRun {
                                len: input.text.len(),
                                font: this.config.ui.font(),
                                color: rgb(this.theme.foreground).into(),
                                background_color: None,
                                underline: None,
                                strikethrough: None,
                            };
                            let line = window.text_system().shape_line(
                                input.text.clone().into(),
                                px(this.config.ui.size),
                                &[run],
                                None,
                            );
                            let caret = line.x_for_index(input.cursor());
                            input.scroll = input
                                .scroll
                                .min(caret)
                                .max(caret - bounds.size.width + px(2.))
                                .max(px(0.));
                            let origin = bounds.origin - point(input.scroll, px(0.));
                            window.with_content_mask(Some(ContentMask { bounds }), |window| {
                                let left = origin.x + line.x_for_index(input.selection.start);
                                let right = origin.x + line.x_for_index(input.selection.end);
                                if focused && !input.selection.is_empty() {
                                    window.paint_quad(fill(
                                        Bounds::from_corners(
                                            point(left, bounds.top()),
                                            point(right, bounds.bottom()),
                                        ),
                                        rgb(this.theme.muted),
                                    ));
                                }
                                let _ = line.paint(
                                    origin,
                                    bounds.size.height,
                                    TextAlign::Left,
                                    None,
                                    window,
                                    cx,
                                );
                                if focused {
                                    window.paint_quad(fill(
                                        Bounds::new(
                                            point(origin.x + caret, bounds.top()),
                                            size(px(1.), bounds.size.height),
                                        ),
                                        rgb(this.theme.foreground),
                                    ));
                                }
                                if let Some(marked) = &input.marked {
                                    window.paint_quad(fill(
                                        Bounds::new(
                                            point(
                                                origin.x + line.x_for_index(marked.start),
                                                bounds.bottom() - px(1.),
                                            ),
                                            size(
                                                line.x_for_index(marked.end)
                                                    - line.x_for_index(marked.start),
                                                px(1.),
                                            ),
                                        ),
                                        rgb(this.theme.foreground),
                                    ));
                                }
                            });
                            input.bounds = bounds;
                            input.line = Some(line);
                        });
                    },
                )
                .size_full(),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::DialogInput;
    use gpui::Keystroke;

    #[test]
    fn utf16_replacement_and_composition_use_relative_selection() {
        let mut input = DialogInput::new("a\u{1f600}z".into());
        assert_eq!(input.range_from_utf16(1..3), 1..5);
        assert_eq!(input.to_utf16(1..5), 1..3);
        input.replace(Some(1..3), "\u{65e5}\u{1f600}", true, Some(1..3));
        assert_eq!(input.text, "a\u{65e5}\u{1f600}z");
        assert_eq!(input.selection, 4..8);
        assert_eq!(input.marked, Some(1..8));
        input.replace(None, "\u{672c}", true, Some(1..1));
        assert_eq!(input.text, "a\u{672c}z");
        assert_eq!(input.selection, 4..4);
        input.replace(None, "\u{65e5}\u{672c}", false, None);
        assert_eq!(input.text, "a\u{65e5}\u{672c}z");
        assert_eq!(input.selection, 7..7);
        assert!(input.marked.is_none());
        assert_eq!(
            input.range_from_utf16(999..1000),
            input.text.len()..input.text.len()
        );
    }

    #[gpui::test]
    fn editing_uses_graphemes_selection_clipboard_and_bounded_single_line_text(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.update(|cx| {
            let mut input =
                DialogInput::new("e\u{301}\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}".into());
            input.key(&Keystroke::parse("end").unwrap_or_default(), cx);
            input.key(&Keystroke::parse("backspace").unwrap_or_default(), cx);
            assert_eq!(input.text, "e\u{301}");
            input.key(&Keystroke::parse("shift-left").unwrap_or_default(), cx);
            assert_eq!(input.selection, 0..3);
            input.key(&Keystroke::parse("cmd-x").unwrap_or_default(), cx);
            assert_eq!(input.text, "");
            input.key(&Keystroke::parse("cmd-v").unwrap_or_default(), cx);
            assert_eq!(input.text, "e\u{301}");
            input.replace(None, "\n\r\tX", false, None);
            assert_eq!(input.text, "e\u{301}X");
            input.replace(None, &"x".repeat(20000), false, None);
            assert_eq!(input.text.len(), 4100);
        });
    }

    #[gpui::test]
    fn cmd_backspace_and_cmd_delete_reach_the_line_ends(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            let mut input = DialogInput::new("one two".into());
            input.key(&Keystroke::parse("cmd-left").unwrap_or_default(), cx);
            for _ in 0..3 {
                input.key(&Keystroke::parse("right").unwrap_or_default(), cx);
            }
            input.key(&Keystroke::parse("cmd-delete").unwrap_or_default(), cx);
            assert_eq!(input.text, "one");
            input.key(&Keystroke::parse("left").unwrap_or_default(), cx);
            input.key(&Keystroke::parse("cmd-backspace").unwrap_or_default(), cx);
            assert_eq!(input.text, "e");
            assert_eq!(input.selection, 0..0);
        });
    }
}
