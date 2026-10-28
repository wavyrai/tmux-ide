//! The palette paints prepared entries; input and daemon operations live elsewhere.

use super::{Filter, Palette};
use crate::HerdrWindow;
use gpui::{prelude::*, *};

impl HerdrWindow {
    fn palette_header(&self, palette: &Palette, cx: &mut Context<Self>) -> Div {
        let theme = &self.theme;
        div()
            .flex_none()
            .p(px(16.))
            .border_b_1()
            .border_color(rgb(theme.active))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(self.config.ui.size * 1.35))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Command Palette"),
                    )
                    .child(
                        div()
                            .id("palette-close")
                            .px_2()
                            .py_1()
                            .cursor_pointer()
                            .rounded(px(crate::config::corners::CONTROL))
                            .hover(|s| s.bg(rgb(theme.active)))
                            .child("Close")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.dismiss_menu(window, cx)),
                            ),
                    ),
            )
            .child(div().pt(px(12.)).child(palette.search.clone()))
            .child(div().flex().flex_wrap().gap(px(6.)).pt(px(10.)).children(
                Filter::ALL.into_iter().map(|filter| {
                    div()
                        .id(("palette-filter", filter as usize))
                        .debug_selector(move || {
                            format!("palette-filter-{}", filter.label().to_lowercase())
                        })
                        .px_2()
                        .py_1()
                        .rounded(px(crate::config::corners::CONTROL))
                        .cursor_pointer()
                        .when(filter == palette.filter, |tab| tab.bg(rgb(theme.active)))
                        .hover(|tab| tab.bg(rgb(theme.active)))
                        .child(filter.label())
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.set_palette_filter(filter, cx);
                            if let Some(palette) = &this.menu.palette {
                                let focus = palette.search.read(cx).focus.clone();
                                window.focus(&focus, cx);
                            }
                        }))
                }),
            ))
            .child(div().pt(px(8.)).text_color(rgb(theme.muted)).child(format!(
                "{} of {} results",
                palette.filtered.len(),
                palette.entries.len()
            )))
    }

    fn palette_row(
        &self,
        palette: &Palette,
        index: usize,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let hit = &palette.filtered[index];
        let entry = &palette.entries[hit.index];
        // Ranked results need not keep entry order, so only an empty query nests.
        let depth = if palette.query.trim().is_empty() {
            hit.depth
        } else {
            0
        };
        let action = entry.action.clone();
        // Matched characters were found while ranking; painting only styles them.
        let matched = HighlightStyle {
            color: Some(rgb(self.theme.primary()).into()),
            font_weight: Some(FontWeight::BOLD),
            ..Default::default()
        };
        let styled = |text: &SharedString, ranges: &[std::ops::Range<usize>]| {
            StyledText::new(text.clone())
                .with_highlights(ranges.iter().map(|range| (range.clone(), matched)))
        };
        div()
            .id(index)
            .debug_selector(move || format!("palette-row-{index}"))
            .w_full()
            .h(px(self.config.ui.line_height() * 2. + 20.))
            .px(px(16.))
            .flex()
            .items_center()
            .gap(px(12.))
            .cursor_pointer()
            .when(index == palette.selected, |row| {
                row.bg(rgb(self.theme.active))
            })
            .hover(|s| s.bg(rgb(self.theme.active)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .pl(px(16. * depth as f32))
                    .child(
                        div()
                            .truncate()
                            .child(styled(&entry.label, &hit.highlights.label)),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_color(rgb(self.theme.muted))
                            .child(styled(&entry.detail, &hit.highlights.detail)),
                    ),
            )
            .when(!entry.badge.is_empty(), |row| {
                row.child(
                    div()
                        .flex_none()
                        .text_color(rgb(self.theme.muted))
                        .child(entry.badge.clone()),
                )
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                this.activate_palette(action.clone(), window, cx)
            }))
    }

    pub(crate) fn render_palette(&self, cx: &mut Context<Self>) -> Div {
        let Some(palette) = &self.menu.palette else {
            return div();
        };
        let theme = &self.theme;
        div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(self.palette_header(palette, cx))
            .when(palette.loading_projects, |panel| {
                panel.child(
                    div()
                        .flex_none()
                        .px(px(16.))
                        .py(px(8.))
                        .text_color(rgb(theme.muted))
                        .child("Loading local projects..."),
                )
            })
            .when(!palette.projects.errors.is_empty(), |panel| {
                panel.child(
                    div()
                        .id("palette-project-errors")
                        .max_h(px(72.))
                        .overflow_y_scroll()
                        .flex_none()
                        .px(px(16.))
                        .py(px(8.))
                        .text_color(rgb(theme.muted))
                        .child(
                            palette
                                .projects
                                .errors
                                .iter()
                                .map(ToString::to_string)
                                .collect::<Vec<_>>()
                                .join("\n"),
                        ),
                )
            })
            .when_some(palette.error.clone(), |panel, error| {
                panel.child(
                    div()
                        .id("palette-error")
                        .max_h(px(90.))
                        .overflow_y_scroll()
                        .flex_none()
                        .p(px(12.))
                        .text_color(rgb(theme.foreground))
                        .bg(rgb(theme.active))
                        .child(error),
                )
            })
            .when(palette.filtered.is_empty(), |panel| {
                panel.child(
                    div()
                        .flex_1()
                        .p(px(16.))
                        .text_color(rgb(theme.muted))
                        .child("No matching results. Try a shorter search."),
                )
            })
            .when(!palette.filtered.is_empty(), |panel| {
                panel.child(
                    uniform_list(
                        "palette-results",
                        palette.filtered.len(),
                        cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                            let Some(palette) = &this.menu.palette else {
                                return Vec::new();
                            };
                            range
                                .map(|index| this.palette_row(palette, index, cx))
                                .collect()
                        }),
                    )
                    .track_scroll(&palette.scroll)
                    .flex_1()
                    .min_h_0(),
                )
            })
            .child(
                div()
                    .debug_selector(|| "palette-status".into())
                    .flex_none()
                    .px(px(16.))
                    .py(px(10.))
                    .border_t_1()
                    .border_color(rgb(theme.active))
                    .text_color(rgb(theme.muted))
                    .child(if palette.busy() {
                        "Opening local project... Esc to dismiss."
                    } else {
                        "↑ / ↓ navigate · Tab filter · Enter select · Esc cancel"
                    }),
            )
    }
}
