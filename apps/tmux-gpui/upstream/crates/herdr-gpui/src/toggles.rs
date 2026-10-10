//! Native-style selection marks shared by dialogs, menus, and settings: a
//! checkbox for independent options, a radio mark for one choice of several,
//! and a switch for settings that apply immediately. Each is only the mark;
//! callers own the row, its label, and its click handler.

use crate::config::{Theme, corners};
use gpui::{Div, div, prelude::*, px, rgb, svg};

/// The fill of a set mark and the ink drawn on it: the theme's primary color
/// when set, `active` when clear, with whichever of background or foreground
/// reads better on it, moved as far as the contrast setting needs.
pub(crate) fn colors(theme: &Theme, checked: bool) -> (u32, u32) {
    let fill = if checked {
        theme.primary()
    } else {
        theme.active
    };
    let ink = if crate::contrast::ratio(theme.background, fill)
        >= crate::contrast::ratio(theme.foreground, fill)
    {
        theme.background
    } else {
        theme.foreground
    };
    let ink = crate::contrast::ink(ink, &[fill], theme.contrast.mark_ratio());
    (fill, ink)
}

/// An outlined box when clear; a primary-filled box with a check mark when set.
pub(crate) fn checkbox(theme: &Theme, size: f32, checked: bool) -> Div {
    let (fill, ink) = colors(theme, true);
    div()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(corners::SMALL))
        .border_1()
        .when(checked, |mark| {
            mark.bg(rgb(fill)).border_color(rgb(fill)).child(
                svg()
                    .path("icons/check.svg")
                    .size(px(size - 4.))
                    .text_color(rgb(ink)),
            )
        })
        .when(!checked, |mark| mark.border_color(rgb(theme.muted)))
}

/// An outlined circle when clear; a primary-filled circle with a center dot
/// when chosen.
pub(crate) fn radio(theme: &Theme, size: f32, selected: bool) -> Div {
    let (fill, ink) = colors(theme, true);
    div()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .border_1()
        .when(selected, |mark| {
            mark.bg(rgb(fill))
                .border_color(rgb(fill))
                .child(div().size(px(size * 0.4)).rounded_full().bg(rgb(ink)))
        })
        .when(!selected, |mark| mark.border_color(rgb(theme.muted)))
}

/// A pill track with a round thumb that sits right when on. `height` sets the
/// scale; the track is about 1.6 times as wide.
pub(crate) fn switch(theme: &Theme, height: f32, on: bool) -> Div {
    let (track, thumb) = colors(theme, on);
    let inset = (height / 8.).round();
    div()
        .w(px((height * 1.64).round()))
        .h(px(height))
        .flex_none()
        .rounded_full()
        .p(px(inset))
        .flex()
        .items_center()
        .bg(rgb(track))
        .when(on, |track| track.justify_end())
        .child(
            div()
                .size(px(height - 2. * inset))
                .rounded_full()
                .bg(rgb(thumb)),
        )
}

#[cfg(test)]
mod tests;
