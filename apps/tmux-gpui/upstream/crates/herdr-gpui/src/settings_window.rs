//! Independent native preferences window. Disk work never owns a window or a socket.
#[cfg(feature = "cloud")]
mod cloud_devices;
#[cfg(feature = "daytona")]
pub(crate) use cloud_devices::open as open_cloud;
mod controls;
mod layouts;
pub(crate) use layouts::{apply_loaded_layout, layout_load_revision};
#[cfg(all(feature = "integration-test", target_os = "macos"))]
mod native;
mod persistence;
mod remote_history;
#[cfg(test)]
use persistence::SizeIo;
use persistence::{Loaded, SaveCompletion};
mod themes;
#[cfg(all(feature = "integration-test", target_os = "macos"))]
pub(crate) use native::verify_native;
pub(crate) use themes::{
    apply_loaded_theme, apply_theme_draft, theme_load_revision, theme_pending,
};

use crate::{
    HerdrWindow,
    config::{Config, Theme, corners, mix},
    fonts::StyledFont,
    herdr_settings,
};
use gpui::{prelude::*, *};

actions!(settings_window, [Close]);

pub(crate) fn key_bindings() -> [KeyBinding; 2] {
    [
        KeyBinding::new("cmd-w", Close, Some("SettingsWindow")),
        KeyBinding::new("ctrl-w", Close, Some("SettingsWindow")),
    ]
}

#[derive(Default)]
struct SettingsWindowHandle {
    window: Option<WindowHandle<SettingsWindow>>,
    model: Option<WeakEntity<SettingsWindow>>,
}
impl Global for SettingsWindowHandle {}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Section {
    #[default]
    Appearance,
    Fonts,
    Indicators,
    Sound,
    Notifications,
    StatusBar,
    Integrations,
    #[cfg(feature = "cloud")]
    CloudDevices,
    General,
}

impl Section {
    const ALL: &[Self] = &[
        Self::Appearance,
        Self::Fonts,
        Self::Indicators,
        Self::Sound,
        Self::Notifications,
        Self::StatusBar,
        Self::Integrations,
        #[cfg(feature = "cloud")]
        Self::CloudDevices,
        Self::General,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::Appearance => "Appearance",
            Self::Fonts => "Fonts",
            Self::Indicators => "Indicators",
            Self::Sound => "Sound",
            Self::Notifications => "Notifications",
            Self::StatusBar => "Status bar",
            Self::Integrations => "Integrations",
            #[cfg(feature = "cloud")]
            Self::CloudDevices => "Cloud Devices",
            Self::General => "General",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Appearance => "icons/theme.svg",
            Self::Fonts => "icons/pencil.svg",
            Self::Indicators => "icons/pulse.svg",
            Self::Sound => "icons/chart.svg",
            Self::Notifications => "icons/bell.svg",
            Self::StatusBar => "icons/status-bar.svg",
            Self::Integrations => "icons/agent-generic.svg",
            #[cfg(feature = "cloud")]
            Self::CloudDevices => "icons/globe.svg",
            Self::General => "icons/settings.svg",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::Appearance => "A workspace that feels like yours.",
            Self::Fonts => "Make every line comfortable to read.",
            Self::Indicators => "See what your agents are doing at a glance.",
            Self::Sound => "A little signal when something needs you.",
            Self::Notifications => "Stay informed without losing your place.",
            Self::StatusBar => "Keep the bottom bar to what you use.",
            Self::Integrations => "Connect the agents you work with.",
            #[cfg(feature = "cloud")]
            Self::CloudDevices => {
                "Create machines from your cloud accounts and use them as devices."
            }
            Self::General => "The small details of your daily workflow.",
        }
    }
}

pub(crate) fn open(source: WeakEntity<HerdrWindow>, cx: &mut App) {
    cx.defer(move |cx| {
        open_with(source, cx, |view, window, cx| {
            view.initialize_theme_browser(window, cx);
            view.initialize_controls(cx);
            view.reload(cx);
            view.watch_config(cx);
        })
    });
}

fn open_with(
    source: WeakEntity<HerdrWindow>,
    cx: &mut App,
    initialize: impl FnOnce(&mut SettingsWindow, &mut Window, &mut Context<SettingsWindow>) + 'static,
) {
    if let Some(handle) = cx.default_global::<SettingsWindowHandle>().window
        && handle
            .update(cx, |view, window, cx| {
                view.retarget_source(source.clone(), cx);
                window.activate_window();
            })
            .is_ok()
    {
        return;
    }
    // A detached save retains this model after close. Reopening must not create
    // a second editor with a stale baseline while that write is still running.
    let retained = cx
        .default_global::<SettingsWindowHandle>()
        .model
        .as_ref()
        .and_then(WeakEntity::upgrade);
    let bounds = Bounds::centered(None, size(px(960.), px(780.)), cx);
    match cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(680.), px(560.))),
            titlebar: Some(crate::titlebar::options("Settings")),
            app_owns_titlebar_drag: cfg!(target_os = "macos"),
            ..Default::default()
        },
        move |window, cx| {
            let model = retained.unwrap_or_else(|| {
                cx.new(|cx| {
                    let mut view = SettingsWindow::new(source.clone(), cx);
                    initialize(&mut view, window, cx);
                    view
                })
            });
            model.update(cx, |view, cx| {
                view.retarget_source(source, cx);
                view._appearance = Some(cx.observe_window_appearance(window, |view, _, cx| {
                    view.apply_window_appearance(cx);
                }));
            });
            let weak = model.downgrade();
            window.on_window_should_close(cx, move |window, cx| {
                weak.update(cx, |view, cx| view.should_close(window, cx))
                    .unwrap_or(true)
            });
            let focus = model.read(cx).focus.clone();
            window.focus(&focus, cx);
            cx.default_global::<SettingsWindowHandle>().model = Some(model.downgrade());
            model
        },
    ) {
        Ok(handle) => cx.default_global::<SettingsWindowHandle>().window = Some(handle),
        Err(_) => tracing::error!("Unable to open Settings window"),
    }
}

struct SettingsWindow {
    config: Config,
    theme: Theme,
    shared: Option<herdr_settings::Settings>,
    source: WeakEntity<HerdrWindow>,
    section: Section,
    themes: themes::ThemeBrowser,
    controls: controls::Controls,
    error: Option<String>,
    status: Option<String>,
    focus: FocusHandle,
    body_scroll: ScrollHandle,
    /// The section list's width, dragged by its right edge.
    navigation_width: crate::panel_resize::PanelWidth,
    /// The window's width at its last render, which caps the section list.
    viewport_width: f32,
    loading: bool,
    saving: bool,
    quitting: bool,
    save_completion: Option<std::sync::mpsc::Receiver<SaveCompletion>>,
    _quit: Subscription,
    new_window_target: Option<herdr_client::ConnectTarget>,
    #[cfg(test)]
    size_io: Option<SizeIo>,
    _source: Option<Subscription>,
    _appearance: Option<Subscription>,
    _watch: Option<Task<()>>,
    /// The config files as our last save left them, for the watcher to accept
    /// so the save's own write does not trigger a second reload.
    saved_sample: Option<persistence::Sample>,
    /// Enumerating system fonts takes hundreds of milliseconds, so each
    /// Settings window does it once rather than on every load.
    installed_fonts: std::sync::Arc<std::sync::OnceLock<Vec<String>>>,
    load_revision: u64,
    theme_revision: u64,
    theme_intent: Option<themes::ThemeIntent>,
    theme_saving: bool,
    layout_intent: Option<crate::config::LayoutMode>,
    layout_saving: bool,
    #[cfg(test)]
    layout_io: Option<layouts::LayoutIo>,
    remote_history: remote_history::RemoteHistory,
    /// The Coder card, built when Cloud Devices is first shown.
    /// The provider whose tab Cloud Devices shows.
    #[cfg(feature = "cloud")]
    cloud_tab: crate::cloud::CloudProvider,
    /// The main window's finished cloud jobs when the cards last read them.
    #[cfg(feature = "cloud")]
    cloud_jobs_seen: u64,
    #[cfg(feature = "coder")]
    coder_card: Option<cloud_devices::CoderCard>,
    #[cfg(feature = "daytona")]
    daytona_card: Option<cloud_devices::DaytonaCard>,
    theme_loading: bool,
    theme_waiting: bool,
    theme_light: bool,
    theme_load_failed: bool,
    closing: Option<AnyWindowHandle>,
    theme_cache: std::collections::VecDeque<(String, Theme)>,
    _theme_guard: Subscription,
    #[cfg(test)]
    theme_io: Option<themes::ThemeIo>,
}

impl SettingsWindow {
    fn new(source: WeakEntity<HerdrWindow>, cx: &mut Context<Self>) -> Self {
        let appearance = cx
            .try_global::<crate::app::InitialAppearance>()
            .cloned()
            .unwrap_or_default();
        let (config, theme, shared) =
            source
                .upgrade()
                .map_or((appearance.config, appearance.theme, None), |source| {
                    let source = source.read(cx);
                    (
                        source.config.clone(),
                        source.theme.clone(),
                        source.settings.shared.clone(),
                    )
                });
        let subscription = source
            .upgrade()
            .map(|source| cx.observe(&source, Self::source_changed));
        let new_window_target = source.upgrade().and_then(|source| {
            source
                .read(cx)
                .endpoints
                .first()
                .map(|endpoint| endpoint.connection.target.clone())
        });
        let quit = cx.on_app_quit(|this, cx| {
            let task = this.shutdown(cx);
            async move {
                if task.await.is_err() {
                    tracing::warn!("Unable to finish queued Settings changes during shutdown");
                }
            }
        });
        Self {
            config,
            theme,
            shared,
            source,
            section: Section::Appearance,
            themes: themes::ThemeBrowser::new(cx),
            controls: controls::Controls::new(cx),
            error: appearance.error,
            status: None,
            focus: cx.focus_handle(),
            body_scroll: ScrollHandle::new(),
            navigation_width: crate::panel_resize::SETTINGS_NAVIGATION,
            viewport_width: 0.,
            loading: false,
            saving: false,
            quitting: false,
            save_completion: None,
            _quit: quit,
            new_window_target,
            #[cfg(test)]
            size_io: None,
            _source: subscription,
            _appearance: None,
            _watch: None,
            saved_sample: None,
            installed_fonts: Default::default(),
            load_revision: 0,
            theme_revision: 0,
            theme_intent: None,
            theme_saving: false,
            layout_intent: None,
            layout_saving: false,
            #[cfg(test)]
            layout_io: None,
            remote_history: Default::default(),
            #[cfg(feature = "cloud")]
            cloud_tab: cloud_devices::first_tab(),
            #[cfg(feature = "cloud")]
            cloud_jobs_seen: 0,
            #[cfg(feature = "coder")]
            coder_card: None,
            #[cfg(feature = "daytona")]
            daytona_card: None,
            theme_loading: false,
            theme_waiting: false,
            theme_light: false,
            theme_load_failed: false,
            closing: None,
            theme_cache: Default::default(),
            // Shared-theme/OS callbacks in main windows also publish here. Fence
            // their prepared, older palette while an explicit choice is live.
            _theme_guard: cx.observe_global::<crate::app::InitialAppearance>(|this, cx| {
                if this.theme_intent.is_some()
                    && cx
                        .try_global::<crate::app::InitialAppearance>()
                        .is_some_and(|appearance| {
                            appearance.config.theme != this.config.theme
                                || appearance.theme != this.theme
                        })
                {
                    this.drive_theme_intent(cx);
                }
                if this.layout_intent.is_some()
                    && cx
                        .try_global::<crate::app::InitialAppearance>()
                        .is_some_and(|appearance| {
                            appearance.config.layout.mode != this.config.layout.mode
                        })
                {
                    this.broadcast_layout(cx);
                }
            }),
            #[cfg(test)]
            theme_io: None,
        }
    }

    fn source_changed(&mut self, source: Entity<HerdrWindow>, cx: &mut Context<Self>) {
        #[cfg(feature = "cloud")]
        self.cloud_source_changed(&source, cx);
        #[cfg(not(feature = "cloud"))]
        let _ = source;
        if self.section == Section::Integrations {
            cx.notify();
        }
        if self.section == Section::General {
            self.sync_remote_history(false, cx);
        }
    }

    fn retarget_source(&mut self, source: WeakEntity<HerdrWindow>, cx: &mut Context<Self>) {
        if source.entity_id() == self.source.entity_id()
            || self
                .source
                .upgrade()
                .is_some_and(|source| source.read(cx).integrations.busy)
        {
            return;
        }
        let Some(owner) = source.upgrade() else {
            return;
        };
        self._source = Some(cx.observe(&owner, Self::source_changed));
        self.source = source;
        self.new_window_target = owner
            .read(cx)
            .endpoints
            .first()
            .map(|endpoint| endpoint.connection.target.clone());
        if self.section == Section::Integrations {
            owner.update(cx, |source, cx| source.load_integrations(cx));
        }
        if self.section == Section::General {
            self.sync_remote_history(false, cx);
        }
        cx.notify();
    }

    fn apply_window_appearance(&mut self, cx: &mut Context<Self>) {
        self.follow_system_appearance(cx);
        self.sync_appearance(cx);
        self.drive_theme_intent(cx);
        self.publish_appearance(cx);
    }

    fn sync_appearance(&mut self, cx: &mut Context<Self>) {
        if self.config.theme == "Follow Herdr"
            && self.theme_intent.is_none()
            && let Some(shared) = &self.shared
        {
            let light = matches!(
                cx.window_appearance(),
                WindowAppearance::Light | WindowAppearance::VibrantLight
            );
            match shared.theme(light) {
                Ok(theme) => self.theme = theme.with_contrast(self.config.contrast),
                Err(error) => self.error = Some(format!("Apply system appearance: {error}")),
            }
        }
        // The theme browser owns its unsaved preview; changing system chrome
        // preserves its selected choice instead of selecting the applied theme.
        self.sync_theme_browser(cx);
        self.sync_controls(cx);
        cx.notify();
    }

    fn publish_appearance(&self, cx: &mut Context<Self>) {
        // An in-flight load/save will publish its validated result. In
        // particular, initial source chrome may still be a picker preview.
        if self.busy() {
            return;
        }
        let previous = cx.try_global::<crate::app::InitialAppearance>();
        let keys_changed =
            previous.is_none_or(|previous| previous.config.keybindings != self.config.keybindings);
        let layout_changed =
            previous.is_some_and(|previous| previous.config.layout.mode != self.config.layout.mode);
        // Future windows inherit an explicit Settings draft, but not a main
        // picker's cancellable hover preview. Logs follow live appearance.
        let previewing = cx.windows().into_iter().any(|window| {
            window.downcast::<HerdrWindow>().is_some_and(|window| {
                window.read(cx).map_or(true, |source| {
                    matches!(
                        source.menu.page,
                        Some(crate::menu::Page::Themes | crate::menu::Page::Fonts)
                    ) || source.theme_save_in_flight()
                        || source.native_settings_save_in_flight()
                        || source.font_size_saves.is_busy()
                })
            })
        });
        let mut appearance = crate::app::InitialAppearance {
            config: self.config.clone(),
            theme: self.theme.clone(),
            error: None,
        };
        apply_theme_draft(&mut appearance.config, &mut appearance.theme, cx);
        cx.set_global(appearance);
        if !previewing {
            crate::log_window::set_appearance(&self.config, &self.theme, cx);
        }
        if keys_changed {
            crate::actions::rebind_keys(cx);
        } else if layout_changed {
            crate::menus::install(cx);
        }
    }

    pub(super) fn busy(&self) -> bool {
        self.loading || self.saving || self.quitting
    }

    pub(super) fn theme_dirty(&self) -> bool {
        self.theme_intent.is_some()
    }

    /// Shared entry point for the native titlebar and keyboard close actions.
    pub(super) fn should_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.closing.is_some() {
            return false;
        }
        if !self.finish_control_size_edit(true, cx) {
            return false;
        }
        if !self.theme_dirty() && self.layout_intent.is_none() && !self.busy() {
            return true;
        }
        self.closing = Some(window.window_handle());
        self.status = Some("Finishing preferences before closing...".into());
        self.theme_load_failed = false;
        self.drive_theme_intent(cx);
        false
    }

    pub(super) fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.should_close(window, cx) {
            window.remove_window();
        }
    }

    fn finish_close(&mut self, cx: &mut Context<Self>) {
        if !self.busy()
            && !self.theme_dirty()
            && self.closing.is_some()
            && self.layout_intent.is_some()
        {
            self.save_layout_draft(cx);
            return;
        }
        if !self.busy()
            && !self.theme_dirty()
            && self.layout_intent.is_none()
            && let Some(handle) = self.closing.take()
        {
            cx.defer(move |cx| {
                let _ = handle.update(cx, |_, window, _| window.remove_window());
            });
        }
    }

    fn additional_window_target(&self, cx: &App) -> Option<herdr_client::ConnectTarget> {
        self.source
            .upgrade()
            .and_then(|source| {
                source
                    .read(cx)
                    .endpoints
                    .first()
                    .map(|endpoint| endpoint.connection.target.clone())
            })
            .or_else(|| self.new_window_target.clone())
    }

    pub(super) fn select_section(
        &mut self,
        section: Section,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.finish_control_size_edit(true, cx) {
            self.finish_control_size_edit(false, cx);
        }
        self.dismiss_control_font_picker(window, cx);
        self.section = section;
        self.body_scroll.set_offset(Point::default());
        window.focus(&self.focus, cx);
        if section == Section::Integrations {
            let _ = self
                .source
                .update(cx, |source, cx| source.load_integrations(cx));
        }
        if section == Section::General {
            self.sync_remote_history(false, cx);
        }
        #[cfg(feature = "cloud")]
        if section == Section::CloudDevices {
            self.open_cloud_devices(cx);
        }
        cx.notify();
    }

    fn navigation(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        use crate::panel_resize::{PanelDrag, Side, handle};
        let theme = &self.theme;
        div()
            .id("settings-navigation")
            .relative()
            .w(px(self.navigation_width.width(self.viewport_width)))
            .on_drag_move(
                cx.listener(|this, event: &DragMoveEvent<PanelDrag>, _, cx| {
                    if *event.drag(cx) == PanelDrag::SettingsNavigation
                        && this.navigation_width.drag(
                            Side::Left,
                            event.bounds,
                            event.event.position.x,
                        )
                    {
                        cx.notify();
                    }
                }),
            )
            .child(handle(
                "settings-navigation-resize",
                Side::Left,
                PanelDrag::SettingsNavigation,
                cx.listener(|this, _, _, cx| {
                    this.navigation_width.reset();
                    cx.notify();
                }),
            ))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .p(px(12.))
            .gap(px(4.))
            .bg(rgb(mix(theme.surface, theme.background, 25)))
            .border_r_1()
            .border_color(rgb(theme.active))
            .child(
                div()
                    .px(px(10.))
                    .py(px(20.))
                    .child(
                        div()
                            .text_size(px(18.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Herdr"),
                    )
                    .child(
                        div()
                            .mt(px(3.))
                            .text_color(rgb(theme.subtext()))
                            .child("Settings"),
                    ),
            )
            .children(
                Section::ALL
                    .iter()
                    .copied()
                    .enumerate()
                    .map(|(index, section)| {
                        let selected = self.section == section;
                        div()
                            .id(("settings-section", index))
                            .relative()
                            .map(|row| {
                                #[cfg(all(feature = "integration-test", target_os = "macos"))]
                                let row = row.child(native::probe(index));
                                row
                            })
                            .debug_selector(move || format!("settings-section-{index}"))
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .px(px(10.))
                            .py(px(11.))
                            .rounded(px(corners::CONTROL))
                            .cursor_pointer()
                            .when(selected, |el| el.bg(rgb(theme.primary_wash())))
                            .hover(|el| el.bg(rgb(theme.active)))
                            .child(
                                svg()
                                    .path(section.icon())
                                    .size(px(17.))
                                    .flex_none()
                                    .text_color(rgb(if selected {
                                        theme.primary()
                                    } else {
                                        theme.subtext()
                                    })),
                            )
                            .child(section.label())
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.select_section(section, window, cx)
                            }))
                    }),
            )
    }
}

impl Render for SettingsWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = match self.section {
            Section::Appearance => self.render_appearance(window, cx),
            Section::Integrations => self.render_integration_controls(cx),
            #[cfg(feature = "cloud")]
            Section::CloudDevices => self.render_cloud_devices(cx),
            _ => self.render_controls(window, cx),
        };
        self.viewport_width = f32::from(window.viewport_size().width);
        let navigation = self.navigation(cx);
        let font_picker = self.render_control_font_picker(window, cx);
        let this = cx.entity().downgrade();
        let header = crate::titlebar::header(&self.theme, window, move |window, cx| {
            let _ = this.update(cx, |view, cx| view.close(window, cx));
        });
        let theme = &self.theme;
        let root = div()
            .key_context("SettingsWindow")
            .relative()
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, action: &crate::RunCommand, window, cx| {
                match action.command {
                    command if crate::window::run_window_command(command, window, cx) => {}
                    crate::controls::Command::Settings => window.activate_window(),
                    crate::controls::Command::NewWindow => {
                        if let Some(target) = this.additional_window_target(cx) {
                            crate::app::open_additional_window(target, cx);
                        }
                    }
                    _ => {}
                }
                // Session commands never cross from this independent root to
                // the integration source, even when it is still alive.
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|this, _: &Close, window, cx| {
                cx.stop_propagation();
                this.close(window, cx);
            }))
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .text_font(&self.config.ui)
            .text_size(px(12.))
            .line_height(px(18.))
            .bg(rgb(theme.background))
            .text_color(rgb(theme.foreground))
            .children(header)
            .child(
                div().flex_1().min_h_0().flex().child(navigation).child(
                    div()
                        .id("settings-body")
                        .debug_selector(|| "settings-body".into())
                        .flex_1()
                        .min_w_0()
                        .min_h_0()
                        .overflow_y_scroll()
                        .track_scroll(&self.body_scroll)
                        .p(px(28.))
                        .child(
                            div()
                                .text_size(px(28.))
                                .line_height(px(36.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(self.section.label()),
                        )
                        .child(
                            div()
                                .mt(px(5.))
                                .mb(px(24.))
                                .text_color(rgb(theme.subtext()))
                                .child(self.section.description()),
                        )
                        .child(content),
                ),
            )
            .child(
                div()
                    .flex_none()
                    .min_h(px(36.))
                    .px(px(16.))
                    .py(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .border_t_1()
                    .border_color(rgb(theme.active))
                    .text_size(px(11.))
                    .child(
                        div().debug_selector(|| "settings-footer-status".into()).flex_1().min_w_0().child(
                            self.error
                                .clone()
                                .or_else(|| {
                                    if self.loading {
                                        Some("Loading preferences...".into())
                                    } else {
                                        self.status.clone()
                                    }
                                })
                                .unwrap_or_else(|| {
                                    match self.section {
                                        Section::Appearance => {
                                            "Themes and layouts change live; saved on Settings close or app quit."
                                        }
                                        #[cfg(feature = "cloud")]
                                        Section::CloudDevices => {
                                            "Account fields save with Save; sign-in and removal apply at once."
                                        }
                                        _ => "Changes are saved automatically.",
                                    }
                                    .into()
                                }),
                        ),
                    )
                    .child(
                        self.control_choice("settings-footer-reload", "Reload", false, true)
                            .debug_selector(|| "settings-footer-reload".into())
                            .flex_none()
                            .px(px(10.))
                            .py(px(3.))
                            .on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
                    ),
            )
            .children(font_picker);
        let border = self.theme.active;
        crate::titlebar::frame(window, border, root)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
