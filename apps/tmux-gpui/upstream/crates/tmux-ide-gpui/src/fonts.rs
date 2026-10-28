//! Applying a configured face to elements.
//!
//! Shell prompts draw powerline separators and Nerd Font icons from the Private
//! Use Area. No text face covers those codepoints and no platform default
//! cascade reaches an installed icon font, so every such cell shapes to the
//! missing-glyph box until the cascade names one. [`crate::config::FontConfig`]
//! carries that cascade alongside the family; this trait applies both.

use crate::config::FontConfig;
use gpui::{Font, Styled};

pub(crate) trait StyledFont: Styled + Sized {
    /// Sets the family and its fallback cascade, and nothing else. `Styled::font`
    /// would also reset weight and style, which nested chrome inherits.
    fn text_font(mut self, config: &FontConfig) -> Self {
        let Font {
            family, fallbacks, ..
        } = config.font();
        let style = self.text_style();
        style.font_family = Some(family);
        style.font_fallbacks = fallbacks;
        self
    }
}

impl<E: Styled> StyledFont for E {}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    /// gpui-pre-platform enables no features by default. Without `font-kit` the
    /// macOS platform uses a no-op text system, and without a Linux backend so
    /// does Linux: windows open but draw no text at all. The platform can only be
    /// built on the main thread, so check the manifest rather than a live one.
    #[test]
    fn the_platform_crate_keeps_its_text_features() {
        let manifest: toml::Table = toml::from_str(include_str!("../Cargo.toml")).unwrap();
        let features = manifest["dependencies"]["gpui_platform"]["features"]
            .as_array()
            .unwrap();
        for feature in ["font-kit", "wayland", "x11"] {
            assert!(
                features.iter().any(|value| value.as_str() == Some(feature)),
                "gpui_platform is missing the {feature} feature"
            );
        }
    }
}
