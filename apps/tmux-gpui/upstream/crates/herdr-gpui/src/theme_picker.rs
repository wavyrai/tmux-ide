use crate::{
    HerdrWindow,
    config::{Theme, ThemeName},
    menu::Page,
    search_input::SearchInput,
};
use gpui::{prelude::*, *};

pub(super) struct ThemePicker {
    pub search: Entity<SearchInput>,
    names: Vec<String>,
    pub(super) filtered: Vec<String>,
    selected: usize,
    scroll: UniformListScrollHandle,
    error: Option<String>,
    query: String,
    discovering: bool,
    baseline: Option<Theme>,
    session: u64,
    request: u64,
    desired: Option<String>,
    loaded: Option<String>,
    accepting: bool,
    saving: bool,
    // Keep the slot across dismiss/reopen: blocking I/O cannot be cancelled by
    // dropping a GPUI task. Only its completion may release the slot.
    in_flight: Option<(u64, u64)>,
    window: AnyWindowHandle,
    _subscription: Subscription,
}

impl ThemePicker {
    fn filter(&mut self, query: &str) {
        self.query = query.to_owned();
        let query = query.trim().to_lowercase();
        self.filtered = self
            .names
            .iter()
            .filter(|name| name.to_lowercase().contains(&query))
            .cloned()
            .collect();
        self.selected = 0;
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
    }
}

impl HerdrWindow {
    pub(super) fn open_theme_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.native_settings_save_in_flight() || crate::settings_window::theme_pending(cx) {
            return;
        }
        if !self.open_menu(window, cx) {
            return;
        }
        // A pending reload must not replace this newer interactive appearance.
        self.config_load = None;
        self.flush_font_sizes(cx);
        self.menu.page = Some(Page::Themes);
        let mut picker = if let Some(picker) = self.menu.themes.take() {
            picker.search.update(cx, |input, cx| input.clear(cx));
            picker
        } else {
            let search = cx.new(SearchInput::new);
            let subscription = cx.subscribe(
                &search,
                |this, search, _: &crate::search_input::Changed, cx| {
                    if let Some(picker) = &mut this.menu.themes {
                        if picker.accepting || picker.query == search.read(cx).text() {
                            return;
                        }
                        picker.filter(search.read(cx).text());
                    }
                    this.preview_picker_selection(cx);
                },
            );
            ThemePicker {
                search,
                names: Vec::new(),
                filtered: Vec::new(),
                selected: 0,
                scroll: UniformListScrollHandle::new(),
                error: None,
                query: String::new(),
                discovering: false,
                baseline: None,
                session: 0,
                request: 0,
                desired: None,
                loaded: None,
                accepting: false,
                saving: false,
                in_flight: None,
                window: window.window_handle(),
                _subscription: subscription,
            }
        };
        picker.session += 1;
        picker.baseline = Some(self.theme.clone());
        picker.desired = None;
        picker.loaded = None;
        picker.accepting = false;
        picker.error = None;
        picker.names = Theme::BUILTIN_NAMES
            .iter()
            .map(|name| (*name).into())
            .collect();
        // A theme that follows the system is picked one side at a time: the
        // side the current appearance shows.
        let current = ThemeName::side(&self.config.theme, crate::app::light_appearance(cx));
        if !picker.names.iter().any(|name| name == current) {
            picker.names.push(current.to_owned());
        }
        picker.names.sort();
        picker.filter("");
        picker.selected = picker
            .filtered
            .iter()
            .position(|name| name == current)
            .unwrap_or(0);
        picker.search.update(cx, |input, cx| {
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
            window.focus(&input.focus, cx);
        });
        self.menu.themes = Some(picker);
        self.discover_picker_themes(cx);
        cx.notify();
    }

    fn discover_picker_themes(&mut self, cx: &mut Context<Self>) {
        let Some(picker) = &mut self.menu.themes else {
            return;
        };
        if picker.discovering {
            return;
        }
        picker.discovering = true;
        let session = picker.session;
        let config = self.config.clone();
        let discovery = cx
            .background_executor()
            .spawn(async move { config.available_themes() });
        cx.spawn(async move |this, cx| {
            let result = discovery.await;
            let _ = this.update(cx, |this, cx| {
                this.finish_picker_discovery(session, result, cx);
            });
        })
        .detach();
    }

    fn finish_picker_discovery(
        &mut self,
        session: u64,
        result: crate::Result<Vec<String>>,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = &mut self.menu.themes else {
            return;
        };
        picker.discovering = false;
        if picker.baseline.is_none() {
            return;
        }
        match result {
            Ok(mut names) => {
                // Theme directories are process-wide, not picker-session state.
                // Reuse a running scan on reopen, adding the current explicit selection.
                let current = ThemeName::side(&self.config.theme, crate::app::light_appearance(cx));
                if !names.iter().any(|name| name == current) {
                    names.push(current.to_owned());
                    names.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
                }
                let selected = picker.filtered.get(picker.selected).cloned();
                picker.names = names;
                picker.filter(picker.search.read(cx).text());
                if let Some(index) = picker
                    .filtered
                    .iter()
                    .position(|name| Some(name) == selected.as_ref())
                {
                    picker.selected = index;
                }
            }
            Err(error) if picker.session == session => picker.error = Some(error.to_string()),
            Err(_) => {}
        }
        if !picker.query.is_empty() && picker.desired.is_none() {
            self.preview_picker_selection(cx);
        }
        cx.notify();
    }

    pub(super) fn theme_save_in_flight(&self) -> bool {
        self.menu
            .themes
            .as_ref()
            .is_some_and(|picker| picker.saving)
    }

    pub(super) fn cancel_theme_preview(&mut self, cx: &mut Context<Self>) -> bool {
        // Starting the disk write is the commit boundary. Its result must be
        // reconciled before another modal, cancellation, or reload can proceed.
        if self.theme_save_in_flight() {
            return false;
        }
        if let Some(picker) = &mut self.menu.themes {
            if let Some(theme) = picker.baseline.take() {
                self.theme = theme;
                crate::log_window::set_appearance(&self.config, &self.theme, cx);
            }
            picker.session += 1;
            picker.desired = None;
            picker.accepting = false;
        }
        true
    }

    fn preview_picker_selection(&mut self, cx: &mut Context<Self>) {
        if self.menu.page != Some(Page::Themes) {
            return;
        }
        let Some(picker) = &mut self.menu.themes else {
            return;
        };
        if picker.accepting {
            return;
        }
        let desired = picker.filtered.get(picker.selected).cloned();
        if picker.desired != desired {
            picker.request += 1;
            picker.desired = desired;
            picker.loaded = None;
            picker.error = None;
            if let Some(theme) = picker
                .desired
                .as_deref()
                .and_then(|name| Theme::builtin(name.trim()))
                .map(|theme| theme.with_contrast(self.config.contrast))
            {
                self.theme = theme;
                picker.loaded = picker.desired.clone();
            } else if picker.desired.is_none()
                && let Some(theme) = &picker.baseline
            {
                self.theme = theme.clone();
            }
        }
        picker.search.update(cx, |input, cx| {
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx)
        });
        crate::log_window::set_appearance(&self.config, &self.theme, cx);
        self.drive_picker_load(cx);
        cx.notify();
    }

    fn apply_picker_theme(&mut self, name: &str, cx: &mut Context<Self>) {
        let Some(picker) = &mut self.menu.themes else {
            return;
        };
        if picker.accepting {
            return;
        }
        if let Some(index) = picker
            .filtered
            .iter()
            .position(|candidate| candidate == name)
        {
            picker.selected = index;
        } else {
            return;
        }
        self.preview_picker_selection(cx);
        if let Some(picker) = &mut self.menu.themes {
            picker.accepting = true;
        }
        self.drive_picker_load(cx);
    }

    fn drive_picker_load(&mut self, cx: &mut Context<Self>) {
        let Some(picker) = &mut self.menu.themes else {
            return;
        };
        if picker.baseline.is_none() || picker.in_flight.is_some() {
            return;
        }
        let Some(name) = picker.desired.clone() else {
            return;
        };
        if picker.loaded.as_ref() == Some(&name) && !picker.accepting {
            return;
        }
        let token = (picker.session, picker.request);
        let saving = picker.accepting && picker.loaded.as_ref() == Some(&name);
        picker.saving = saving;
        picker.in_flight = Some(token);
        let window = picker.window;
        let light = crate::app::light_appearance(cx);
        let mut config = self.config.clone();
        config.theme = ThemeName::with_side(&self.config.theme, light, &name);
        let theme = self.theme.clone();
        let task = cx.background_executor().spawn(async move {
            if saving {
                config.save_theme(&config.theme).map(|()| theme)
            } else {
                config.theme(light)
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = window.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    this.finish_picker_load(token, saving, result, window, cx)
                });
            });
        })
        .detach();
    }

    fn finish_picker_load(
        &mut self,
        token: (u64, u64),
        saving: bool,
        result: crate::Result<Theme>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = &mut self.menu.themes else {
            return;
        };
        if picker.in_flight != Some(token) {
            return;
        }
        picker.in_flight = None;
        picker.saving = false;
        if picker.baseline.is_none() || token != (picker.session, picker.request) {
            self.drive_picker_load(cx);
            return;
        }
        match result {
            Ok(theme) => {
                self.theme = theme;
                picker.loaded = picker.desired.clone();
                picker.search.update(cx, |input, cx| {
                    input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx)
                });
                if saving {
                    if let Some(name) = &picker.desired {
                        self.config.theme = ThemeName::with_side(
                            &self.config.theme,
                            crate::app::light_appearance(cx),
                            name,
                        );
                    }
                    crate::log_window::set_appearance(&self.config, &self.theme, cx);
                    picker.baseline = None;
                    self.dismiss_menu(window, cx);
                } else {
                    crate::log_window::set_appearance(&self.config, &self.theme, cx);
                    self.drive_picker_load(cx);
                }
            }
            Err(error) => {
                picker.error = Some(error.to_string());
                picker.accepting = false;
            }
        }
        cx.notify();
    }

    pub(super) fn theme_picker_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = &mut self.menu.themes else {
            return;
        };
        // Unhandled text must reach the native input system, including IME commands.
        if picker.search.read(cx).is_composing() {
            return;
        }
        match event.keystroke.key.as_str() {
            "escape" => {
                cx.stop_propagation();
                window.prevent_default();
                self.dismiss_menu(window, cx);
            }
            "up" | "down" if !picker.filtered.is_empty() => {
                cx.stop_propagation();
                window.prevent_default();
                if picker.accepting {
                    return;
                }
                let count = picker.filtered.len();
                picker.selected = (picker.selected
                    + if event.keystroke.key == "up" {
                        count - 1
                    } else {
                        1
                    })
                    % count;
                picker
                    .scroll
                    .scroll_to_item(picker.selected, ScrollStrategy::Center);
                self.preview_picker_selection(cx);
            }
            "enter" => {
                cx.stop_propagation();
                window.prevent_default();
                if let Some(name) = picker.filtered.get(picker.selected).cloned() {
                    self.apply_picker_theme(&name, cx);
                }
            }
            _ => {}
        }
    }

    pub(super) fn render_theme_picker(&self, cx: &mut Context<Self>) -> Div {
        let Some(picker) = &self.menu.themes else {
            return div();
        };
        let theme = &self.theme;
        let font = &self.config.ui;
        div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(
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
                                    .text_size(px(font.size * 1.35))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Color Scheme"),
                            )
                            .child(
                                div()
                                    .id("theme-close")
                                    .debug_selector(|| "theme-close".into())
                                    .px_2()
                                    .py_1()
                                    .cursor_pointer()
                                    .rounded(px(crate::config::corners::CONTROL))
                                    .hover(|s| s.bg(rgb(theme.active)))
                                    .child("Close")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.dismiss_menu(window, cx)
                                    })),
                            ),
                    )
                    .child(div().pt(px(12.)).child(picker.search.clone()))
                    .child(div().pt(px(8.)).text_color(rgb(theme.muted)).child(format!(
                        "{} of {} themes",
                        picker.filtered.len(),
                        picker.names.len()
                    ))),
            )
            .when(picker.filtered.is_empty(), |panel| {
                panel.child(
                    div()
                        .debug_selector(|| "theme-empty".into())
                        .flex_1()
                        .p(px(16.))
                        .text_color(rgb(theme.muted))
                        .child("No matching themes. Try a shorter search."),
                )
            })
            .when(!picker.filtered.is_empty(), |panel| {
                panel.child(
                    uniform_list(
                        "theme-results",
                        picker.filtered.len(),
                        cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                            let Some(picker) = &this.menu.themes else {
                                return Vec::new();
                            };
                            range
                                .map(|index| {
                                    let name = picker.filtered[index].clone();
                                    let selected = index == picker.selected;
                                    let current = name
                                        == ThemeName::side(
                                            &this.config.theme,
                                            crate::app::light_appearance(cx),
                                        );
                                    div()
                                        .id(index)
                                        .debug_selector(move || format!("theme-row-{index}"))
                                        // As in the palette, the fill is the row.
                                        .w_full()
                                        .h(px(this.config.ui.line_height() + 20.))
                                        .px(px(16.))
                                        .flex()
                                        .items_center()
                                        .gap(px(8.))
                                        .cursor_pointer()
                                        .when(selected, |row| row.bg(rgb(this.theme.active)))
                                        .hover(|s| s.bg(rgb(this.theme.active)))
                                        .child(
                                            div()
                                                .debug_selector(|| format!("theme-name-{name}"))
                                                .flex_1()
                                                .min_w_0()
                                                .truncate()
                                                .child(name.clone()),
                                        )
                                        .when(current, |row| {
                                            row.child(
                                                div()
                                                    .text_color(rgb(this.theme.muted))
                                                    .child("Current"),
                                            )
                                        })
                                        .on_hover(cx.listener(move |this, hovered, _, cx| {
                                            if *hovered {
                                                if let Some(picker) = &mut this.menu.themes {
                                                    if picker.accepting {
                                                        return;
                                                    }
                                                    picker.selected = index;
                                                }
                                                this.preview_picker_selection(cx);
                                            }
                                        }))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.apply_picker_theme(&name, cx)
                                        }))
                                })
                                .collect()
                        }),
                    )
                    .track_scroll(&picker.scroll)
                    .flex_1()
                    .min_h_0(),
                )
            })
            .child(
                div()
                    .id("theme-status")
                    .debug_selector(|| "theme-status".into())
                    .flex_none()
                    .h(px(font.line_height() * 3. + 20.))
                    .overflow_y_scroll()
                    .px(px(16.))
                    .py(px(10.))
                    .border_t_1()
                    .border_color(rgb(theme.active))
                    .text_color(rgb(theme.muted))
                    .child(if picker.saving {
                        "Saving theme... Please wait.".to_owned()
                    } else if let Some(error) = &picker.error {
                        error.clone()
                    } else if picker.accepting {
                        "Loading theme... Esc to cancel.".to_owned()
                    } else {
                        "Hover or Up / Down to preview. Enter or click a theme to save.".to_owned()
                    }),
            )
    }
}

#[cfg(test)]
mod tests;
