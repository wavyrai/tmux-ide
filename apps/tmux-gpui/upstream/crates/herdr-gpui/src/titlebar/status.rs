//! Daemon status text in the native header.

use crate::{
    LiveState,
    config::{FontConfig, Theme},
    fonts::StyledFont,
    notifications::safe_text,
    state::ConnectionStatus,
};
use gpui::{prelude::*, *};
use herdr_client::protocol::ClientShellSnapshot;
use std::ops::Range;

const MAX_SEGMENTS: usize = 32;
const MAX_TEXT_CHARS: usize = 128;
const MAX_SEPARATOR_CHARS: usize = 32;

#[derive(Default)]
struct StatusText {
    text: String,
    accents: Vec<Range<usize>>,
}

impl StatusText {
    fn snapshot(snapshot: &ClientShellSnapshot) -> Self {
        let mut result = Self::default();
        let separator = safe_text(&snapshot.tab_bar_right_separator, MAX_SEPARATOR_CHARS);
        for segment in snapshot.tab_bar_right.iter().take(MAX_SEGMENTS) {
            let text = safe_text(&segment.text, MAX_TEXT_CHARS);
            if text.trim().is_empty() {
                continue;
            }
            if !result.text.is_empty() {
                result.text.push_str(&separator);
            }
            let start = result.text.len();
            result.text.push_str(&text);
            if segment.accent {
                result.accents.push(start..result.text.len());
            }
        }
        if snapshot.tab_bar_right.len() > MAX_SEGMENTS {
            result.text.push('…');
        }
        result
    }

    fn live(live: &LiveState) -> Self {
        live.snapshot
            .as_deref()
            .filter(|_| live.status == ConnectionStatus::Connected)
            .map(Self::snapshot)
            .unwrap_or_default()
    }
}

pub(super) fn render(live: &LiveState, font: &FontConfig, theme: &Theme) -> Div {
    let status = StatusText::live(live);
    let accent = HighlightStyle {
        color: Some(rgb(theme.text_on(theme.primary())).into()),
        background_color: Some(rgb(theme.primary()).into()),
        font_weight: Some(FontWeight::BOLD),
        ..Default::default()
    };
    div()
        .debug_selector(|| "titlebar-status".into())
        .size_full()
        .flex()
        .items_center()
        .pr(px(8.))
        .overflow_hidden()
        .text_font(font)
        .text_size(px(font.size.min(20.)))
        .text_color(rgb(theme.muted))
        .child(
            div()
                .w_full()
                .min_w_0()
                .truncate()
                .text_align(TextAlign::Right)
                .child(
                    StyledText::new(status.text)
                        .with_highlights(status.accents.into_iter().map(|range| (range, accent))),
                ),
        )
}

#[cfg(test)]
mod tests;
