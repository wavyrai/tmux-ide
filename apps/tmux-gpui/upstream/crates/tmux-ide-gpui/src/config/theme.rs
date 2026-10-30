//! Terminal and chrome colors.
use crate::contrast::Contrast;

/// Colors are packed 24-bit RGB, without an alpha channel.
#[derive(Clone, Debug, PartialEq)]
pub struct Theme {
    pub background: u32,
    pub foreground: u32,
    pub cursor: u32,
    pub bold: Option<u32>,
    pub surface: u32,
    pub active: u32,
    pub muted: u32,
    /// Herdr's optional `sidebar_bg`, which colors only the sidebar. Unset,
    /// the sidebar stays on [`Self::surface`].
    pub sidebar: Option<u32>,
    pub palette: [u32; 256],
    /// Applied by [`Theme::with_contrast`]; every theme loads as `Standard`.
    pub contrast: Contrast,
}

impl Default for Theme {
    fn default() -> Self {
        let mut palette = [0; 256];
        palette[..16].copy_from_slice(&[
            0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
            0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
        ]);
        for (index, color) in palette.iter_mut().enumerate().skip(16) {
            let n = index as u32;
            *color = if n < 232 {
                let n = n - 16;
                let level = |v| if v == 0 { 0 } else { 55 + v * 40 };
                (level(n / 36) << 16) | (level(n / 6 % 6) << 8) | level(n % 6)
            } else {
                (8 + (n - 232) * 10) * 0x010101
            };
        }
        Self {
            background: 0x101419,
            foreground: 0xd8dee9,
            cursor: 0xd8dee9,
            bold: None,
            surface: 0x1c1c22,
            active: 0x2b2933,
            muted: 0x827e91,
            sidebar: None,
            palette,
            contrast: Contrast::Standard,
        }
    }
}

impl Theme {
    /// The theme's primary accent, used for selection colors that must read as
    /// chosen rather than merely hovered.
    pub fn primary(&self) -> u32 {
        self.palette[5]
    }

    /// `color` as a colored mark or label drawn on this theme's chrome: moved
    /// only as far as the contrast setting needs to read on the background,
    /// the surface, and a selected row, keeping its hue. Never for terminal
    /// cells, whose colors belong to the program that wrote them.
    pub fn ink(&self, color: u32) -> u32 {
        crate::contrast::ink_on_chrome(
            color,
            [self.background, self.surface, self.active],
            self.contrast.mark_ratio(),
        )
    }
}
