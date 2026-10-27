//! Searchable installed-family picker; enumeration and config writes stay off the UI thread.
use crate::{
    HerdrWindow,
    config::{Config, FontFace},
    menu::Page,
    search_input::SearchInput,
};
use gpui::{prelude::*, *};

const DEFAULT_LABEL: &str = "Platform default";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FontTarget {
    All,
    Face(FontFace),
}

impl FontTarget {
    fn label(self) -> &'static str {
        match self {
            Self::All => "All fonts",
            Self::Face(face) => face.name(),
        }
    }
}

pub(crate) fn shared_family(config: &Config) -> Option<&str> {
    let family = config.sidebar.family.as_str();
    (config.tabs.family == family && config.terminal.family == family && config.ui.family == family)
        .then_some(family)
}

fn font_names(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut names: Vec<_> = names
        .into_iter()
        .filter(|name| !name.trim().is_empty())
        .collect();
    names.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
    names.dedup();
    names
}

pub(crate) struct FontPicker {
    target: FontTarget,
    search: Entity<SearchInput>,
    names: Vec<String>,
    filtered: Vec<Option<String>>,
    selected: usize,
    scroll: UniformListScrollHandle,
    loading: bool,
    _subscription: Subscription,
}

fn matching_names(names: &[String], query: &str) -> Vec<Option<String>> {
    let query = query.trim().to_lowercase();
    std::iter::once(None)
        .chain(names.iter().cloned().map(Some))
        .filter(|name| {
            name.as_deref()
                .unwrap_or(DEFAULT_LABEL)
                .to_lowercase()
                .contains(&query)
        })
        .collect()
}

impl FontPicker {
    fn filter(&mut self, query: &str) {
        self.filtered = matching_names(&self.names, query);
        self.selected = 0;
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
    }
}

impl HerdrWindow {
    pub(super) fn open_font_picker(
        &mut self,
        target: FontTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.config_load.is_some()
            || self.native_settings_save_in_flight()
            || self.font_size_saves.is_busy()
            || !self.open_menu(window, cx)
        {
            return;
        }
        self.select_settings_tab(crate::settings_panel::Tab::Font, window, cx);
        self.menu.page = Some(Page::Fonts);
        let search = cx.new(SearchInput::new);
        search.update(cx, |input, cx| {
            input.set_placeholder("Search installed fonts...", cx);
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
            window.focus(&input.focus, cx);
        });
        let subscription = cx.subscribe(
            &search,
            |this, search, _: &crate::search_input::Changed, cx| {
                if let Some(picker) = &mut this.menu.fonts {
                    picker.filter(search.read(cx).text());
                    cx.notify();
                }
            },
        );
        let mut picker = FontPicker {
            target,
            search,
            names: Vec::new(),
            filtered: Vec::new(),
            selected: 0,
            scroll: UniformListScrollHandle::new(),
            loading: true,
            _subscription: subscription,
        };
        picker.filter("");
        self.menu.fonts = Some(picker);
        let text_system = cx.text_system().clone();
        let names = cx
            .background_executor()
            .spawn(async move { font_names(text_system.all_font_names()) });
        cx.spawn(async move |this, cx| {
            let names = names.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(picker) = &mut this.menu.fonts
                    && picker.target == target
                    && this.menu.page == Some(Page::Fonts)
                {
                    picker.names = names;
                    picker.loading = false;
                    picker.filter(picker.search.read(cx).text());
                    let current = match target {
                        FontTarget::All => shared_family(&this.config),
                        FontTarget::Face(FontFace::Sidebar) => {
                            Some(this.config.sidebar.family.as_str())
                        }
                        FontTarget::Face(FontFace::Tabs) => Some(this.config.tabs.family.as_str()),
                        FontTarget::Face(FontFace::Terminal) => {
                            Some(this.config.terminal.family.as_str())
                        }
                        FontTarget::Face(FontFace::Ui) => Some(this.config.ui.family.as_str()),
                    };
                    if picker.search.read(cx).text().is_empty() {
                        picker.selected = picker
                            .filtered
                            .iter()
                            .position(|name| name.as_deref() == current)
                            .unwrap_or(0);
                        picker
                            .scroll
                            .scroll_to_item(picker.selected, ScrollStrategy::Center);
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn choose_font_family(
        &mut self,
        family: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = &self.menu.fonts else {
            return;
        };
        if picker.loading
            || self.config_load.is_some()
            || self.font_size_saves.is_busy()
            || (family
                .as_ref()
                .is_some_and(|name| !picker.names.contains(name)))
        {
            return;
        }
        let target = picker.target;
        let light = crate::app::light_appearance(cx);
        let text_system = cx.text_system().clone();
        self.load_gui_config_with(
            move || {
                match target {
                    FontTarget::All => Config::save_all_font_families(family.as_deref())?,
                    FontTarget::Face(face) => Config::save_font_family(face, family.as_deref())?,
                }
                let mut config = Config::load()?;
                config.resolve_fonts(|| text_system.all_font_names());
                let theme = if config.theme == "Follow Herdr" {
                    Default::default()
                } else {
                    config.theme(light)?
                };
                Ok((config, theme))
            },
            cx,
        );
        self.menu.page = Some(Page::Preferences);
        self.menu.fonts = None;
        window.focus(&self.menu.focus, cx);
        cx.notify();
    }

    pub(super) fn font_picker_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = &mut self.menu.fonts else {
            return;
        };
        if picker.search.read(cx).is_composing() {
            return;
        }
        match event.keystroke.key.as_str() {
            "escape" => {
                cx.stop_propagation();
                window.prevent_default();
                self.menu.page = Some(Page::Preferences);
                self.menu.fonts = None;
                window.focus(&self.menu.focus, cx);
                cx.notify();
            }
            "up" | "down" if !picker.filtered.is_empty() => {
                cx.stop_propagation();
                window.prevent_default();
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
                cx.notify();
            }
            "enter" => {
                cx.stop_propagation();
                window.prevent_default();
                if let Some(family) = picker.filtered.get(picker.selected).cloned() {
                    self.choose_font_family(family, window, cx);
                }
            }
            _ => {}
        }
    }

    pub(super) fn render_font_picker(&self, cx: &mut Context<Self>) -> Div {
        let Some(picker) = &self.menu.fonts else {
            return div();
        };
        let theme = &self.theme;
        let font = &self.config.ui;
        div().flex().flex_col().size_full().min_h_0()
            .child(div().flex_none().p(px(16.)).border_b_1().border_color(rgb(theme.active))
                .child(div().flex().items_center()
                    .child(div().flex_1().text_size(px(font.size * 1.35)).font_weight(FontWeight::SEMIBOLD).child(format!("{} Font", picker.target.label())))
                    .child(div().id("font-picker-back").debug_selector(|| "font-picker-back".into()).cursor_pointer().child("Back").on_click(cx.listener(|this, _, window, cx| {
                        this.menu.page = Some(Page::Preferences); this.menu.fonts = None; window.focus(&this.menu.focus, cx); cx.notify();
                    }))))
                .child(div().pt(px(12.)).child(picker.search.clone()))
                .child(div().pt(px(8.)).text_color(rgb(theme.muted)).child(format!("{} of {} installed fonts", picker.filtered.iter().filter(|name| name.is_some()).count(), picker.names.len()))))
            .when(picker.filtered.is_empty() || picker.loading, |panel| panel.child(div().flex_1().p(px(16.)).child(if picker.loading { "Loading installed fonts..." } else { "No matching fonts." })))
            .when(!picker.filtered.is_empty() && !picker.loading, |panel| panel.child(
                uniform_list("font-results", picker.filtered.len(), cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                    let Some(picker) = &this.menu.fonts else { return Vec::new(); };
                    range.map(|index| {
                        let family = picker.filtered[index].clone();
                        let label = family.clone().unwrap_or_else(|| DEFAULT_LABEL.into());
                        div().id(index).debug_selector(move || format!("font-row-{index}"))
                            .w_full().h(px(this.config.ui.line_height() + 20.)).px(px(16.))
                            .flex().items_center().cursor_pointer()
                            .when(index == picker.selected, |row| row.bg(rgb(this.theme.active)))
                            .hover(|s| s.bg(rgb(this.theme.active)))
                            .child(div().flex_1().min_w_0().truncate().child(label))
                            .on_click(cx.listener(move |this, _, window, cx| this.choose_font_family(family.clone(), window, cx)))
                    }).collect()
                })).track_scroll(&picker.scroll).flex_1().min_h_0()))
            .child(div().flex_none().p(px(12.)).border_t_1().border_color(rgb(theme.active)).text_color(rgb(theme.muted))
                .child("Type to filter; Enter or click to save. Platform default clears the override."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    #[gpui::test]
    #[allow(clippy::unwrap_used)]
    fn picker_returns_to_font_tab_by_keyboard_and_mouse(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        cx.simulate_resize(size(px(800.), px(600.)));
        for keyboard in [true, false] {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    view.settings.tab = crate::settings_panel::Tab::Theme;
                    view.open_font_picker(FontTarget::All, window, cx);
                });
                window.draw(cx).clear(cx);
            });
            if keyboard {
                cx.simulate_keystrokes("escape");
            } else {
                let back = cx.debug_bounds("font-picker-back").unwrap();
                cx.simulate_click(back.center(), Modifiers::default());
            }
            cx.update(|window, cx| window.draw(cx).clear(cx));
            view.read_with(cx, |view, _| {
                assert_eq!(view.menu.page, Some(Page::Preferences));
                assert_eq!(view.settings.tab, crate::settings_panel::Tab::Font);
                assert!(view.menu.fonts.is_none());
            });
            assert!(cx.debug_bounds("preferences-font-all-choose").is_some());
            assert!(cx.debug_bounds("preferences-theme").is_none());
        }
    }

    #[test]
    fn installed_fonts_are_sorted_deduplicated_and_not_filtered_by_face() {
        assert_eq!(
            font_names(["Zed", "Alpha", "Zed", "Mono", " "].map(str::to_owned)),
            vec!["Alpha", "Mono", "Zed"]
        );
    }

    #[test]
    fn all_fonts_shows_mixed_until_all_four_match() {
        let mut config = Config::default();
        assert_eq!(shared_family(&config), None);
        config.ui.family = config.sidebar.family.clone();
        assert_eq!(shared_family(&config), Some(config.sidebar.family.as_str()));
        config.tabs.family = "Different".into();
        assert_eq!(shared_family(&config), None);
        for font in [
            &mut config.sidebar,
            &mut config.tabs,
            &mut config.terminal,
            &mut config.ui,
        ] {
            font.family = "Shared".into();
        }
        assert_eq!(shared_family(&config), Some("Shared"));
    }

    #[test]
    fn filtering_keeps_selection_and_reset_distinct() {
        let names = font_names(["Mono", "Sans"].map(str::to_owned));
        assert_eq!(matching_names(&names, "mon"), vec![Some("Mono".into())]);
        assert_eq!(matching_names(&names, "platform"), vec![None]);
        assert_eq!(
            matching_names(&names, ""),
            vec![None, Some("Mono".into()), Some("Sans".into())]
        );
    }
}
