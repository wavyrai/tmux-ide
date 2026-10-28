//! Prepared preferences state and background-only configuration operations.
use crate::{
    HerdrWindow,
    fonts::StyledFont,
    herdr_settings::{Edit, IndicatorStyle, Settings, THEME_NAMES, ToastDelivery},
};
use gpui::{prelude::*, *};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Tab {
    #[default]
    Theme,
    Indicators,
    Sound,
    Toasts,
    Integrations,
    Font,
    General,
}

impl Tab {
    pub(crate) const ALL: [Self; 7] = [
        Self::Theme,
        Self::Indicators,
        Self::Sound,
        Self::Toasts,
        Self::Integrations,
        Self::Font,
        Self::General,
    ];

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Theme => "Theme",
            Self::Indicators => "Indicators",
            Self::Sound => "Sound",
            Self::Toasts => "Toasts",
            Self::Integrations => "Integrations",
            Self::Font => "Font",
            Self::General => "General",
        }
    }

    fn next(self, backwards: bool) -> Self {
        let index = Self::ALL.iter().position(|tab| *tab == self).unwrap_or(0);
        Self::ALL[(index + if backwards { Self::ALL.len() - 1 } else { 1 }) % Self::ALL.len()]
    }
}

#[derive(Default)]
pub(crate) struct SettingsPanel {
    pub(crate) shared: Option<Settings>,
    pub(crate) task: Option<Task<()>>,
    pub(crate) loaded: bool,
    pub(crate) tab: Tab,
    pub(crate) tabs_scroll: ScrollHandle,
    pub(crate) error: Option<String>,
    status: Option<String>,
    load_status: Option<String>,
    pub(crate) native_status: Option<String>,
    pub(crate) native_error: Option<String>,
    pub(crate) native_reloading: bool,
    reload_status: Option<String>,
    native_task: Option<Task<()>>,
}

impl SettingsPanel {
    fn ready(&self) -> bool {
        cfg!(unix)
            && self.loaded
            && self.shared.is_some()
            && self.task.is_none()
            && self.error.is_none()
    }
}

impl HerdrWindow {
    pub(crate) fn load_shared_settings(&mut self, cx: &mut Context<Self>) {
        self.load_shared_settings_with(Settings::load, cx);
    }

    fn load_shared_settings_with(
        &mut self,
        load: impl FnOnce() -> crate::Result<Settings> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.settings.task.is_some() {
            return;
        }
        self.settings.error = None;
        self.settings.load_status = Some("Loading shared settings...".into());
        let load = cx.background_executor().spawn(async move { load() });
        self.settings.task = Some(cx.spawn(async move |this, cx| {
            let result = load.await;
            let _ = this.update(cx, |this, cx| {
                this.settings.task = None;
                this.settings.loaded = true;
                match result {
                    Ok(shared) => {
                        this.settings.shared = Some(shared);
                        this.apply_sidebar_start();
                        this.settings.load_status = Some("Loaded from local file".into());
                        this.apply_shared_theme(cx);
                        this.apply_shared_agent_sort();
                        this.reload_notification_config(cx);
                    }
                    Err(error) => {
                        this.settings.load_status = None;
                        this.settings.error = Some(format!("Load shared settings: {error}"));
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// Follows the daemon's `ui.agent_panel_sort` on every load, so a config
    /// reload changes the order too, unless the user toggled the panel.
    pub(crate) fn apply_shared_agent_sort(&mut self) {
        if !self.agent_sort_modified
            && let Some(shared) = &self.settings.shared
        {
            self.agent_sort = shared.agent_sort;
        }
    }

    pub(crate) fn apply_shared_theme(&mut self, cx: &mut Context<Self>) {
        if self.config.theme == "Follow Herdr"
            && self.menu.page != Some(crate::menu::Page::Themes)
            && !self.theme_save_in_flight()
            && let Some(shared) = &self.settings.shared
        {
            let light = matches!(
                cx.window_appearance(),
                WindowAppearance::Light | WindowAppearance::VibrantLight
            );
            match shared.theme(light) {
                Ok(theme) => {
                    self.theme = theme.with_contrast(self.config.contrast);
                    if let Some(mut appearance) =
                        cx.try_global::<crate::app::InitialAppearance>().cloned()
                        && appearance.config.theme == "Follow Herdr"
                    {
                        appearance.theme = self.theme.clone();
                        cx.set_global(appearance);
                    }
                    crate::log_window::set_appearance(&self.config, &self.theme, cx);
                }
                Err(error) => self.settings.error = Some(error.to_string()),
            }
        }
    }

    /// Follows the system appearance: reads the theme again, for the other
    /// side of a `light:…,dark:…` pair or for a theme file that a desktop
    /// theme switcher rewrote before it changed the appearance. Herdr hears
    /// of the new appearance only with the colors loaded for it.
    pub(crate) fn apply_system_theme(&mut self, cx: &mut Context<Self>) {
        // Follow Herdr already shows the daemon's theme for it.
        if self.config.theme == "Follow Herdr" || !self.reload_theme(cx) {
            self.theme_light = crate::app::light_appearance(cx);
        }
    }

    /// Reads the configured theme again, for the system appearance. Theme
    /// files are read on the background executor; a result is dropped when
    /// the theme or appearance changed while it loaded. Returns `false`
    /// without reading while the picker or Settings owns the theme.
    pub(crate) fn reload_theme(&mut self, cx: &mut Context<Self>) -> bool {
        if self.menu.page == Some(crate::menu::Page::Themes)
            || self.theme_save_in_flight()
            // Settings applies its own draft to every window.
            || crate::settings_window::theme_pending(cx)
        {
            return false;
        }
        let light = crate::app::light_appearance(cx);
        let config = self.config.clone();
        let load = cx
            .background_executor()
            .spawn(async move { config.theme(light).map(|theme| (config, theme)) });
        cx.spawn(async move |this, cx| {
            let result = load.await;
            let _ = this.update(cx, |this, cx| {
                // Unless a load for a newer appearance is on its way, Herdr
                // now hears this one, with whatever theme this load leaves.
                if light == crate::app::light_appearance(cx) && this.theme_light != light {
                    this.theme_light = light;
                    cx.notify();
                }
                let (config, theme) = match result {
                    Ok(loaded) => loaded,
                    Err(error) => {
                        tracing::warn!(%error, "Could not reload the theme");
                        this.local_error = Some(format!("Reload theme: {error}"));
                        cx.notify();
                        return;
                    }
                };
                if config.theme != this.config.theme
                    || config.contrast != this.config.contrast
                    || light != crate::app::light_appearance(cx)
                    || this.menu.page == Some(crate::menu::Page::Themes)
                    || this.theme_save_in_flight()
                    || crate::settings_window::theme_pending(cx)
                {
                    return;
                }
                this.theme = theme;
                if let Some(mut appearance) =
                    cx.try_global::<crate::app::InitialAppearance>().cloned()
                    && appearance.config.theme == this.config.theme
                {
                    appearance.theme = this.theme.clone();
                    cx.set_global(appearance);
                }
                crate::log_window::set_appearance(&this.config, &this.theme, cx);
                cx.notify();
            });
        })
        .detach();
        true
    }

    fn save_shared_settings(&mut self, edit: Edit, cx: &mut Context<Self>) {
        if !self.settings.ready() {
            return;
        }
        let Some(shared) = self.settings.shared.clone() else {
            return;
        };
        self.settings.status = Some("Saving local file...".into());
        self.settings.reload_status = None;
        let save = cx
            .background_executor()
            .spawn(async move { shared.save(edit) });
        self.settings.task = Some(cx.spawn(async move |this, cx| {
            let result = save.await;
            let _ = this.update(cx, |this, cx| {
                this.settings.task = None;
                match result {
                    Ok(shared) => {
                        this.settings.shared = Some(shared);
                        this.settings.status = Some("Saved to local file".into());
                        this.apply_shared_theme(cx);
                        this.apply_shared_agent_sort();
                        this.reload_notification_config(cx);
                        // Queue directly: neither dialog nor integration response slots belong to us.
                        let local = this
                            .endpoints
                            .iter()
                            .find(|endpoint| !endpoint.connection.target.is_remote());
                        this.settings.reload_status = Some(match local {
                            Some(endpoint) => match (
                                endpoint.connection.handle.as_ref(),
                                endpoint.live.snapshot.as_ref(),
                            ) {
                                (Some(handle), Some(snapshot))
                                    if endpoint.live.status.is_connected() =>
                                {
                                    match handle.request(
                                        &snapshot.boot_id,
                                        herdr_client::Method::ServerReloadConfig,
                                        serde_json::json!({}),
                                    ) {
                                        Ok(_) => {
                                            "Local daemon reload queued (not acknowledged)".into()
                                        }
                                        Err(error) => {
                                            format!("Local daemon reload not queued: {error}")
                                        }
                                    }
                                }
                                _ => "Local daemon reload not queued: disconnected".into(),
                            },
                            None => "Local daemon reload not queued: no local endpoint".into(),
                        });
                    }
                    Err(error) => {
                        this.settings.status = None;
                        this.settings.error =
                            Some(format!("Save failed; reload before retrying: {error}"));
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    pub(crate) fn select_settings_tab(
        &mut self,
        tab: Tab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.finish_font_size_edit(true, cx);
        self.settings.tab = tab;
        if let Some(index) = Tab::ALL.iter().position(|item| *item == tab) {
            self.settings.tabs_scroll.scroll_to_item(index);
        }
        self.menu.preferences_scroll.set_offset(Point::default());
        window.focus(&self.menu.focus, cx);
        if tab == Tab::Integrations {
            self.load_integrations(cx);
        }
        cx.notify();
    }

    /// Return true when the preferences page owns routing, including native IME input.
    pub(crate) fn settings_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.menu.page != Some(crate::menu::Page::Preferences) {
            return false;
        }
        // The native size editor owns text and IME keys before tab navigation.
        if self.menu.font_size_editor.is_some() {
            return false;
        }
        if event.keystroke.key == "tab" {
            self.select_settings_tab(
                self.settings.tab.next(event.keystroke.modifiers.shift),
                window,
                cx,
            );
            cx.stop_propagation();
            window.prevent_default();
            return true;
        }
        false
    }

    fn follow_herdr_theme(&mut self, cx: &mut Context<Self>) {
        let config = self.config.clone();
        self.save_native_settings_with(move || config.save_theme("Follow Herdr"), cx);
    }

    fn save_native_settings_with(
        &mut self,
        save: impl FnOnce() -> crate::Result<()> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.native_settings_save_in_flight()
            || self.config_load.is_some()
            || self.font_size_saves.is_busy()
            || self.theme_save_in_flight()
            || self.menu.page == Some(crate::menu::Page::Themes)
        {
            return;
        }
        self.settings.native_status = Some("Saving GUI config...".into());
        self.settings.native_error = None;
        let save = cx.background_executor().spawn(async move { save() });
        self.settings.native_task = Some(cx.spawn(async move |this, cx| {
            let result = save.await;
            let _ = this.update(cx, |this, cx| {
                this.settings.native_task = None;
                match result {
                    Ok(()) => {
                        this.settings.native_status =
                            Some("GUI config saved; reloading appearance".into());
                        this.load_gui_config(cx);
                        this.settings.native_reloading = true;
                    }
                    Err(error) => {
                        this.settings.native_status = None;
                        this.settings.native_error = Some(format!("Save GUI config: {error}"));
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    pub(crate) fn native_settings_save_in_flight(&self) -> bool {
        self.settings.native_task.is_some() || self.settings.native_reloading
    }

    fn settings_button(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        selected: bool,
        enabled: bool,
    ) -> Stateful<Div> {
        let id = id.into();
        let label: SharedString = label.into();
        div()
            .id(id.clone())
            .debug_selector(move || id.to_string())
            .px(px(8.))
            .py(px(5.))
            .rounded(px(4.))
            .border_1()
            .border_color(rgb(self.theme.active))
            .bg(rgb(if selected {
                self.theme.active
            } else {
                self.theme.background
            }))
            .when(enabled, |button| {
                button
                    .cursor_pointer()
                    .hover(|style| style.bg(rgb(self.theme.active)))
            })
            .when(!enabled, |button| button.opacity(0.5))
            .child(label)
    }

    pub(crate) fn render_preferences(&self, cx: &mut Context<Self>) -> Div {
        let tab = self.settings.tab;
        let ready = self.settings.ready();
        let native_ready = !self.native_settings_save_in_flight()
            && self.config_load.is_none()
            && !self.font_size_saves.is_busy()
            && !self.theme_save_in_flight();
        let mut body = div()
            .id("preferences-body")
            .debug_selector(|| "preferences-body".into())
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_y_scroll()
            .track_scroll(&self.menu.preferences_scroll)
            .p(px(12.));
        if cfg!(windows) && matches!(tab, Tab::Theme | Tab::Indicators | Tab::Sound | Tab::Toasts) {
            body = body.child(div().pb(px(8.)).child("Shared Herdr settings are read-only on Windows. Native fonts and theme overrides remain editable."));
        }
        match tab {
            Tab::Theme => {
                body = body.child(div().debug_selector(|| "preferences-theme".into()).py(px(8.)).child(format!("GUI theme: {}", self.config.theme)))
                    .child(div().flex().flex_wrap().gap(px(6.))
                        .child(self.settings_button("preferences-choose-theme", "Native override...", false, native_ready).on_click(cx.listener(|this, _, window, cx| {
                            if !this.native_settings_save_in_flight() && this.config_load.is_none() && !this.font_size_saves.is_busy() && !this.theme_save_in_flight() { this.open_theme_picker(window, cx); }
                        })))
                        .child(self.settings_button("preferences-follow-herdr", "Follow Herdr", self.config.theme == "Follow Herdr", native_ready).on_click(cx.listener(|this, _, _, cx| this.follow_herdr_theme(cx)))))
                    .child(div().py(px(8.)).child("Choosing a shared theme preserves your native override. Follow Herdr to use it in the GUI."));
                let mut choices = div().flex().flex_wrap().gap(px(6.));
                for &name in THEME_NAMES {
                    choices = choices.child(
                        self.settings_button(
                            format!("shared-theme-{name}"),
                            name,
                            self.settings
                                .shared
                                .as_ref()
                                .is_some_and(|s| s.theme_name == name),
                            ready,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.save_shared_settings(Edit::Theme(name.into()), cx)
                        })),
                    );
                }
                body = body.child(choices);
            }
            Tab::Indicators => {
                use herdr_client::protocol::AgentStatus;

                body = body.child(div().py(px(8.)).child("Agent status indicators"));
                for (label, style) in [
                    ("Dots", IndicatorStyle::Dots),
                    ("Symbols", IndicatorStyle::Symbols),
                ] {
                    body = body.child(
                        self.settings_button(
                            format!("indicators-{label}"),
                            label,
                            self.settings
                                .shared
                                .as_ref()
                                .is_some_and(|s| s.indicators == style),
                            ready,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.save_shared_settings(Edit::Indicators(style), cx)
                        })),
                    );
                    if let Some(shared) = &self.settings.shared {
                        let light = matches!(
                            cx.window_appearance(),
                            WindowAppearance::Light | WindowAppearance::VibrantLight
                        );
                        let mut preview = div()
                            .debug_selector(move || format!("indicators-preview-{label}"))
                            .flex()
                            .flex_wrap()
                            .gap(px(12.))
                            .py(px(10.));
                        for (status, name, symbol) in [
                            (AgentStatus::Working, "Working", "\u{25d0}"),
                            (AgentStatus::Blocked, "Blocked", "\u{d7}"),
                            (AgentStatus::Done, "Done", "\u{2713}"),
                            (AgentStatus::Idle, "Idle", "\u{25cb}"),
                            (AgentStatus::Unknown, "Unknown", "\u{b7}"),
                        ] {
                            let color = rgb(self.theme.ink(shared.status_color(status, light)));
                            let mark = div()
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .w(px(self.config.ui.size))
                                .h(px(self.config.ui.line_height()))
                                .when(style == IndicatorStyle::Symbols, |mark| {
                                    mark.text_color(color).child(symbol)
                                })
                                .when(style == IndicatorStyle::Dots, |mark| {
                                    mark.child(
                                        div()
                                            .size(px(if status == AgentStatus::Unknown {
                                                3.
                                            } else {
                                                7.
                                            }))
                                            .rounded_full()
                                            .border_1()
                                            .border_color(color)
                                            .when(status != AgentStatus::Idle, |dot| dot.bg(color)),
                                    )
                                });
                            preview = preview.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .child(mark)
                                    .child(name),
                            );
                        }
                        body = body.child(preview);
                    }
                }
            }
            Tab::Sound => {
                body = body.child(div().py(px(8.)).child("Agent sounds use the dedicated audio backend with shared sound paths and per-agent overrides. Missing or unusable custom sounds fall back to bundled Done/Request sounds. Playback requires an available audio device. No preview is played automatically."));
                for (label, enabled) in [("On", true), ("Off", false)] {
                    body = body.child(
                        self.settings_button(
                            format!("sound-{label}"),
                            label,
                            self.settings
                                .shared
                                .as_ref()
                                .is_some_and(|s| s.sound_enabled == enabled),
                            ready,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.save_shared_settings(Edit::Sound(enabled), cx)
                        })),
                    );
                }
                body = body.child(
                    div().py(px(8.)).child(
                        self.settings_button("sound-preview", "Play test sound (QA)", false, true)
                            .on_click(cx.listener(|this, _, _, _| this.sound.preview())),
                    ),
                );
            }
            Tab::Toasts => {
                body = body.child(div().py(px(8.)).child("Shared delivery settings also apply to other Herdr clients. This GUI shows Herdr delivery as in-app toasts and System delivery as OS notifications; it does not deliver terminal notifications. Native [notifications] overrides take precedence. QA previews work even when delivery is disabled."))
                    .child(div().py(px(8.)).child(format!(
                        "Effective delivery: {} | Delay: {} seconds | Corner: {:?}",
                        match self.config.notifications.delivery() {
                            crate::config::NotificationDelivery::Off => "Off",
                            crate::config::NotificationDelivery::InApp => "In-app",
                            crate::config::NotificationDelivery::System => "System",
                        },
                        self.config.notifications.delay_seconds,
                        self.config.notifications.position,
                    )));
                for (label, delivery) in [
                    ("Off", ToastDelivery::Off),
                    ("Herdr", ToastDelivery::Herdr),
                    ("Terminal", ToastDelivery::Terminal),
                    ("System", ToastDelivery::System),
                ] {
                    body = body.child(
                        self.settings_button(
                            format!("toasts-{label}"),
                            label,
                            self.settings
                                .shared
                                .as_ref()
                                .is_some_and(|s| s.toast_delivery == delivery),
                            ready,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.save_shared_settings(Edit::Toasts(delivery), cx)
                        })),
                    );
                }
            }
            Tab::Font | Tab::Integrations | Tab::General => {}
        }
        let content = match tab {
            Tab::Font | Tab::General => self.render_native_preferences(cx).into_any_element(),
            Tab::Integrations => self.render_integrations(cx).into_any_element(),
            _ => body.into_any_element(),
        };
        let mut tabs = div()
            .id("preferences-tabs")
            .debug_selector(|| "preferences-tabs".into())
            .flex()
            .flex_none()
            .min_w_0()
            .overflow_x_scroll()
            .track_scroll(&self.settings.tabs_scroll)
            .gap(px(4.))
            .px(px(12.))
            .pb(px(8.));
        for tab in Tab::ALL {
            tabs =
                tabs.child(
                    self.settings_button(
                        format!("preferences-tab-{}", tab.label()),
                        tab.label(),
                        self.settings.tab == tab,
                        true,
                    )
                    .flex_none()
                    .whitespace_nowrap()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.select_settings_tab(tab, window, cx)
                    })),
                );
        }
        div()
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .min_w_0()
            .text_font(&self.config.ui)
            .text_size(px(self.config.ui.size))
            .text_color(rgb(self.theme.foreground))
            .child(
                div()
                    .debug_selector(|| "preferences-header".into())
                    .flex()
                    .items_center()
                    .flex_none()
                    .p(px(12.))
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Preferences"),
                    )
                    .child(
                        self.settings_button("preferences-close", "Close", false, true)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.dismiss_menu(window, cx)),
                            ),
                    ),
            )
            .child(tabs)
            .child(content)
            .child(
                div()
                    .id("preferences-status")
                    .debug_selector(|| "preferences-footer".into())
                    .flex_none()
                    .max_h(px(80.))
                    .overflow_y_scroll()
                    .px(px(12.))
                    .py(px(8.))
                    .text_size(px(self.config.ui.size * 0.85))
                    .when_some(self.font_size_saves.status(), |footer, text| {
                        footer.child(div().child(text.to_owned()))
                    })
                    .when_some(self.settings.status.clone(), |footer, text| {
                        footer.child(text)
                    })
                    .when_some(self.settings.load_status.clone(), |footer, text| {
                        footer.child(div().child(text))
                    })
                    .when_some(self.settings.native_status.clone(), |footer, text| {
                        footer.child(div().child(text))
                    })
                    .when_some(self.settings.native_error.clone(), |footer, text| {
                        footer.child(div().child(text))
                    })
                    .when_some(self.settings.reload_status.clone(), |footer, text| {
                        footer.child(div().child(text))
                    })
                    .when_some(self.settings.error.clone(), |footer, text| {
                        footer.child(div().child(text))
                    })
                    .child(div().child("Tab / Shift-Tab: sections   Esc: close")),
            )
    }
}

#[cfg(test)]
mod tests;
