//! Native GUI settings: fonts and theme colours. The
//! tmux-ide app reads no settings file of its own, so every value here is the
//! built-in default.
mod bitmap_fonts;
mod fonts;
mod theme;

#[cfg(test)]
use fonts::symbol_fallbacks;
pub use fonts::{FONT_SIZE_RANGE, FONT_SIZE_STEP, FontConfig};
pub use theme::Theme;

/// Shared logical-pixel radii for native-style chrome, independent of the
/// terminal grid. Small badges/keycaps retain a tighter curve than controls.
pub(crate) mod corners {
    pub(crate) const CONTROL: f32 = 8.;
}

#[derive(Clone, Debug)]
pub struct Config {
    pub sidebar: FontConfig,
    pub tabs: FontConfig,
    pub terminal: FontConfig,
    pub ui: FontConfig,
}

impl Default for Config {
    fn default() -> Self {
        let fonts::DefaultFonts {
            monospace,
            sans: ui,
            ..
        } = fonts::PLATFORM_FONTS;
        let font = |family: &str, size| FontConfig {
            family: family.into(),
            size,
            fallbacks: None,
            line_height_multiple: None,
        };
        Self {
            sidebar: font(monospace, 12.0),
            // Tabs are terminal chrome, so they read in the monospace face the
            // sidebar and terminal use, as they do in the reference UI.
            tabs: font(monospace, 12.0),
            terminal: font(monospace, 14.0),
            ui: font(ui, 12.0),
        }
    }
}

#[cfg(test)]
mod tests;
