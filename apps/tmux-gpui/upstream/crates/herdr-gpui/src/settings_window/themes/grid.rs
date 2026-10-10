//! Virtual row geometry and bounded, single-flight thumbnail preparation.
use super::*;
use std::{collections::VecDeque, ops::Range};

const CACHE_LIMIT: usize = 64;
const BATCH: usize = 12;

pub(super) struct Grid {
    pub columns: usize,
    epoch: u64,
    queued: bool,
    pub(super) running: bool,
    visible: Range<usize>,
    palettes: VecDeque<(Choice, Option<Theme>)>,
}

impl Default for Grid {
    fn default() -> Self {
        Self {
            columns: 2,
            epoch: 0,
            queued: false,
            running: false,
            visible: 0..0,
            palettes: VecDeque::new(),
        }
    }
}

impl Grid {
    pub fn invalidate(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.palettes.clear();
    }

    fn finish(&mut self, epoch: u64, palettes: Vec<(Choice, Option<Theme>)>) {
        self.running = false;
        if self.epoch != epoch {
            return;
        }
        for palette in palettes {
            if self.palettes.len() == CACHE_LIMIT {
                self.palettes.pop_front();
            }
            self.palettes.push_back(palette);
        }
    }
}

pub(super) fn columns(width: f32) -> usize {
    ((width + 6.) / 174.).floor().clamp(2., 6.) as usize
}

pub(super) fn navigate(index: usize, count: usize, columns: usize, up: bool) -> usize {
    if up {
        index.saturating_sub(columns)
    } else {
        (index + columns).min(count.saturating_sub(1))
    }
}

impl SettingsWindow {
    pub(super) fn schedule_grid_palettes(&mut self, rows: Range<usize>, cx: &mut Context<Self>) {
        let grid = &mut self.themes.grid;
        grid.visible =
            rows.start * grid.columns..(rows.end * grid.columns).min(self.themes.filtered.len());
        if self
            .themes
            .filtered
            .get(grid.visible.clone())
            .unwrap_or_default()
            .iter()
            .all(|name| grid.palettes.iter().any(|(cached, _)| cached == name))
        {
            return;
        }
        if grid.queued || grid.running {
            return;
        }
        grid.queued = true;
        // Leave render before launching work, without depending on display frames
        // that an occluded native window may never receive.
        let weak = cx.entity().downgrade();
        cx.defer(move |cx| {
            let _ = weak.update(cx, |this, cx| {
                this.themes.grid.queued = false;
                this.load_grid_palettes(cx);
            });
        });
    }

    fn load_grid_palettes(&mut self, cx: &mut Context<Self>) {
        if self.quitting || self.themes.grid.running {
            return;
        }
        let grid = &mut self.themes.grid;
        let choices: Vec<_> = self
            .themes
            .filtered
            .get(grid.visible.clone())
            .unwrap_or_default()
            .iter()
            .filter(|name| !grid.palettes.iter().any(|(cached, _)| cached == *name))
            .take(BATCH)
            .cloned()
            .collect();
        if choices.is_empty() {
            return;
        }
        grid.running = true;
        let epoch = grid.epoch;
        let mut config = self.config.clone();
        let shared = self.shared.clone();
        let light = matches!(
            cx.window_appearance(),
            WindowAppearance::Light | WindowAppearance::VibrantLight
        );
        let work = cx.background_executor().spawn(async move {
            choices
                .into_iter()
                .map(|choice| {
                    config.theme = choice.name.clone();
                    let result = match choice.scope {
                        Scope::Herdr => shared
                            .as_ref()
                            .ok_or(crate::Error::MissingHome)
                            .and_then(|shared| shared.preview_theme(&choice.name, light))
                            .map(|theme| theme.with_contrast(config.contrast)),
                        Scope::App => config.theme(light),
                    };
                    (choice, result.ok())
                })
                .collect()
        });
        cx.spawn(async move |this, cx| {
            let palettes = work.await;
            let _ = this.update(cx, |this, cx| {
                this.themes.grid.finish(epoch, palettes);
                this.load_grid_palettes(cx);
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn grid_thumbnail(&self, choice: &Choice, index: usize) -> Div {
        let palette = self
            .themes
            .grid
            .palettes
            .iter()
            .find(|(cached, _)| cached == choice);
        let thumbnail = div()
            .debug_selector(move || format!("settings-theme-thumbnail-{index}"))
            .h(px(26.))
            .flex_none()
            .w_full()
            .rounded(px(3.))
            .overflow_hidden();
        match palette {
            Some((_, Some(theme))) => thumbnail
                .bg(rgb(theme.background))
                .text_color(rgb(theme.foreground))
                .px(px(4.))
                .flex()
                .items_center()
                .gap(px(3.))
                .child(div().text_size(px(10.)).child("Aa"))
                .children(
                    theme.palette[..8]
                        .iter()
                        .map(|color| div().flex_1().min_w_0().h(px(9.)).bg(rgb(*color))),
                ),
            _ => thumbnail
                .bg(rgb(self.theme.surface))
                .text_color(rgb(self.theme.subtext()))
                .text_size(px(10.))
                .child(if palette.is_some() {
                    "Unavailable"
                } else {
                    "Loading..."
                }),
        }
    }
}

#[cfg(all(feature = "integration-test", target_os = "macos"))]
#[derive(Default)]
struct NativeBounds(std::collections::HashMap<usize, Bounds<Pixels>>);
#[cfg(all(feature = "integration-test", target_os = "macos"))]
impl Global for NativeBounds {}

#[cfg(all(feature = "integration-test", target_os = "macos"))]
pub(super) fn clear_native_bounds(cx: &mut App) {
    cx.default_global::<NativeBounds>().0.clear();
}

#[cfg(all(feature = "integration-test", target_os = "macos"))]
pub(super) fn native_probe(index: usize) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, _, cx| {
            cx.default_global::<NativeBounds>().0.insert(index, bounds);
        },
    )
    .absolute()
    .size_full()
}

#[cfg(all(feature = "integration-test", target_os = "macos"))]
impl SettingsWindow {
    /// Latest painted card bounds; settled includes an unavailable-palette result.
    pub(in crate::settings_window) fn native_theme_cards(
        &self,
        cx: &App,
    ) -> Vec<(usize, Bounds<Pixels>, bool)> {
        cx.try_global::<NativeBounds>()
            .into_iter()
            .flat_map(|bounds| bounds.0.iter())
            .map(|(index, bounds)| {
                let settled = self.themes.filtered.get(*index).is_some_and(|name| {
                    self.themes
                        .grid
                        .palettes
                        .iter()
                        .any(|(cached, _)| cached == name)
                });
                (*index, *bounds, settled)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests;
