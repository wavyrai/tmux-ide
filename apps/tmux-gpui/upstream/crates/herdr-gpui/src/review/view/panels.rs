//! Whether a review shows its file list and its notes beside the diff. A
//! review narrower than `NARROW` gives the diff all its room until the user
//! says otherwise with the header's icons; a note being written always shows
//! the notes, so the composer is never hidden.
use super::Review;
use crate::{HerdrWindow, browser::TabId};
use gpui::{prelude::*, *};
use std::{cell::Cell, rc::Rc};

/// Below this width, in pixels, a review starts with both panels hidden.
pub(super) const NARROW: f32 = 1000.;

/// A side panel of a review.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Panel {
    Files,
    Notes,
}

impl Review {
    /// Whether the review was wide enough at its last layout; unknown
    /// counts as wide.
    fn wide(&self) -> bool {
        let width = self.width.get();
        width <= 0. || width >= NARROW
    }

    pub(super) fn shows(&self, panel: Panel) -> bool {
        match panel {
            Panel::Files => self.files_shown.unwrap_or_else(|| self.wide()),
            Panel::Notes => self.draft.is_some() || self.notes_shown.unwrap_or_else(|| self.wide()),
        }
    }
}

/// Records a review's width as it lays out, and draws again when that
/// moves it across `NARROW`, so the panels follow on the next frame.
pub(super) fn measure(width: Rc<Cell<f32>>) -> impl IntoElement {
    canvas(
        move |bounds, window, _| {
            let now = f32::from(bounds.size.width);
            let before = width.replace(now);
            if (before >= NARROW) != (now >= NARROW) {
                window.refresh();
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
}

impl HerdrWindow {
    /// Shows or hides one of a review's side panels; the choice then holds
    /// whatever the review's width.
    pub(super) fn toggle_review_panel(&mut self, id: TabId, panel: Panel, cx: &mut Context<Self>) {
        if let Some(review) = self.reviews.get_mut(&id) {
            let shown = !review.shows(panel);
            match panel {
                Panel::Files => review.files_shown = Some(shown),
                Panel::Notes => {
                    // Hiding the notes drops a note being written.
                    if !shown {
                        review.draft = None;
                    }
                    review.notes_shown = Some(shown);
                }
            }
        }
        cx.notify();
    }

    /// The icon that shows or hides `panel`; the notes one counts the
    /// queued notes, so hidden ones are not forgotten.
    pub(super) fn render_review_panel_toggle(
        &self,
        id: TabId,
        review: &Review,
        panel: Panel,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = &self.theme;
        let shown = review.shows(panel);
        let (name, icon, hint) = match panel {
            Panel::Files => (
                "review-toggle-files",
                "icons/panel-left.svg",
                "Changed files",
            ),
            Panel::Notes => ("review-toggle-notes", "icons/panel-right.svg", "Notes"),
        };
        let count = match panel {
            Panel::Notes if !review.notes.is_empty() => Some(review.notes.len()),
            _ => None,
        };
        let (foreground, surface) = (theme.foreground, theme.surface);
        div()
            .id(name)
            .debug_selector(move || name.into())
            .flex_none()
            .h(px(22.))
            .px_1()
            .flex()
            .items_center()
            .gap_1()
            .rounded(px(crate::config::corners::CONTROL))
            .cursor_pointer()
            .when(shown, |button| button.bg(rgb(theme.active)))
            .hover(|button| button.bg(rgb(theme.active)))
            .child(svg().path(icon).size(px(14.)).text_color(rgb(if shown {
                theme.foreground
            } else {
                theme.muted
            })))
            .when_some(count, |button, count| {
                button.child(
                    div()
                        .px_1()
                        .rounded_full()
                        .bg(rgb(theme.palette[3]))
                        .text_color(rgb(theme.text_on(theme.palette[3])))
                        .text_size(px(10.))
                        .child(count.to_string()),
                )
            })
            .tooltip(move |_, cx| {
                cx.new(|_| crate::usage::Hint {
                    text: hint.into(),
                    foreground,
                    surface,
                })
                .into()
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                this.toggle_review_panel(id, panel, cx);
            }))
    }
}
