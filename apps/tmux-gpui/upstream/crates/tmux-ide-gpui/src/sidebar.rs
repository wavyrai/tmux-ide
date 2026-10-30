//! The one sidebar helper the tmux path uses: a single-line label.
use gpui::{IntoElement, SharedString};

#[cfg(test)]
pub(crate) mod layout_tests;

pub(crate) fn label_text(text: &str) -> impl IntoElement {
    shared_label_text(SharedString::from(text))
}

#[cfg(not(test))]
fn shared_label_text(text: SharedString) -> SharedString {
    text
}

#[cfg(test)]
fn shared_label_text(text: SharedString) -> layout_tests::ProbeText {
    layout_tests::ProbeText(text)
}
