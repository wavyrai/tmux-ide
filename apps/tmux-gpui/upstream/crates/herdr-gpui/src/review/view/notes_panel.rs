//! The notes beside the diff: the composer for the line being noted, the
//! queued notes, and Send or Copy.
use super::{PANEL_SHARE, Review};
use crate::{HerdrWindow, browser::TabId, review::notes::Note};
use gpui::{prelude::*, *};

impl HerdrWindow {
    pub(super) fn render_review_notes(
        &self,
        id: TabId,
        review: &Review,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = &self.theme;
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
        let drafting = review
            .draft
            .zip(review.loaded())
            .and_then(|(row, loaded)| loaded.diff.anchor(row))
            .and_then(|anchor| Note::new(anchor, "x"))
            .map(|note| note.place());
        let composer = drafting.map(|place| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .p_2()
                .border_b_1()
                .border_color(rgb(theme.active))
                .child(div().text_color(rgb(theme.muted)).truncate().child(place))
                .child(
                    div()
                        .id("review-input")
                        .debug_selector(|| "review-input".into())
                        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                            let composing = this
                                .reviews
                                .get(&id)
                                .is_some_and(|review| review.input.read(cx).is_composing());
                            if composing {
                                return;
                            }
                            match event.keystroke.key.as_str() {
                                "enter" => this.add_review_note(id, window, cx),
                                "escape" => this.cancel_review_note(id, window, cx),
                                _ => return,
                            }
                            cx.stop_propagation();
                        }))
                        .child(review.input.clone()),
                )
                .child(
                    div()
                        .flex()
                        .child(button("review-add", "Add note", true).on_click(cx.listener(
                            move |this, _, window, cx| this.add_review_note(id, window, cx),
                        ))),
                )
        });
        let rows = review.notes.iter().enumerate().map(|(index, note)| {
            div()
                .id(("review-note", index))
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
                                .child(note.place()),
                        )
                        .child(div().child(note.comment.clone())),
                )
                .child(
                    div()
                        .id(("review-remove", index))
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
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.remove_review_note(id, index, cx)
                        })),
                )
        });
        let has_notes = !review.notes.is_empty();
        let has_agent = review.agent.is_some();
        let panel =
            div()
                .id("review-notes")
                .debug_selector(|| "review-notes".into())
                .flex_none()
                .h_full()
                .flex()
                .flex_col()
                .border_l_1()
                .border_color(rgb(theme.active))
                .children(composer)
                .child(
                    div()
                        .id("review-note-list")
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .children(rows)
                        .when(!has_notes && review.draft.is_none(), |list| {
                            list.child(
                                div().p_2().text_color(rgb(theme.muted)).child(
                                    "Click a line or a file name to note what should change.",
                                ),
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
                            .when(has_agent, |row| {
                                row.child(button("review-send", "Send to agent", true).on_click(
                                    cx.listener(move |this, _, _, cx| this.send_review(id, cx)),
                                ))
                            })
                            .child(button("review-copy", "Copy", !has_agent).on_click(
                                cx.listener(move |this, _, _, cx| this.copy_review(id, cx)),
                            )),
                    )
                });
        self.resizable_panel(
            panel,
            "review-notes-resize",
            crate::panel_resize::PanelDrag::ReviewNotes,
            Some(PANEL_SHARE),
            cx,
        )
    }
}
