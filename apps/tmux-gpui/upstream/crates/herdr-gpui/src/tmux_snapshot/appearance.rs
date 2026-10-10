//! Validated renderer-neutral appearance; terminal cells retain their colour tags.
use super::{SnapshotView, browser};
use crate::config::Theme;
use gpui::*;
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum System {
    Dark,
    Light,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OptionItem {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Colors {
    pub canvas: u32,
    pub background: u32,
    pub foreground: u32,
    pub cursor: u32,
    pub surface: u32,
    pub active: u32,
    pub muted: u32,
    pub accent: u32,
    pub palette: Vec<u32>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Appearance {
    pub selected: String,
    pub system: System,
    pub theme: Colors,
    pub options: Vec<OptionItem>,
    pub error: Option<String>,
}
fn text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
impl Appearance {
    pub fn valid(&self) -> bool {
        let c = &self.theme;
        let mut ids = std::collections::HashSet::new();
        text(&self.selected, 64)
            && !self.options.is_empty()
            && self.options.len() <= 32
            && self
                .options
                .iter()
                .all(|o| text(&o.id, 64) && text(&o.name, 128) && ids.insert(&o.id))
            && self.options.iter().any(|o| o.id == self.selected)
            && self
                .error
                .as_ref()
                .is_none_or(|e| e.len() <= 256 && !e.chars().any(char::is_control))
            && c.palette.len() == 256
            && c.palette.iter().all(|v| *v <= 0xffffff)
            && [
                c.canvas,
                c.background,
                c.foreground,
                c.cursor,
                c.surface,
                c.active,
                c.muted,
                c.accent,
            ]
            .iter()
            .all(|v| *v <= 0xffffff)
    }
    pub fn native(&self) -> Theme {
        let c = &self.theme;
        let mut theme = Theme {
            background: c.background,
            foreground: c.foreground,
            cursor: c.cursor,
            surface: c.surface,
            active: c.active,
            muted: c.muted,
            ..Theme::default()
        };
        // valid() is required before publication; no theme mutates canonical cells.
        for (out, value) in theme.palette.iter_mut().zip(&c.palette) {
            *out = *value;
        }
        theme
    }
}
impl SnapshotView {
    pub(super) fn theme(&self) -> Theme {
        self.browser_state
            .appearance
            .as_ref()
            .map_or_else(Theme::default, Appearance::native)
    }
    pub(super) fn canvas(&self) -> u32 {
        self.browser_state
            .appearance
            .as_ref()
            .map_or_else(|| Theme::default().background, |a| a.theme.canvas)
    }
    pub(super) fn accent(&self) -> u32 {
        self.browser_state
            .appearance
            .as_ref()
            .map_or(0x69b7ff, |a| a.theme.accent)
    }
    pub(super) fn publish_system(&mut self, mode: System) {
        if self.last_system == Some(mode) {
            return;
        }
        if self.browser_commands.as_ref().is_some_and(|tx| {
            tx.try_send(browser::Command::Appearance { system: mode })
                .is_ok()
        }) {
            self.last_system = Some(mode);
        }
    }
    pub(super) fn follow_system(&mut self, cx: &App) {
        self.publish_system(if crate::app::light_appearance(cx) {
            System::Light
        } else {
            System::Dark
        });
    }
}
#[cfg(test)]
mod tests;
