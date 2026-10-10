//! What the status bar shows and how much room each item takes. Whether
//! usage and CPU/memory appear at all stays with `[usage] show` and
//! `show_system_load`, which also gate their sampling.
use serde::Deserialize;

/// How much of a reading an item spells out.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Detail {
    /// Meters and every figure.
    #[default]
    Detailed,
    /// One number per item.
    Compact,
}

/// How a status bar button appears.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    /// Icon and name.
    #[default]
    Label,
    /// Icon alone, named by its tooltip.
    Icon,
    Hidden,
}

impl Button {
    pub(crate) fn shown(self) -> bool {
        self != Self::Hidden
    }

    fn name(self) -> &'static str {
        match self {
            Self::Label => "label",
            Self::Icon => "icon",
            Self::Hidden => "hidden",
        }
    }
}

impl Detail {
    fn name(self) -> &'static str {
        match self {
            Self::Detailed => "detailed",
            Self::Compact => "compact",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct StatusBar {
    /// The bar at all; `toggle_status_bar` hides or shows it for the session.
    pub show: bool,
    pub usage: Detail,
    pub system_load: Detail,
    pub keep_awake: bool,
    pub theme: Button,
    pub shortcuts: Button,
    pub report_issue: Button,
}

impl Default for StatusBar {
    fn default() -> Self {
        Self {
            show: true,
            usage: Detail::default(),
            system_load: Detail::default(),
            keep_awake: true,
            theme: Button::default(),
            shortcuts: Button::default(),
            report_issue: Button::default(),
        }
    }
}

/// One `[status_bar]` key, as the Settings window saves it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Edit {
    Usage(Detail),
    SystemLoad(Detail),
    KeepAwake(bool),
    Theme(Button),
    Shortcuts(Button),
    ReportIssue(Button),
}

impl Edit {
    pub(super) fn entry(self) -> (&'static str, toml_edit::Value) {
        match self {
            Self::Usage(detail) => ("usage", detail.name().into()),
            Self::SystemLoad(detail) => ("system_load", detail.name().into()),
            Self::KeepAwake(shown) => ("keep_awake", shown.into()),
            Self::Theme(button) => ("theme", button.name().into()),
            Self::Shortcuts(button) => ("shortcuts", button.name().into()),
            Self::ReportIssue(button) => ("report_issue", button.name().into()),
        }
    }
}
