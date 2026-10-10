//! Named sidebar layouts and the spacing around them.
use crate::{Error, Result};
use serde::Deserialize;

/// Sidebar layout and spacing the config file can adjust.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    pub mode: LayoutMode,
    /// Blank space between the sidebar and the terminal it borders. Applies
    /// only while the sidebar is on screen, and narrows the terminal, so the
    /// daemon is told about the columns it actually has.
    pub sidebar_gap: f32,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            mode: LayoutMode::default(),
            sidebar_gap: DEFAULT_SIDEBAR_GAP,
        }
    }
}

/// How much the sidebar fits: spacing, indents, and which details show.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Density {
    #[default]
    Normal,
    Compact,
    Comfortable,
}

/// How sidebar rows are drawn, independent of how dense they are.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Style {
    /// Edge-to-edge rows with square highlights and tree lines.
    #[default]
    Flat,
    /// Inset rows with rounded, bordered highlights.
    Rounded,
}

/// A named sidebar layout. Each one draws its rows differently: Herdr's own
/// rows at a density, flat or rounded, or a design of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayoutMode {
    /// Herdr's rows: `normal`, `compact`, `comfortable`, or any of them with a
    /// `-rounded` suffix.
    Classic { density: Density, style: Style },
    /// Single-line rows with an icon slot and pull request counts.
    Superset,
    /// Rounded cards with a meta line for host, branch, and pull request.
    Orca,
    /// One line per row with only the status and the name.
    Minimal,
}

impl Default for LayoutMode {
    fn default() -> Self {
        Self::new(Density::Normal, Style::Flat)
    }
}

impl LayoutMode {
    /// `ALL`'s names, for errors that list what a config may say.
    pub(super) const NAMES: &'static [&'static str] = &[
        "normal",
        "compact",
        "comfortable",
        "normal-rounded",
        "compact-rounded",
        "comfortable-rounded",
        "superset",
        "orca",
        "minimal",
    ];

    /// Every named layout, in the order menus list them.
    pub const ALL: [Self; 9] = [
        Self::new(Density::Normal, Style::Flat),
        Self::new(Density::Compact, Style::Flat),
        Self::new(Density::Comfortable, Style::Flat),
        Self::new(Density::Normal, Style::Rounded),
        Self::new(Density::Compact, Style::Rounded),
        Self::new(Density::Comfortable, Style::Rounded),
        Self::Superset,
        Self::Orca,
        Self::Minimal,
    ];

    pub const fn new(density: Density, style: Style) -> Self {
        Self::Classic { density, style }
    }

    /// The spacing the list around the rows uses. Layouts with their own
    /// design fix theirs, so no second setting half-changes them.
    pub const fn density(self) -> Density {
        match self {
            Self::Classic { density, .. } => density,
            Self::Superset | Self::Minimal => Density::Normal,
            Self::Orca => Density::Comfortable,
        }
    }

    /// The highlight shape and heading case the list uses.
    pub const fn style(self) -> Style {
        match self {
            Self::Classic { style, .. } => style,
            Self::Superset | Self::Minimal => Style::Flat,
            Self::Orca => Style::Rounded,
        }
    }

    /// The config value that selects it.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Classic { density, style } => match (density, style) {
                (Density::Normal, Style::Flat) => "normal",
                (Density::Compact, Style::Flat) => "compact",
                (Density::Comfortable, Style::Flat) => "comfortable",
                (Density::Normal, Style::Rounded) => "normal-rounded",
                (Density::Compact, Style::Rounded) => "compact-rounded",
                (Density::Comfortable, Style::Rounded) => "comfortable-rounded",
            },
            Self::Superset => "superset",
            Self::Orca => "orca",
            Self::Minimal => "minimal",
        }
    }

    /// How menus title it.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Classic { density, style } => match (density, style) {
                (Density::Normal, Style::Flat) => "Normal",
                (Density::Compact, Style::Flat) => "Compact",
                (Density::Comfortable, Style::Flat) => "Comfortable",
                (Density::Normal, Style::Rounded) => "Normal Rounded",
                (Density::Compact, Style::Rounded) => "Compact Rounded",
                (Density::Comfortable, Style::Rounded) => "Comfortable Rounded",
            },
            Self::Superset => "Superset",
            Self::Orca => "Orca",
            Self::Minimal => "Minimal",
        }
    }
}

impl From<Density> for LayoutMode {
    fn from(density: Density) -> Self {
        Self::new(density, Style::Flat)
    }
}

impl TryFrom<&str> for LayoutMode {
    type Error = Error;

    fn try_from(name: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|mode| mode.name() == name)
            .ok_or_else(|| Error::UnknownLayout(name.to_owned()))
    }
}

impl std::fmt::Display for LayoutMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

impl<'de> Deserialize<'de> for LayoutMode {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let name = String::deserialize(deserializer)?;
        Self::try_from(name.as_str())
            .map_err(|_| serde::de::Error::unknown_variant(&name, Self::NAMES))
    }
}

impl<'de> Deserialize<'de> for Layout {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        // Keep shipped [layout] spacing settings readable alongside named
        // layouts. A visitor rather than an untagged enum, so a key this build
        // does not know is reported as ignored instead of buffered away.
        #[derive(Default, Deserialize)]
        #[serde(default)]
        struct Options {
            mode: LayoutMode,
            sidebar_gap: Option<f32>,
        }

        struct Visitor;

        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Layout;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a layout name or a [layout] table")
            }

            fn visit_str<E: serde::de::Error>(self, name: &str) -> std::result::Result<Layout, E> {
                let mode = LayoutMode::try_from(name)
                    .map_err(|_| E::unknown_variant(name, LayoutMode::NAMES))?;
                Ok(Layout {
                    mode,
                    ..Layout::default()
                })
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> std::result::Result<Layout, A::Error> {
                let Options { mode, sidebar_gap } =
                    Options::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
                Ok(Layout {
                    mode,
                    sidebar_gap: sidebar_gap.unwrap_or(DEFAULT_SIDEBAR_GAP),
                })
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}

/// Keep the terminal flush with the divider unless spacing is requested.
const DEFAULT_SIDEBAR_GAP: f32 = 0.;

/// A gap wider than this stops reading as spacing and starts eating columns the
/// terminal needs, so the config file is held to a band a window can afford.
pub(super) const MAX_SIDEBAR_GAP: f32 = 64.;
