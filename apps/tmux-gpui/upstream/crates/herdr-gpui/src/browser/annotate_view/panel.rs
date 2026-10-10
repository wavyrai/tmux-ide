//! The notes panel drawn beside an annotated page.

use super::super::Tab;
use crate::{
    HerdrWindow,
    browser::annotate::{Anchor, Note},
};
use gpui::{prelude::*, *};
use std::{sync::Arc, time::Instant};

impl HerdrWindow {
    /// The notes panel beside the page.
    pub(crate) fn render_annotations(&mut self, tab: &Tab, cx: &mut Context<Self>) -> AnyElement {
        let id = tab.id;
        let theme = self.theme.clone();
        let armed = self.browser.annotations.armed(id);
        let notes = self.tab_notes(id);
        let regions = notes.regions;
        let pending = notes.pending.as_ref().map(|draft| {
            (
                draft.anchor.summary(),
                draft.image.clone(),
                draft.capture.is_some(),
            )
        });
        let list: Vec<(usize, Note)> = notes.notes.iter().cloned().enumerate().collect();
        let now = Instant::now();
        self.browser.annotations.observe_notes(id, list.len(), now);
        let origin = tab.origin.is_some();
        let tab_for_send = tab.clone();
        let tab_for_copy = tab.clone();
        let button = |id: &'static str, label: &'static str, primary: bool| {
            let background = if primary {
                theme.primary()
            } else {
                theme.active
            };
            div()
                .id(id)
                .debug_selector(move || id.into())
                .px_2()
                .py_1()
                .rounded(px(crate::config::corners::CONTROL))
                .cursor_pointer()
                .bg(rgb(background))
                .text_color(rgb(theme.text_on(background)))
                .child(label)
        };
        let thumbnail = |image: Arc<Image>| {
            img(image)
                .max_w_full()
                .max_h(px(96.))
                .rounded(px(crate::config::corners::CONTROL))
                .border_1()
                .border_color(rgb(theme.active))
        };
        let composer = pending.map(|(summary, image, capturing)| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .p_2()
                .border_b_1()
                .border_color(rgb(theme.active))
                .child(div().text_color(rgb(theme.muted)).truncate().child(summary))
                .children(image.map(thumbnail))
                .when(capturing, |draft| {
                    draft.child(
                        div()
                            .text_color(rgb(theme.muted))
                            .child("Taking a screenshot\u{2026}"),
                    )
                })
                .child(
                    div()
                        .id("annotation-input")
                        .debug_selector(|| "annotation-input".into())
                        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                            match event.keystroke.key.as_str() {
                                "enter" => this.add_note(id, window, cx),
                                "escape" => {
                                    this.tab_notes(id).pending = None;
                                    window.focus(&this.focus, cx);
                                    cx.notify();
                                }
                                _ => return,
                            }
                            cx.stop_propagation();
                        }))
                        .child(self.browser.annotations.input.clone()),
                )
                .child(div().flex().gap_1().child(
                    button("annotation-add", "Add note", true).on_click(
                        cx.listener(move |this, _, window, cx| this.add_note(id, window, cx)),
                    ),
                ))
        });
        let growth: Vec<Option<f32>> = (0..list.len())
            .map(|index| self.browser.annotations.note_growth(id, index, now))
            .collect();
        let rows = list.into_iter().map(|(index, note)| {
            div()
                .id(("annotation-note", index))
                // A new note opens into the list and fades in.
                .when_some(growth[index], |row, k| {
                    row.max_h(px(320. * k)).overflow_hidden().opacity(k)
                })
                .flex()
                .gap_2()
                .p_2()
                .border_b_1()
                .border_color(rgb(theme.active))
                .child(
                    div()
                        .flex_none()
                        .size(px(18.))
                        .rounded_full()
                        .bg(rgb(theme.palette[3]))
                        .text_color(rgb(theme.text_on(theme.palette[3])))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child((index + 1).to_string()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_color(rgb(theme.muted))
                                .truncate()
                                .child(note.anchor.summary()),
                        )
                        .child(div().child(note.comment))
                        .children(note.image.clone().map(thumbnail)),
                )
                .child(
                    div()
                        .id(("annotation-remove", index))
                        .flex_none()
                        .size(px(18.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .rounded(px(crate::config::corners::CONTROL))
                        .hover(|s| s.bg(rgb(theme.active)))
                        .child(
                            svg()
                                .path("icons/close.svg")
                                .size(px(12.))
                                .text_color(rgb(theme.muted)),
                        )
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.remove_note(id, index, cx)),
                        ),
                )
        });
        let has_notes = !self.tab_notes(id).notes.is_empty();
        let panel = div()
            .id("annotations")
            .debug_selector(|| "annotations".into())
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(theme.surface))
            .border_l_1()
            .border_color(rgb(theme.active))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .p_2()
                    .border_b_1()
                    .border_color(rgb(theme.active))
                    .child("Notes")
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .child(
                                // Drag draws a region while this is on;
                                // Shift-drag draws one either way.
                                button("annotation-region", "Region", regions).on_click(
                                    cx.listener(move |this, _, _, cx| this.toggle_regions(id, cx)),
                                ),
                            )
                            .child(button("annotation-page", "Note on page", false).on_click(
                                cx.listener(move |this, _, window, cx| {
                                    this.begin_note(id, Anchor::Page, None, window, cx);
                                }),
                            )),
                    ),
            )
            .children(composer)
            .child(
                div()
                    .id("annotation-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(rows)
                    .when(!has_notes && armed, |list| {
                        list.child(
                            div()
                                .p_2()
                                .text_color(rgb(theme.muted))
                                .child("Click an element, select text, or Shift-drag a region in the page, then describe the change."),
                        )
                    }),
            )
            .when(has_notes, |panel| {
                panel.child(
                    div()
                        .flex()
                        .gap_1()
                        .p_2()
                        .border_t_1()
                        .border_color(rgb(theme.active))
                        .when(origin, |row| {
                            row.child(button("annotation-send", "Send to agent", true).on_click(
                                cx.listener(move |this, _, _, cx| this.send_notes(&tab_for_send, cx)),
                            ))
                        })
                        .child(button("annotation-copy", "Copy", !origin).on_click(cx.listener(
                            move |this, _, _, cx| this.copy_notes(&tab_for_copy, cx),
                        ))),
                )
            });
        self.resizable_panel(
            panel,
            "annotations-resize",
            crate::panel_resize::PanelDrag::PageNotes,
            None,
            cx,
        )
        .into_any_element()
    }
}
