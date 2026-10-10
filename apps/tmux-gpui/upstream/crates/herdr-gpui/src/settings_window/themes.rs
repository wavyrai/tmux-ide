//! Search-only samples and explicit app-wide theme intents. Disk work stays off the UI thread.
use super::SettingsWindow;
use crate::{
    config::{Config, Theme, ThemeName},
    contrast::Contrast,
    herdr_settings::{self, Edit},
    search_input::{Changed, SearchInput},
};
use gpui::{prelude::*, *};
mod appearance;
mod grid;
mod system;

const FOLLOW: &str = "Follow Herdr";
const LIST_HEIGHT: f32 = 168.;
const ROW_HEIGHT: f32 = 80.;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Scope {
    #[default]
    App,
    Herdr,
}

impl Scope {
    fn editable(self) -> bool {
        self == Self::App || cfg!(unix)
    }
}

#[derive(Clone)]
pub(super) struct ThemeIntent {
    pub(super) revision: u64,
    choice: Choice,
    theme: Option<Theme>,
}

#[derive(Default)]
pub(super) struct ThemeDraft {
    active: bool,
    revision: u64,
    // Store unadjusted colors so a concurrent contrast edit is applied once.
    appearance: Option<(String, Theme)>,
}
impl Global for ThemeDraft {}

pub(crate) fn theme_pending(cx: &App) -> bool {
    cx.try_global::<ThemeDraft>()
        .is_some_and(|draft| draft.active)
}

pub(crate) fn apply_theme_draft(config: &mut Config, theme: &mut Theme, cx: &App) {
    if !theme_pending(cx) {
        return;
    }
    if let Some((name, raw)) = cx
        .try_global::<ThemeDraft>()
        .and_then(|draft| draft.appearance.as_ref())
    {
        config.theme = name.clone();
        *theme = raw.clone().with_contrast(config.contrast);
    }
}

pub(crate) fn theme_load_revision(cx: &App) -> u64 {
    cx.try_global::<ThemeDraft>()
        .map_or(0, |draft| draft.revision)
}

pub(crate) fn apply_loaded_theme(config: &mut Config, theme: &mut Theme, revision: u64, cx: &App) {
    if theme_pending(cx) {
        apply_theme_draft(config, theme, cx);
    } else if revision != theme_load_revision(cx)
        && let Some((name, raw)) = cx
            .try_global::<ThemeDraft>()
            .and_then(|draft| draft.appearance.as_ref())
    {
        // This read began before the final draft was committed. Its other
        // fields remain usable, but its older theme must not replace the commit.
        config.theme = name.clone();
        *theme = raw.clone().with_contrast(config.contrast);
    }
}

pub(super) fn clear_theme_draft(cx: &mut App) {
    let draft = cx.default_global::<ThemeDraft>();
    draft.active = false;
    draft.revision = draft.revision.wrapping_add(1);
}

#[cfg(test)]
#[derive(Clone)]
pub(super) struct ThemeIo {
    pub write: std::sync::Arc<ThemeWriter>,
    pub load: std::sync::Arc<dyn Fn() -> crate::Result<super::Loaded> + Send + Sync>,
    pub resolve: Option<std::sync::Arc<ThemeResolver>>,
}

#[cfg(test)]
type ThemeResolver = dyn Fn(&str) -> crate::Result<Theme> + Send + Sync;

#[cfg(test)]
type ThemeWriter =
    dyn Fn(String, Option<herdr_settings::Settings>) -> crate::Result<()> + Send + Sync;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Choice {
    pub scope: Scope,
    pub name: String,
}

pub(super) struct ThemeBrowser {
    search: Entity<SearchInput>,
    _subscription: Subscription,
    names: Vec<String>,
    filtered: Vec<Choice>,
    ghostty_enabled: bool,
    herdr_enabled: bool,
    query: String,
    selected: Option<usize>,
    scroll: UniformListScrollHandle,
    initialized: bool,
    discovering: bool,
    catalog_error: Option<String>,
    revision: u64,
    running: Option<u64>,
    attempted: Option<u64>,
    loaded: Option<u64>,
    preview: Option<Theme>,
    preview_name: Option<String>,
    preview_error: Option<String>,
    contrast: Contrast,
    grid: grid::Grid,
    /// Which side of a theme that follows the system the grid edits.
    editing_light: bool,
}

impl ThemeBrowser {
    pub(super) fn new(cx: &mut Context<SettingsWindow>) -> Self {
        let search = cx.new(SearchInput::new);
        let subscription = cx.subscribe(&search, |this, search, _: &Changed, cx| {
            let query = search.read(cx).text().to_owned();
            if query == this.themes.query {
                return;
            }
            this.themes.query = query;
            this.themes.filter(None);
            this.request_theme_preview(cx);
        });
        Self {
            search,
            _subscription: subscription,
            names: Vec::new(),
            filtered: Vec::new(),
            ghostty_enabled: true,
            herdr_enabled: true,
            query: String::new(),
            selected: None,
            scroll: UniformListScrollHandle::new(),
            initialized: false,
            discovering: false,
            catalog_error: None,
            revision: 0,
            running: None,
            attempted: None,
            loaded: None,
            preview: None,
            preview_name: None,
            preview_error: None,
            contrast: Contrast::Standard,
            grid: grid::Grid::default(),
            editing_light: false,
        }
    }

    fn choice(&self) -> Option<Choice> {
        self.filtered.get(self.selected?).cloned()
    }

    fn source_enabled(&self, scope: Scope) -> bool {
        match scope {
            Scope::App => self.ghostty_enabled,
            Scope::Herdr => self.herdr_enabled,
        }
    }

    fn filter(&mut self, preserve: Option<&Choice>) {
        self.grid.invalidate();
        self.filtered.clear();
        for scope in [Scope::App, Scope::Herdr] {
            if !self.source_enabled(scope) {
                continue;
            }
            let names = match scope {
                Scope::App => filter_names(self.names.iter().map(String::as_str), &self.query),
                Scope::Herdr => {
                    filter_names(herdr_settings::THEME_NAMES.iter().copied(), &self.query)
                }
            };
            self.filtered
                .extend(names.into_iter().map(|name| Choice { scope, name }));
        }
        self.filtered.sort_by_cached_key(|choice| {
            (
                choice.name.to_lowercase(),
                choice.scope == Scope::Herdr,
                choice.name.clone(),
            )
        });
        self.selected = preserve
            .and_then(|choice| self.filtered.iter().position(|item| item == choice))
            .or_else(|| (!self.filtered.is_empty()).then_some(0));
        self.scroll.scroll_to_item(
            self.selected.unwrap_or(0) / self.grid.columns,
            ScrollStrategy::Top,
        );
    }

    fn finish_preview(&mut self, revision: u64, name: String, result: crate::Result<Theme>) {
        if self.running != Some(revision) {
            return;
        }
        self.running = None;
        if revision != self.revision {
            return;
        }
        match result {
            Ok(theme) => {
                self.preview = Some(theme);
                self.preview_name = Some(name);
                self.loaded = Some(revision);
                self.preview_error = None;
            }
            Err(error) => self.preview_error = Some(error.to_string()),
        }
    }
}

fn filter_names<'a>(names: impl IntoIterator<Item = &'a str>, query: &str) -> Vec<String> {
    let query = query.to_lowercase();
    let tokens: Vec<_> = query.split_whitespace().collect();
    names
        .into_iter()
        .filter(|name| {
            let name = name.to_lowercase();
            tokens.iter().all(|token| name.contains(token))
        })
        .map(str::to_owned)
        .collect()
}

impl SettingsWindow {
    fn theme_operation(
        &self,
        intent: &ThemeIntent,
    ) -> impl FnOnce(Option<herdr_settings::Settings>) -> crate::Result<()> + Send + 'static + use<>
    {
        let choice = intent.choice.clone();
        let config = self.config.clone();
        let shared = self.shared.clone();
        #[cfg(test)]
        let io = self.theme_io.clone();
        move |refreshed| {
            let shared = match choice.scope {
                Scope::App => None,
                Scope::Herdr => refreshed.or(shared),
            };
            #[cfg(test)]
            if let Some(io) = io {
                return (io.write)(choice.name, shared);
            }
            match choice.scope {
                Scope::App => config.save_theme(&choice.name),
                Scope::Herdr => shared
                    .ok_or(crate::Error::MissingHome)?
                    .save(Edit::Theme(choice.name))
                    .map(|_| ()),
            }
        }
    }

    pub(super) fn take_shutdown_theme(
        &mut self,
    ) -> Option<
        impl FnOnce(Option<herdr_settings::Settings>) -> crate::Result<()> + Send + 'static + use<>,
    > {
        let intent = self.theme_intent.take()?;
        if self.theme_saving {
            return None;
        }
        let validate = self.theme_loader(intent.choice.clone());
        let write = self.theme_operation(&intent);
        Some(move |shared| {
            if intent.theme.is_none() {
                validate()?;
            }
            write(shared)
        })
    }

    fn theme_loader(
        &self,
        choice: Choice,
    ) -> impl FnOnce() -> crate::Result<Theme> + Send + 'static + use<> {
        let mut config = self.config.clone();
        config.theme = choice.name;
        config.contrast = Contrast::Standard;
        let shared = self.shared.clone();
        let light = self.theme_light;
        #[cfg(test)]
        let resolve = self.theme_io.as_ref().and_then(|io| io.resolve.clone());
        move || {
            #[cfg(test)]
            if let Some(resolve) = resolve {
                return resolve(ThemeName::side(&config.theme, light));
            }
            match (choice.scope, shared) {
                (Scope::Herdr, Some(shared)) => shared
                    .preview_theme(&config.theme, light)
                    .map(|theme| theme.with_contrast(config.contrast)),
                (Scope::Herdr, None) => Err(crate::Error::MissingHome),
                (Scope::App, Some(shared)) if ThemeName::side(&config.theme, light) == FOLLOW => {
                    shared.theme(light)
                }
                (Scope::App, None) if ThemeName::side(&config.theme, light) == FOLLOW => {
                    Err(crate::Error::MissingHome)
                }
                _ => config.theme(light),
            }
        }
    }

    pub(super) fn accept_theme_choice(&mut self, choice: Choice, cx: &mut Context<Self>) {
        if self.quitting || self.closing.is_some() {
            return;
        }
        if !choice.scope.editable() {
            self.status = Some("Shared Herdr themes are read-only on this platform. Choose This app or Follow Herdr instead.".into());
            cx.notify();
            return;
        }
        self.theme_load_failed = false;
        self.error = None;
        self.status = Some("Theme draft; saved when Settings closes".into());
        self.theme_revision = self.theme_revision.wrapping_add(1);
        self.theme_light = matches!(
            cx.window_appearance(),
            WindowAppearance::Light | WindowAppearance::VibrantLight
        );
        let theme = match (choice.scope, self.shared.as_ref()) {
            (Scope::Herdr, Some(shared)) => {
                shared.preview_theme(&choice.name, self.theme_light).ok()
            }
            (Scope::App, _) => self.prepared_app_theme(&choice.name, self.theme_light),
            _ => None,
        };
        self.theme_intent = Some(ThemeIntent {
            revision: self.theme_revision,
            choice,
            theme,
        });
        let draft = cx.default_global::<ThemeDraft>();
        if !draft.active {
            draft.appearance = None;
        }
        draft.active = true;
        draft.revision = draft.revision.wrapping_add(1);
        self.drive_theme_intent(cx);
    }

    pub(super) fn drive_theme_intent(&mut self, cx: &mut Context<Self>) {
        if self.quitting || self.theme_load_failed {
            return;
        }
        let light = crate::app::light_appearance(cx);
        if let Some(intent) = &mut self.theme_intent
            && intent.choice.scope == Scope::App
            && ThemeName::side(&intent.choice.name, light) == FOLLOW
            && let Some(shared) = &self.shared
            && let Ok(theme) = shared.theme(light)
        {
            intent.theme = Some(theme);
        }
        let Some(intent) = self.theme_intent.clone() else {
            self.finish_close(cx);
            return;
        };
        if intent.theme.is_none() {
            if self.theme_loading {
                return;
            }
            self.theme_loading = true;
            let load = self.theme_loader(intent.choice.clone());
            let light = self.theme_light;
            let retained = cx.entity();
            let work = cx.background_executor().spawn(async move { load() });
            cx.spawn(async move |_, cx| {
                let result = work.await;
                retained.update(cx, |this, cx| {
                    this.theme_loading = false;
                    if this.quitting {
                        return;
                    }
                    if let Some(current) = &mut this.theme_intent
                        && current.revision == intent.revision
                    {
                        match result {
                            Ok(theme) => {
                                let name = ThemeName::side(&intent.choice.name, light);
                                if intent.choice.scope == Scope::App && name != FOLLOW {
                                    if this.theme_cache.len() == 64 {
                                        this.theme_cache.pop_front();
                                    }
                                    this.theme_cache.push_back((name.to_owned(), theme.clone()));
                                }
                                current.theme = Some(theme);
                            }
                            Err(error) => {
                                this.theme_load_failed = true;
                                this.closing = None;
                                this.error = Some(format!("Load theme: {error}"));
                            }
                        }
                    }
                    this.drive_theme_intent(cx);
                    cx.notify();
                });
            })
            .detach();
            return;
        }
        // A main picker at its commit boundary must reconcile before we replace it.
        if cx.windows().into_iter().any(|window| {
            window
                .downcast::<crate::HerdrWindow>()
                .is_some_and(|window| {
                    window
                        .read(cx)
                        .is_ok_and(|view| view.theme_save_in_flight())
                })
        }) {
            if self.theme_waiting {
                return;
            }
            self.theme_waiting = true;
            let retained = cx.entity();
            cx.spawn(async move |_, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(10))
                    .await;
                retained.update(cx, |this, cx| {
                    this.theme_waiting = false;
                    this.drive_theme_intent(cx);
                });
            })
            .detach();
            return;
        }
        if let Some(theme) = intent.theme {
            if intent.choice.scope == Scope::App {
                self.config.theme = intent.choice.name.clone();
                cx.default_global::<ThemeDraft>().appearance =
                    Some((self.config.theme.clone(), theme.clone()));
                self.theme = theme.with_contrast(self.config.contrast);
                self.broadcast_theme(cx);
            } else if self.config.theme == FOLLOW {
                cx.default_global::<ThemeDraft>().appearance =
                    Some((self.config.theme.clone(), theme.clone()));
                self.theme = theme.with_contrast(self.config.contrast);
                self.broadcast_theme(cx);
            }
        }
        if self.closing.is_none() || self.busy() || self.theme_saving {
            return;
        }
        let Some(intent) = self.theme_intent.as_ref() else {
            return;
        };
        let operation = self.theme_operation(intent);
        let operation = move || operation(None);
        let shared = intent.choice.scope == Scope::Herdr;
        self.theme_saving = true;
        #[cfg(test)]
        if let Some(io) = self.theme_io.clone() {
            self.save_with(operation, move || (io.load)(), shared, cx);
            return;
        }
        self.save_with(operation, self.loader(cx), shared, cx);
    }

    pub(super) fn broadcast_theme(&mut self, cx: &mut Context<Self>) {
        for handle in cx.windows() {
            if let Some(handle) = handle.downcast::<crate::HerdrWindow>() {
                let _ = handle.update(cx, |view, window, cx| {
                    if view.theme_save_in_flight() {
                        return;
                    }
                    if view.menu.page == Some(crate::menu::Page::Themes) {
                        view.dismiss_menu(window, cx);
                    }
                    view.config.theme = self.config.theme.clone();
                    view.config.contrast = self.config.contrast;
                    view.theme = self.theme.clone();
                    if !theme_pending(cx) {
                        view.settings.shared = self.shared.clone();
                    }
                    cx.notify();
                });
            }
        }
        let mut appearance = cx
            .try_global::<crate::app::InitialAppearance>()
            .cloned()
            .unwrap_or_default();
        appearance.config.theme = self.config.theme.clone();
        appearance.config.contrast = self.config.contrast;
        appearance.theme = self.theme.clone();
        crate::log_window::set_appearance(&appearance.config, &appearance.theme, cx);
        cx.set_global(appearance);
        self.themes.search.update(cx, |input, cx| {
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx)
        });
        self.refresh_control_appearance(cx);
        cx.notify();
    }

    #[cfg(all(feature = "integration-test", target_os = "macos"))]
    pub(super) fn native_theme_search(&self, cx: &App) -> (FocusHandle, usize, bool) {
        (
            self.themes.search.read(cx).focus.clone(),
            self.themes.filtered.len(),
            self.themes.discovering
                || self
                    .native_theme_cards(cx)
                    .iter()
                    .any(|(_, _, settled)| !settled)
                || self.themes.running.is_some()
                || self.theme_loading
                || self.theme_waiting
                || self.saving,
        )
    }

    pub(super) fn initialize_theme_browser(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.themes.initialized {
            return;
        }
        self.themes.initialized = true;
        self.themes.contrast = self.config.contrast;
        self.themes.preview = Some(self.theme.clone());
        self.themes.editing_light = crate::app::light_appearance(cx);
        self.themes.preview_name = Some(self.edited_theme().to_owned());
        self.themes.names = Theme::BUILTIN_NAMES
            .iter()
            .map(|name| (*name).into())
            .collect();
        self.themes.names.extend(self.selected_theme_names());
        self.themes.names.sort();
        self.themes.names.dedup();
        self.themes.filter(Some(&Choice {
            scope: Scope::App,
            name: self.edited_theme().to_owned(),
        }));
        self.themes.search.update(cx, |search, cx| {
            search.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
            window.focus(&search.focus, cx);
        });
        self.discover_settings_themes(cx);
        self.request_theme_preview(cx);
    }

    pub(super) fn sync_theme_browser(&mut self, cx: &mut Context<Self>) {
        self.themes.contrast = self.config.contrast;
        let missing: Vec<_> = self
            .selected_theme_names()
            .into_iter()
            .filter(|name| !self.themes.names.contains(name))
            .collect();
        if !missing.is_empty() {
            self.themes.names.extend(missing);
            self.themes
                .names
                .sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
        }
        let selected = self.themes.choice();
        self.themes.filter(selected.as_ref());
        self.themes.search.update(cx, |search, cx| {
            search.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
        });
        self.request_theme_preview(cx);
    }

    fn discover_settings_themes(&mut self, cx: &mut Context<Self>) {
        if self.themes.discovering {
            return;
        }
        self.themes.discovering = true;
        self.themes.catalog_error = None;
        let config = self.config.clone();
        let task = cx
            .background_executor()
            .spawn(async move { config.available_themes() });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.themes.discovering = false;
                match result {
                    Ok(mut names) => {
                        names.extend(this.selected_theme_names());
                        names.retain(|name| name != FOLLOW);
                        names.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
                        names.dedup();
                        let selected = this.themes.choice();
                        this.themes.names = names;
                        this.themes.filter(selected.as_ref());
                        this.request_theme_preview(cx);
                    }
                    Err(error) => this.themes.catalog_error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn request_theme_preview(&mut self, cx: &mut Context<Self>) {
        self.themes.revision += 1;
        self.themes.loaded = None;
        self.themes.preview_error = None;
        self.drive_theme_preview(cx);
        cx.notify();
    }

    fn toggle_theme_source(&mut self, scope: Scope, cx: &mut Context<Self>) {
        let selected = self.themes.choice();
        match scope {
            Scope::App => self.themes.ghostty_enabled = !self.themes.ghostty_enabled,
            Scope::Herdr => self.themes.herdr_enabled = !self.themes.herdr_enabled,
        }
        self.themes.filter(selected.as_ref());
        self.request_theme_preview(cx);
    }

    fn drive_theme_preview(&mut self, cx: &mut Context<Self>) {
        let browser = &mut self.themes;
        if browser.running.is_some() || browser.attempted == Some(browser.revision) {
            return;
        }
        let Some(choice) = browser.choice() else {
            return;
        };
        let revision = browser.revision;
        browser.attempted = Some(revision);
        let contrast = browser.contrast;
        let light = crate::app::light_appearance(cx);
        if choice.scope == Scope::Herdr && self.shared.is_none() {
            browser.preview_error = Some(
                "Herdr settings are unavailable. Reload settings to preview shared themes.".into(),
            );
            return;
        }
        browser.running = Some(revision);
        let mut config = self.config.clone();
        config.theme = choice.name.clone();
        config.contrast = contrast;
        let shared = self.shared.clone();
        let task = cx.background_executor().spawn(async move {
            // Config::theme already applies contrast; do not apply it twice.
            match (choice.scope, shared) {
                (Scope::Herdr, Some(shared)) => shared
                    .preview_theme(&config.theme, light)
                    .map(|theme| theme.with_contrast(contrast)),
                _ => config.theme(light),
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.themes.finish_preview(revision, choice.name, result);
                this.drive_theme_preview(cx);
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn select_settings_theme(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.quitting || self.closing.is_some() || index >= self.themes.filtered.len() {
            return;
        }
        self.themes.selected = Some(index);
        self.themes
            .scroll
            .scroll_to_item(index / self.themes.grid.columns, ScrollStrategy::Center);
        self.request_theme_preview(cx);
        if let Some(mut choice) = self.themes.choice() {
            if choice.scope == Scope::App {
                choice.name = ThemeName::with_side(
                    self.drafted_theme(),
                    self.themes.editing_light,
                    &choice.name,
                );
            }
            self.accept_theme_choice(choice, cx);
        }
    }

    fn theme_browser_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.themes.search.read(cx).is_composing() {
            // Do not let the window's Escape action close during IME composition.
            if event.keystroke.key == "escape" {
                cx.stop_propagation();
            }
            return;
        }
        match event.keystroke.key.as_str() {
            "escape" => {
                cx.stop_propagation();
                window.prevent_default();
                self.themes.search.update(cx, |search, cx| search.clear(cx));
            }
            "up" | "down" => {
                cx.stop_propagation();
                window.prevent_default();
                let count = self.themes.filtered.len();
                if count > 0 {
                    let index = self.themes.selected.unwrap_or(0);
                    let next = grid::navigate(
                        index,
                        count,
                        self.themes.grid.columns,
                        event.keystroke.key == "up",
                    );
                    self.select_settings_theme(next, cx);
                }
            }
            "enter" => {
                cx.stop_propagation();
                window.prevent_default();
                if let Some(index) = self.themes.selected {
                    self.select_settings_theme(index, cx);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests;
