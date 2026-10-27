//! What a provider implements for its usage to be shown. A provider is one
//! module under `providers/` with a unit struct implementing [`Service`], and
//! one line in [`super::registry`]. Everything else, detection, local and
//! remote fetching, caching, the status bar, and the panel, works from the
//! trait: a provider reads through a [`Probe`] and draws through a [`Ui`].

use super::{model::Report, probe::Probe, ui::Ui};
use crate::{Error, Result};
use gpui::{AnyElement, App};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

/// A config value a provider reads, documented where users set it:
/// `[usage.providers.<id>] <name> = "…"`, or one of `env` for this app.
#[derive(Debug)]
pub(crate) struct Setting {
    pub name: &'static str,
    pub env: &'static [&'static str],
    /// What the value is and where to find it, e.g. which cookie to copy
    /// from which site's developer tools.
    pub help: &'static str,
}

impl Setting {
    pub const fn new(name: &'static str, env: &'static [&'static str], help: &'static str) -> Self {
        Self { name, env, help }
    }
}

/// What a provider is, for config, the status bar, and the panel. Built in a
/// `static` with [`Meta::new`] and the builder methods, so a provider states
/// only what differs from the defaults.
#[derive(Debug)]
pub(crate) struct Meta {
    /// Lowercase ASCII, stable: config tables and saved choices use it.
    pub id: &'static str,
    pub name: &'static str,
    /// An embedded SVG asset path; None uses `icons/providers/<id>.svg` when
    /// it exists, else a generic mark.
    pub icon: Option<&'static str>,
    /// The account's own usage page.
    pub dashboard: Option<&'static str>,
    pub status_page: Option<&'static str>,
    /// Values this provider reads from config or the environment.
    pub settings: &'static [Setting],
}

impl Meta {
    pub const fn new(id: &'static str, name: &'static str) -> Self {
        Self {
            id,
            name,
            icon: None,
            dashboard: None,
            status_page: None,
            settings: &[],
        }
    }

    pub const fn icon(mut self, path: &'static str) -> Self {
        self.icon = Some(path);
        self
    }

    pub const fn dashboard(mut self, url: &'static str) -> Self {
        self.dashboard = Some(url);
        self
    }

    pub const fn status_page(mut self, url: &'static str) -> Self {
        self.status_page = Some(url);
        self
    }

    pub const fn settings(mut self, settings: &'static [Setting]) -> Self {
        self.settings = settings;
        self
    }

    pub fn icon_path(&self) -> &'static str {
        self.icon
            .or_else(|| super::icons::for_id(self.id))
            .unwrap_or("icons/agent-generic.svg")
    }
}

pub(crate) trait Service: Sync {
    fn meta(&self) -> &'static Meta;
    /// Finds the sign-in through `probe` and asks the service. None means
    /// the probed host has no sign-in and the config names none, so the
    /// provider is left out unless the config asks for it.
    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>>;
    /// The panel body. The default draws the shared fields; a provider with
    /// its own detail draws that too, from [`Report::detail`].
    fn render(&self, report: &Report, ui: &Ui, _cx: &App) -> AnyElement {
        ui.standard(report)
    }
}

pub(super) fn json<'a, T: Deserialize<'a>>(body: &'a str) -> Result<T> {
    serde_json::from_str(body).map_err(|error| Error::UsageJson(error.classify()))
}

/// Seconds, milliseconds, or RFC 3339, as services variously send times.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum Timestamp {
    Number(f64),
    Text(String),
}

impl Timestamp {
    pub fn time(&self) -> Option<SystemTime> {
        match self {
            Self::Number(value) if value.is_finite() && *value > 0. => {
                let seconds = if *value > 1e11 { value / 1000. } else { *value };
                SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs_f64(seconds))
            }
            Self::Number(_) => None,
            Self::Text(text) => {
                if let Ok(number) = text.trim().parse::<f64>() {
                    return Self::Number(number).time();
                }
                let at = chrono::DateTime::parse_from_rfc3339(text.trim())
                    .ok()
                    .map(|at| at.to_utc())
                    .or_else(|| {
                        chrono::NaiveDateTime::parse_from_str(text.trim(), "%Y-%m-%dT%H:%M:%S%.f")
                            .or_else(|_| {
                                chrono::NaiveDateTime::parse_from_str(
                                    text.trim(),
                                    "%Y-%m-%d %H:%M:%S",
                                )
                            })
                            .ok()
                            .map(|at| at.and_utc())
                    })?;
                let seconds = u64::try_from(at.timestamp()).ok()?;
                SystemTime::UNIX_EPOCH
                    .checked_add(Duration::new(seconds, at.timestamp_subsec_nanos()))
            }
        }
    }
}

/// Deserializes a number that a service may send as a string.
pub(crate) fn number<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<f64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Loose {
        Number(f64),
        Text(String),
        Null,
    }
    Ok(match Option::<Loose>::deserialize(deserializer)? {
        Some(Loose::Number(value)) => Some(value),
        Some(Loose::Text(text)) => text.trim().parse().ok(),
        Some(Loose::Null) | None => None,
    })
}
