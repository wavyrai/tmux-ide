//! Themes that follow the system appearance, written as Ghostty's
//! `light:NAME,dark:NAME`: which side the grid edits, turning following on
//! and off, and showing the side the current appearance calls for.
use super::{Choice, FOLLOW, Scope, SettingsWindow};
use crate::{
    config::{Theme, ThemeName},
    contrast::{Contrast, luminance},
};
use gpui::{Context, ScrollStrategy};

/// What a theme is paired with when following starts: the current theme
/// keeps the side its background suits, and these fill the other.
const LIGHT_PAIR: &str = "Catppuccin Latte";
const DARK_PAIR: &str = "Catppuccin Mocha";

impl SettingsWindow {
    /// The theme value the next choice builds on: an unsaved draft, else the
    /// saved one, so editing both sides quickly keeps the first edit.
    pub(super) fn drafted_theme(&self) -> &str {
        self.theme_intent
            .as_ref()
            .filter(|intent| intent.choice.scope == Scope::App)
            .map_or(&self.config.theme, |intent| &intent.choice.name)
    }

    /// The app theme the grid marks as chosen: the edited side of a pair.
    pub(super) fn edited_theme(&self) -> &str {
        ThemeName::side(&self.config.theme, self.themes.editing_light)
    }

    /// Chosen names the catalog lists even when no theme directory has them.
    pub(super) fn selected_theme_names(&self) -> Vec<String> {
        let mut names = vec![
            ThemeName::side(&self.config.theme, true).to_owned(),
            ThemeName::side(&self.config.theme, false).to_owned(),
        ];
        names.dedup();
        names.retain(|name| name != FOLLOW);
        names
    }

    /// The unadjusted colors for one side of `value`, when they need no disk
    /// read: built-ins, Herdr's prepared palettes, and loaded themes.
    pub(super) fn prepared_app_theme(&self, value: &str, light: bool) -> Option<Theme> {
        let name = ThemeName::side(value, light);
        if name == FOLLOW {
            return self.shared.as_ref()?.theme(light).ok();
        }
        Theme::builtin(name).or_else(|| {
            self.theme_cache
                .iter()
                .find(|(cached, _)| cached == name)
                .map(|(_, theme)| theme.clone())
        })
    }

    pub(super) fn toggle_system_theme(&mut self, cx: &mut Context<Self>) {
        if self.busy() {
            return;
        }
        let light = crate::app::light_appearance(cx);
        let current = self.drafted_theme();
        let name = if ThemeName::follows_system(current) {
            ThemeName::side(current, light).to_owned()
        } else if luminance(self.theme.background) > 0.4 {
            ThemeName::system(current, DARK_PAIR)
        } else {
            ThemeName::system(LIGHT_PAIR, current)
        };
        self.themes.editing_light = light;
        self.accept_theme_choice(
            Choice {
                scope: Scope::App,
                name,
            },
            cx,
        );
        self.select_edited_theme(cx);
    }

    pub(super) fn edit_theme_side(&mut self, light: bool, cx: &mut Context<Self>) {
        self.themes.editing_light = light;
        self.select_edited_theme(cx);
    }

    fn select_edited_theme(&mut self, cx: &mut Context<Self>) {
        let edited = Choice {
            scope: Scope::App,
            name: ThemeName::side(self.drafted_theme(), self.themes.editing_light).to_owned(),
        };
        if !self.themes.names.contains(&edited.name) && edited.name != FOLLOW {
            self.themes.names.push(edited.name.clone());
            self.themes
                .names
                .sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
        }
        self.themes.filter(Some(&edited));
        if let Some(index) = self.themes.selected {
            self.themes
                .scroll
                .scroll_to_item(index / self.themes.grid.columns, ScrollStrategy::Center);
        }
        self.request_theme_preview(cx);
    }

    /// Re-resolves a following theme, or a draft of one, when the system
    /// changes appearance. Theme files load on the background executor.
    pub(in crate::settings_window) fn follow_system_appearance(&mut self, cx: &mut Context<Self>) {
        let light = crate::app::light_appearance(cx);
        if let Some(intent) = &self.theme_intent {
            if intent.choice.scope != Scope::App
                || !ThemeName::follows_system(&intent.choice.name)
                || self.theme_light == light
            {
                return;
            }
            let theme = self.prepared_app_theme(&intent.choice.name, light);
            // A new revision fences a load already running for the old side.
            self.theme_revision = self.theme_revision.wrapping_add(1);
            self.theme_light = light;
            if let Some(intent) = &mut self.theme_intent {
                intent.revision = self.theme_revision;
                intent.theme = theme;
            }
            return;
        }
        if !ThemeName::follows_system(&self.config.theme) {
            return;
        }
        if let Some(theme) = self.prepared_app_theme(&self.config.theme, light) {
            self.theme = theme.with_contrast(self.config.contrast);
            return;
        }
        let mut config = self.config.clone();
        config.contrast = Contrast::Standard;
        let load = cx
            .background_executor()
            .spawn(async move { config.theme(light).map(|theme| (config.theme, theme)) });
        cx.spawn(async move |this, cx| {
            let result = load.await;
            let _ = this.update(cx, |this, cx| {
                let (value, theme) = match result {
                    Ok(loaded) => loaded,
                    Err(error) => {
                        this.error = Some(format!("Apply system appearance: {error}"));
                        cx.notify();
                        return;
                    }
                };
                let name = ThemeName::side(&value, light);
                if name != FOLLOW {
                    if this.theme_cache.len() == 64 {
                        this.theme_cache.pop_front();
                    }
                    this.theme_cache.push_back((name.to_owned(), theme.clone()));
                }
                if value != this.config.theme
                    || light != crate::app::light_appearance(cx)
                    || this.theme_intent.is_some()
                {
                    return;
                }
                this.theme = theme.with_contrast(this.config.contrast);
                this.sync_appearance(cx);
                this.publish_appearance(cx);
            });
        })
        .detach();
    }
}
