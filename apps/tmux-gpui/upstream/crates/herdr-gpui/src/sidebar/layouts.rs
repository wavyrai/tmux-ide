//! The row layouts the config can pick. Each one is a unit struct assembled
//! from the shared pieces in `parts`, so adding a layout is a new file and a
//! `RowStyle` variant.

mod herdr;
mod minimal;
mod orca;
mod parts;
mod superset;

pub(super) use {herdr::Herdr, minimal::Minimal, orca::Orca, superset::Superset};

use super::{cell::Fold, label_text};
use crate::config::Theme;
use gpui::{prelude::*, *};

impl Fold {
    /// The fold chevron, sized by the caller. Clicking it never selects the
    /// row it sits on.
    pub(super) fn element(self, theme: &Theme) -> Stateful<Div> {
        let Self {
            id,
            index,
            collapsed,
            toggle,
        } = self;
        let (muted, foreground) = (theme.muted, theme.foreground);
        div()
            .id(id)
            .debug_selector(move || format!("collapse-{index}"))
            .flex_none()
            .text_color(rgb(muted))
            .hover(move |style| style.text_color(rgb(foreground)))
            .cursor_pointer()
            .child(label_text(if collapsed { "\u{25b8}" } else { "\u{25be}" }))
            .on_click(move |event, window, cx| {
                cx.stop_propagation();
                toggle(event, window, cx);
            })
    }
}
