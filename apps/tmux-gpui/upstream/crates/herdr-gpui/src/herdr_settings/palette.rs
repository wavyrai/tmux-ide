//! Herdr UI palettes, adapted from src/app/state.rs at the revision credited in
//! the parent module. These are UI tokens, not upstream terminal ANSI palettes.
use super::THEME_NAMES;
use herdr_client::protocol::AgentStatus;
use serde::Deserialize;

pub(super) fn canonical(name: &str) -> Option<&'static str> {
    let name = name.to_lowercase().replace([' ', '_'], "-");
    Some(match name.as_str() {
        "catppuccin-mocha" => "catppuccin",
        "latte" | "light" => "catppuccin-latte",
        "tokyonight" => "tokyo-night",
        "tokyo-day" | "tokyonight-day" => "tokyo-night-day",
        "gruvbox-dark" => "gruvbox",
        "onedark" => "one-dark",
        "onelight" => "one-light",
        "solarized-dark" => "solarized",
        "lotus" => "kanagawa-lotus",
        "rosepine" => "rose-pine",
        "rosepine-dawn" | "dawn" => "rose-pine-dawn",
        _ => {
            return THEME_NAMES
                .iter()
                .copied()
                .find(|candidate| *candidate == name);
        }
    })
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct ThemeConfig {
    #[serde(deserialize_with = "crate::lenient::or_default")]
    pub name: Option<String>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    auto_switch: bool,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    dark_name: Option<String>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    light_name: Option<String>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    custom: Custom,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct Custom {
    #[serde(flatten)]
    common: Overrides,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    light: Overrides,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    dark: Overrides,
}

// The order also defines the compact palette rows below. Keep the token mapping
// explicit so colors unused by today's GPUI Theme are still parsed and retained.
macro_rules! overrides {
    ($($name:ident = $index:literal),+ $(,)?) => {
        #[derive(Clone, Debug, Default, Deserialize)]
        #[serde(default)]
        struct Overrides {
            $(
                #[serde(deserialize_with = "crate::lenient::or_default")]
                $name: Option<String>,
            )+
        }
        impl Overrides {
            fn apply(&self, colors: &mut Palette) {
                $(if let Some(value) = &self.$name { colors.0[$index] = parse_color(value); })+
            }
        }
    };
}
overrides! {
    accent = 0, panel_bg = 1, active_row_bg = 2, selection_bg = 3,
    surface0 = 4, surface1 = 5, surface_dim = 6, overlay0 = 7,
    overlay1 = 8, text = 9, subtext0 = 10, mauve = 11, green = 12,
    yellow = 13, red = 14, blue = 15, teal = 16, peach = 17, sidebar_bg = 18,
}

const RESET: u32 = u32::MAX;
// accent, panel, active, selection, surface0, surface1, dim, overlay0,
// overlay1, text, subtext, mauve, green, yellow, red, blue, teal, peach.
const PALETTES: [[u32; 18]; 18] = [
    [
        0x89b4fa, 0x181825, 0x1e1e2e, 0x313244, 0x313244, 0x45475a, 0x1e1e2e, 0x6c7086, 0x7f849c,
        0xcdd6f4, 0xa6adc8, 0xcba6f7, 0xa6e3a1, 0xf9e2af, 0xf38ba8, 0x89b4fa, 0x94e2d5, 0xfab387,
    ],
    [
        0x1e66f5, 0xeff1f5, 0xe6e9ef, 0xbdd0f5, 0xccd0da, 0xbcc0cc, 0xe6e9ef, 0x9ca0b0, 0x8c8fa1,
        0x4c4f69, 0x6c6f85, 0x8839ef, 0x40a02b, 0xdf8e1d, 0xd20f39, 0x1e66f5, 0x179299, 0xfe640b,
    ],
    [
        0x000080, RESET, 0x808080, RESET, RESET, 0x808080, 0x808080, 0xc0c0c0, 0xffffff, RESET,
        0xc0c0c0, 0xc0c0c0, 0x008000, 0x808000, 0xff0000, 0x000080, 0x008080, 0x808000,
    ],
    [
        0x7aa2f7, 0x1a1b26, 0x232636, 0x2d3650, 0x24283b, 0x414868, 0x1a1b26, 0x565f89, 0x697196,
        0xc0caf5, 0xa9b1d6, 0xbb9af7, 0x9ece6a, 0xe0af68, 0xf7768e, 0x7aa2f7, 0x7dcfff, 0xff9e64,
    ],
    [
        0x2e7de9, 0xe1e2e7, 0xd2d3da, 0xb6cae7, 0xc4c8da, 0xa8aecb, 0xd2d3da, 0x8990b3, 0x68709a,
        0x3760bf, 0x6172b0, 0x7847bd, 0x587539, 0x8c6c3e, 0xf52a65, 0x2e7de9, 0x118c74, 0xb15c00,
    ],
    [
        0xbd93f9, 0x282a36, 0x373c52, 0x463f5d, 0x44475a, 0x6272a4, 0x282a36, 0x6272a4, 0x828cb4,
        0xf8f8f2, 0xd2d2dc, 0xff79c6, 0x50fa7b, 0xf1fa8c, 0xff5555, 0x8be9fd, 0x8be9fd, 0xffb86c,
    ],
    [
        0x88c0d0, 0x2e3440, 0x434c5e, 0x40505d, 0x3b4252, 0x434c5e, 0x2e3440, 0x4c566a, 0x646e82,
        0xeceff4, 0xd8dee9, 0xb48ead, 0xa3be8c, 0xebcb8b, 0xbf616a, 0x81a1c1, 0x8fbcbb, 0xd08770,
    ],
    [
        0xd79921, 0x282828, 0x323130, 0x4b3f27, 0x3c3836, 0x504945, 0x282828, 0x928374, 0xa89984,
        0xebdbb2, 0xd5c4a1, 0xd3869b, 0xb8bb26, 0xfabd2f, 0xfb4934, 0x83a598, 0x8ec07c, 0xfe8019,
    ],
    [
        0x076678, 0xfbf1c7, 0xf2e5bc, 0xebdbb2, 0xebdbb2, 0xd5c4a1, 0xf2e5bc, 0x928374, 0x7c6f64,
        0x3c3836, 0x504945, 0x8f3f71, 0x79740e, 0xb57614, 0x9d0006, 0x076678, 0x427b58, 0xaf3a03,
    ],
    [
        0x61afef, 0x282c34, 0x313640, 0x334659, 0x2c313a, 0x3e4451, 0x282c34, 0x5c6370, 0x737a87,
        0xabb2bf, 0x969ca8, 0xc678dd, 0x98c379, 0xe5c07b, 0xe06c75, 0x61afef, 0x56b6c2, 0xd19a66,
    ],
    [
        0x4078f2, 0xfafafa, 0xd8dbe2, 0xcddbf8, 0xf0f0f1, 0xe5e5e6, 0xf5f5f6, 0xa0a1a7, 0x686b77,
        0x383a42, 0x686b77, 0xa626a4, 0x50a14f, 0xc18401, 0xe45649, 0x4078f2, 0x0184bc, 0x986801,
    ],
    [
        0x268bd2, 0x002b36, 0x164b57, 0x083e55, 0x073642, 0x586e75, 0x002b36, 0x586e75, 0x657b83,
        0x93a1a1, 0x839496, 0xd33682, 0x859900, 0xb58900, 0xdc322f, 0x268bd2, 0x2aa198, 0xcb4b16,
    ],
    [
        0x268bd2, 0xfdf6e3, 0xeee8d5, 0xc9dcdf, 0xeee8d5, 0x93a1a1, 0xeee8d5, 0x93a1a1, 0x586e75,
        0x657b83, 0x839496, 0xd33682, 0x859900, 0xb58900, 0xdc322f, 0x268bd2, 0x2aa198, 0xcb4b16,
    ],
    [
        0x7e9cd8, 0x1f1f28, 0x363646, 0x32384b, 0x2a2a37, 0x363646, 0x1f1f28, 0x727169, 0x87867d,
        0xdcd7ba, 0xc8c3aa, 0x957fb8, 0x76946a, 0xc0a36e, 0xc34043, 0x7e9cd8, 0x7fb4ca, 0xffa066,
    ],
    [
        0x4d699b, 0xf2ecbc, 0xd5cea3, 0xdcd5ac, 0xdcd5ac, 0xc9cbd1, 0xd5cea3, 0xa09cac, 0x8a8980,
        0x545464, 0x43436c, 0x624c83, 0x6f894e, 0x77713f, 0xc84053, 0x4d699b, 0x4e8ca2, 0xcc6d00,
    ],
    [
        0xc4a7e7, 0x191724, 0x26233a, 0x3b344b, 0x1f1d2e, 0x26233a, 0x26233a, 0x6e6a86, 0x908caa,
        0xe0def4, 0xc8c5dc, 0xc4a7e7, 0x31748f, 0xf6c177, 0xeb6f92, 0x31748f, 0x9ccfd8, 0xea9a97,
    ],
    [
        0x907aa9, 0xfaf4ed, 0xe3d9cf, 0xf2e9e1, 0xf2e9e1, 0xfffaf3, 0xf2e9e1, 0x9893a5, 0x797593,
        0x464261, 0x797593, 0x907aa9, 0x286983, 0xea9d34, 0xb4637a, 0x286983, 0x56949f, 0xd7827e,
    ],
    [
        0xffc799, 0x1a1a1a, 0x101010, 0x232323, 0x232323, 0x282828, 0x101010, 0x5c5c5c, 0x7e7e7e,
        0xffffff, 0xa0a0a0, 0xffd1a8, 0x99ffe4, 0xffc799, 0xff8080, 0xb0b0b0, 0x66ddcc, 0xffc799,
    ],
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Palette([u32; 19]);

impl ThemeConfig {
    pub(super) fn resolve(&self, manual: &str, legacy: Option<&str>, light: bool) -> Palette {
        let canonical_manual = canonical(manual);
        let sibling = match canonical_manual {
            Some("catppuccin" | "catppuccin-latte") => Some(("catppuccin", "catppuccin-latte")),
            Some("tokyo-night" | "tokyo-night-day") => Some(("tokyo-night", "tokyo-night-day")),
            Some("gruvbox" | "gruvbox-light") => Some(("gruvbox", "gruvbox-light")),
            Some("one-dark" | "one-light") => Some(("one-dark", "one-light")),
            Some("solarized" | "solarized-light") => Some(("solarized", "solarized-light")),
            Some("kanagawa" | "kanagawa-lotus") => Some(("kanagawa", "kanagawa-lotus")),
            Some("rose-pine" | "rose-pine-dawn") => Some(("rose-pine", "rose-pine-dawn")),
            _ => None,
        };
        let name = if self.auto_switch {
            if light {
                self.light_name
                    .as_deref()
                    .unwrap_or(sibling.map_or(manual, |pair| pair.1))
            } else {
                self.dark_name
                    .as_deref()
                    .unwrap_or(sibling.map_or(manual, |pair| pair.0))
            }
        } else {
            manual
        };
        let fallback = usize::from(self.auto_switch && light);
        let index = canonical(name)
            .and_then(|name| THEME_NAMES.iter().position(|candidate| *candidate == name))
            .unwrap_or(fallback);
        let mut colors = Palette([RESET; 19]);
        colors.0[..18].copy_from_slice(&PALETTES[index]);
        self.custom.common.apply(&mut colors);
        if self.custom.common.accent.is_none()
            && let Some(legacy) = legacy
        {
            colors.0[0] = parse_color(legacy);
        }
        if self.auto_switch {
            if light {
                &self.custom.light
            } else {
                &self.custom.dark
            }
            .apply(&mut colors);
        }
        colors
    }
}

impl Palette {
    fn rgb(&self, index: usize, fallback: u32) -> u32 {
        if self.0[index] == RESET {
            fallback
        } else {
            self.0[index]
        }
    }

    pub(super) fn status(&self, status: AgentStatus) -> u32 {
        self.rgb(
            match status {
                AgentStatus::Working => 13,
                AgentStatus::Blocked => 14,
                AgentStatus::Done => 16,
                AgentStatus::Idle => 12,
                AgentStatus::Unknown => 7,
            },
            0xd8dee9,
        )
    }

    pub(super) fn theme(&self) -> crate::config::Theme {
        let mut theme = crate::config::Theme::default();
        // GPUI has no host-terminal "Reset" color. Resolve reset backgrounds to
        // its opaque default. Herdr paints `sidebar_bg` on the sidebar alone.
        theme.background = self.rgb(6, theme.background);
        theme.sidebar = (self.0[18] != RESET).then_some(self.0[18]);
        theme.surface = self.rgb(1, theme.background);
        theme.active = self.rgb(2, theme.background);
        theme.muted = self.rgb(7, theme.muted);
        theme.foreground = self.rgb(9, theme.foreground);
        theme.cursor = theme.foreground;
        // Theme::primary uses slot 5. Keep xterm's 16..255 cube/gray ramp intact.
        for (slot, token) in [6, 14, 12, 13, 15, 0, 16, 9, 7, 14, 12, 13, 15, 11, 16, 9]
            .into_iter()
            .enumerate()
        {
            theme.palette[slot] = self.rgb(token, theme.palette[slot]);
        }
        theme
    }
}

fn parse_color(input: &str) -> u32 {
    let value = input.trim().to_lowercase();
    if let Some(hex) = value.strip_prefix('#')
        && hex.is_ascii()
    {
        if hex.len() == 6
            && let Ok(rgb) = u32::from_str_radix(hex, 16)
        {
            return rgb;
        }
        if hex.len() == 3
            && let Ok(rgb) = u32::from_str_radix(hex, 16)
        {
            return ((rgb & 0xf00) << 8 | (rgb & 0xf0) << 4 | rgb & 0xf) * 17;
        }
    }
    if let Some(inner) = value.strip_prefix("rgb(").and_then(|s| s.strip_suffix(')')) {
        let mut parts = inner.split(',');
        let mut next = || parts.next().and_then(|part| part.trim().parse::<u8>().ok());
        if let (Some(r), Some(g), Some(b)) = (next(), next(), next())
            && parts.next().is_none()
        {
            return u32::from(r) << 16 | u32::from(g) << 8 | u32::from(b);
        }
    }
    match value.as_str() {
        "reset" | "default" | "none" | "transparent" => RESET,
        "black" => 0x000000,
        "red" => 0x800000,
        "green" => 0x008000,
        "yellow" => 0x808000,
        "blue" => 0x000080,
        "magenta" | "purple" => 0x800080,
        "cyan" => 0x008080,
        "white" => 0xffffff,
        "gray" | "grey" => 0xc0c0c0,
        "darkgray" | "darkgrey" => 0x808080,
        "lightred" => 0xff0000,
        "lightgreen" => 0x00ff00,
        "lightyellow" => 0xffff00,
        "lightblue" => 0x0000ff,
        "lightmagenta" => 0xff00ff,
        "lightcyan" => 0x00ffff,
        _ => 0x008080, // Upstream's unknown-color fallback is Cyan.
    }
}
