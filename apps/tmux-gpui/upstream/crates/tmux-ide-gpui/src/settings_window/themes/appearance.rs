//! Theme preview and appearance section rendering.
use super::{Choice, FOLLOW, LIST_HEIGHT, ROW_HEIGHT, Scope, SettingsWindow, grid};
use crate::{
    config::{Config, Theme, ThemeName, corners},
    contrast::Contrast,
    fonts::StyledFont,
    herdr_settings,
};
use gpui::{
    Context, Div, ScrollStrategy, Window, div, prelude::*, px, relative, rgb, uniform_list,
};

impl SettingsWindow {
    fn theme_preview(&self) -> Div {
        let theme = self.themes.preview.as_ref().unwrap_or(&self.theme);
        div()
            .debug_selector(|| "settings-theme-preview".into())
            .w_full()
            .h(px(225.))
            .flex_none()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(corners::PANEL))
            .border_1()
            .border_color(rgb(self.theme.active))
            .bg(rgb(theme.background))
            .text_color(rgb(theme.foreground))
            .child(
                div()
                    .h(px(29.))
                    .flex_none()
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .bg(rgb(theme.surface))
                    .children([1, 3, 2].map(|i| {
                        div()
                            .size(px(6.))
                            .rounded_full()
                            .bg(rgb(theme.ink(theme.palette[i])))
                    }))
                    .child(
                        div()
                            .flex_1()
                            .text_center()
                            .text_size(px(10.))
                            .child("herdr-gpui / preview"),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .debug_selector(|| "settings-theme-preview-sidebar".into())
                            .w(relative(0.28))
                            .min_w(px(90.))
                            .flex_none()
                            .p(px(10.))
                            .bg(rgb(theme.sidebar_background()))
                            .overflow_hidden()
                            .text_size(px(11.))
                            .child(div().text_color(rgb(theme.subtext())).child("SPACES"))
                            .child(
                                div()
                                    .mt(px(10.))
                                    .p(px(6.))
                                    .rounded(px(corners::SMALL))
                                    .bg(rgb(theme.active))
                                    .truncate()
                                    .child("herdr-gpui"),
                            )
                            .child(div().mt(px(8.)).p(px(6.)).truncate().child("website"))
                            .child(
                                div()
                                    .mt(px(14.))
                                    .text_color(rgb(theme.subtext()))
                                    .child("AGENTS"),
                            )
                            .child(
                                div()
                                    .mt(px(8.))
                                    .text_color(rgb(theme.ink(theme.palette[3])))
                                    .child("Claude / working"),
                            ),
                    )
                    .child(
                        div()
                            .debug_selector(|| "settings-theme-preview-terminal".into())
                            .flex_1()
                            .min_w_0()
                            .p(px(14.))
                            .overflow_hidden()
                            .text_font(&self.config.terminal)
                            .text_size(px(self.config.terminal.size))
                            .line_height(px(self.config.terminal.line_height()))
                            .child(
                                div()
                                    .text_color(rgb(theme.ink(theme.palette[2])))
                                    .child("~/code/herdr-gpui"),
                            )
                            .child(div().child("$ cargo test --workspace"))
                            .child(
                                div()
                                    .mt(px(12.))
                                    .text_color(rgb(theme.subtext()))
                                    .child("Running tests..."),
                            )
                            .child(
                                div()
                                    .text_color(rgb(theme.ink(theme.palette[2])))
                                    .child("test result: ok."),
                            )
                            .child(
                                div()
                                    .mt(px(12.))
                                    .flex()
                                    .items_center()
                                    .gap(px(7.))
                                    .child("$")
                                    .child(div().w(px(7.)).h(px(14.)).bg(rgb(theme.cursor))),
                            ),
                    ),
            )
    }

    /// The switch for a theme that follows the system, and, while it does,
    /// which side the grid below edits.
    fn render_system_theme_controls(
        &self,
        button: &impl Fn(&'static str, String, bool) -> gpui::Stateful<Div>,
        cx: &mut Context<Self>,
    ) -> Div {
        let value = self.drafted_theme();
        let following = ThemeName::follows_system(value);
        div()
            .debug_selector(|| "settings-theme-system".into())
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .child(
                self.control_switch("theme-system", "Match system appearance", following, true)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_system_theme(cx))),
            )
            .when(following, |row| {
                row.children(
                    [
                        ("theme-system-light", "Light", true),
                        ("theme-system-dark", "Dark", false),
                    ]
                    .map(|(id, label, light)| {
                        button(
                            id,
                            format!("{label}: {}", ThemeName::side(value, light)),
                            self.themes.editing_light == light,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                let focus = this.themes.search.read(cx).focus.clone();
                                window.focus(&focus, cx);
                                this.edit_theme_side(light, cx);
                            },
                        ))
                    }),
                )
            })
    }

    pub(in crate::settings_window) fn render_appearance(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Div {
        #[cfg(all(feature = "integration-test", target_os = "macos"))]
        grid::clear_native_bounds(cx);
        let columns = grid::columns(f32::from(window.viewport_size().width) - 240.);
        if self.themes.grid.columns != columns {
            self.themes.grid.columns = columns;
            self.themes.scroll.scroll_to_item(
                self.themes.selected.unwrap_or(0) / columns,
                ScrollStrategy::Center,
            );
        }
        let browser = &self.themes;
        let theme = &self.theme;
        let count = usize::from(browser.ghostty_enabled) * browser.names.len()
            + usize::from(browser.herdr_enabled) * herdr_settings::THEME_NAMES.len();
        let button = |id: &'static str, label: String, selected: bool| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .px(px(10.))
                .py(px(6.))
                .rounded(px(corners::CONTROL))
                .border_1()
                .border_color(rgb(if selected {
                    theme.primary()
                } else {
                    theme.active
                }))
                .bg(rgb(if selected {
                    theme.primary_wash()
                } else {
                    theme.surface
                }))
                .cursor_pointer()
                .child(label)
        };
        div()
            .debug_selector(|| "settings-appearance".into())
            .w_full()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(self.theme_preview())
            .child(
                div()
                    .debug_selector(|| "settings-theme-preview-status".into())
                    .text_size(px(11.))
                    .text_color(rgb(theme.subtext()))
                    .child(format!(
                        "Preview: {}{}",
                        browser
                            .preview_name
                            .as_deref()
                            .unwrap_or("Current appearance"),
                        if browser.running.is_some() {
                            " / loading selection..."
                        } else {
                            " / sample content"
                        }
                    )),
            )
            .child(
                div().flex().flex_wrap().gap(px(8.)).children(
                    [
                        (Scope::App, "Ghostty", "theme-scope-app"),
                        (Scope::Herdr, "Herdr", "theme-scope-herdr"),
                    ]
                    .map(|(scope, label, id)| {
                        button(id, label.into(), browser.source_enabled(scope)).on_click(cx.listener(
                            move |this, _, window, cx| {
                                let focus = this.themes.search.read(cx).focus.clone();
                                window.focus(&focus, cx);
                                this.toggle_theme_source(scope, cx);
                            },
                        ))
                    }),
                ),
            )
            .child(
                div()
                    .debug_selector(|| "settings-theme-scope-description".into())
                    .text_size(px(11.))
                    .text_color(rgb(theme.subtext()))
                    .child(if Scope::Herdr.editable() {
                        "Ghostty includes native built-ins and files; applies only to this app. Herdr themes are shared."
                    } else {
                        "Ghostty includes native built-ins and files. Shared Herdr themes are read-only on this platform."
                    }),
            )
            .child(self.render_system_theme_controls(&button, cx))
            .child(
                div()
                    .debug_selector(|| "settings-theme-search".into())
                    .h(px(32.))
                    .flex_none()
                    .on_key_down(cx.listener(Self::theme_browser_key))
                    .child(browser.search.clone()),
            )
            .child(
                div()
                    .debug_selector(|| "settings-theme-count".into())
                    .text_size(px(11.))
                    .text_color(rgb(theme.subtext()))
                    .child(format!(
                        "{} of {} themes{}",
                        browser.filtered.len(),
                        count,
                        if browser.discovering {
                            " / discovering installed themes..."
                        } else {
                            ""
                        }
                    )),
            )
            .child(
                div()
                    .debug_selector(|| "settings-theme-list".into())
                    // The child list scrolls first; keep wheel events inside the
                    // grid even at its edges or when the results are empty.
                    .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                    .h(px(LIST_HEIGHT))
                    .flex_none()
                    .overflow_hidden()
                    .border_1()
                    .border_color(rgb(theme.active))
                    .rounded(px(corners::CONTROL))
                    .when(browser.filtered.is_empty(), |el| {
                        el.child(
                            div()
                                .debug_selector(|| "settings-theme-empty".into())
                                .p(px(12.))
                                .child(if !browser.ghostty_enabled && !browser.herdr_enabled {
                                    "Select a theme library"
                                } else {
                                    "No matching themes. Try a shorter search."
                                }),
                        )
                    })
                    .when(!browser.filtered.is_empty(), |el| {
                        el.child(
                            uniform_list(
                                "settings-theme-results",
                                browser.filtered.len().div_ceil(columns),
                                cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                                    this.schedule_grid_palettes(range.clone(), cx);
                                    range
                                        .map(|row| div().h(px(ROW_HEIGHT)).w_full().flex().gap(px(6.)).children((0..this.themes.grid.columns).map(|column| {
                                            let index = row * this.themes.grid.columns + column;
                                            if index >= this.themes.filtered.len() {
                                                return div().flex_1().min_w_0().into_any_element();
                                            }
                                             let choice = this.themes.filtered[index].clone();
                                             let name = &choice.name;
                                            let draft =
                                                this.theme_intent.as_ref().is_some_and(|intent| {
                                                    intent.choice.scope == choice.scope
                                                        && match choice.scope {
                                                            Scope::App => {
                                                                ThemeName::side(&intent.choice.name, this.themes.editing_light) == name
                                                            }
                                                            Scope::Herdr => intent.choice.name == *name,
                                                        }
                                                });
                                             let saved = match choice.scope {
                                                 Scope::App => name == this.edited_theme(),
                                                Scope::Herdr => {
                                                    this.shared.as_ref().is_some_and(|shared| {
                                                         shared.theme_name == *name
                                                    })
                                                }
                                            };
                                             let source = match choice.scope {
                                                Scope::Herdr => "Herdr",
                                                Scope::App
                                                    if Theme::BUILTIN_NAMES
                                                        .contains(&name.as_str()) =>
                                                {
                                                    "Built-in"
                                                }
                                                Scope::App
                                                     if std::path::Path::new(name)
                                                        .is_absolute()
                                                        || name.starts_with("~/") =>
                                                {
                                                    "File"
                                                }
                                                Scope::App => "Ghostty",
                                            };
                                            div()
                                                .id(index)
                                                .relative()
                                                .map(|card| {
                                                    #[cfg(all(feature = "integration-test", target_os = "macos"))]
                                                    let card = card.child(grid::native_probe(index));
                                                    card
                                                })
                                                .debug_selector(move || {
                                                    format!("settings-theme-row-{index}")
                                                })
                                                .h(px(76.))
                                                .flex_1()
                                                .min_w_0()
                                                .overflow_hidden()
                                                .px(px(7.))
                                                .py(px(4.))
                                                .flex()
                                                .flex_col()
                                                .rounded(px(corners::CONTROL))
                                                .border_2()
                                                .border_color(rgb(if this.themes.selected == Some(index) { this.theme.primary() } else { this.theme.active }))
                                                 .when(choice.scope.editable(), |el| el.cursor_pointer())
                                                .hover(|el| el.bg(rgb(this.theme.active)))
                                                 .child(this.grid_thumbnail(&choice, index))
                                                .child(
                                                    div()
                                                        .debug_selector(move || {
                                                            format!("settings-theme-name-{index}")
                                                        })
                                                        .min_w_0()
                                                        .truncate()
                                                         .child(name.clone()),
                                                )
                                                .child(
                                                    div()
                                                        .debug_selector(move || {
                                                            format!("settings-theme-source-{index}")
                                                        })
                                                        .text_size(px(10.))
                                                        .text_color(rgb(this.theme.subtext()))
                                                        .truncate()
                                                        .child(format!("{source}{}", if draft { " / Draft" } else if saved { " / Saved" } else { "" })),
                                                )
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        let focus = this
                                                            .themes
                                                            .search
                                                            .read(cx)
                                                            .focus
                                                            .clone();
                                                        window.focus(&focus, cx);
                                                        this.select_settings_theme(index, cx);
                                                    },
                                                )).into_any_element()
                                        })))
                                        .collect()
                                }),
                            )
                            .track_scroll(&browser.scroll)
                            .h_full()
                            .w_full(),
                        )
                    }),
            )
            .when_some(browser.catalog_error.as_ref(), |el, error| {
                el.child(
                    div()
                        .debug_selector(|| "settings-theme-catalog-error".into())
                        .child(format!(
                            "Catalog discovery failed: {error}. Built-ins remain available."
                        ))
                        .child(
                            button("theme-retry-catalog", "Retry discovery".into(), false)
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.discover_settings_themes(cx)),
                                ),
                        ),
                )
            })
            .when_some(browser.preview_error.as_ref(), |el, error| {
                el.child(
                    div()
                        .debug_selector(|| "settings-theme-preview-error".into())
                        .child(format!(
                            "Preview unavailable: {error}. Keeping the last valid preview."
                        ))
                        .child(
                            button("theme-retry-preview", "Retry preview".into(), false).on_click(
                                cx.listener(|this, _, _, cx| this.request_theme_preview(cx)),
                            ),
                        ),
                )
            })
            .child(
                div()
                    .debug_selector(|| "settings-theme-actions".into())
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        button(
                            "theme-follow",
                            if self.config.theme == FOLLOW {
                                "Following Herdr"
                            } else {
                                "Follow Herdr"
                            }
                            .into(),
                            self.config.theme == FOLLOW,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.accept_theme_choice(
                                Choice {
                                    scope: Scope::App,
                                    name: FOLLOW.into(),
                                },
                                cx,
                            );
                        })),
                    )
                    .child(
                        self.control_switch(
                            "theme-contrast",
                            "High contrast",
                            self.config.contrast == Contrast::High,
                            true,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            let contrast = if this.config.contrast == Contrast::High {
                                Contrast::Standard
                            } else {
                                Contrast::High
                            };
                            this.save_native(move || Config::save_contrast(contrast), cx);
                        })),
                    ),
            )
            .child(self.render_sidebar_layout_controls(cx))
    }
}
