//! Explicit export allowlist: never serialize the browser state or machine rows.
use super::browser::{self, fleet::Phase};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

mod versions;
/// This app's version, from its bundle (None outside one).
pub(super) fn app_version() -> Option<String> {
    versions::native_bundle().0
}
pub(super) use versions::Versions;

const MAX_BYTES: usize = 4096;

/// The running app's version, build and release channel, for About.
pub(super) struct NativeIdentity {
    pub version: Option<String>,
    pub build: Option<String>,
    pub channel: Option<&'static str>,
}

pub(super) fn native_identity() -> NativeIdentity {
    let (id, version, build) = versions::native_bundle_info();
    NativeIdentity {
        version,
        build,
        channel: super::about::channel(id.as_deref()),
    }
}

#[derive(Debug)]
pub(super) enum Error {
    Encoding,
    TooLarge,
    InvalidVersion,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    schema_version: u8,
    product: &'static str,
    native_version: Option<String>,
    native_build: Option<String>,
    daemon_version: Option<String>,
    tmux_version: Option<String>,
    platform: &'static str,
    architecture: &'static str,
    developer_mode: bool,
    input_ready: bool,
    local_setup: Option<&'static str>,
    fleet: FleetSummary,
}

#[derive(Serialize)]
struct FleetSummary {
    states: BTreeSet<&'static str>,
    diagnostics: Vec<serde_json::Value>,
}

pub(super) fn build(state: &browser::State, developer_mode: bool) -> Result<String, Error> {
    if state
        .diagnostics
        .as_ref()
        .and_then(|value| value.daemon_version.as_deref())
        .is_some_and(|value| !versions::safe_version(value))
    {
        return Err(Error::InvalidVersion);
    }
    if state
        .diagnostics
        .as_ref()
        .and_then(|value| value.tmux_version.as_deref())
        .is_some_and(|value| !versions::safe_tmux_version(value))
    {
        return Err(Error::InvalidVersion);
    }
    let mut states = BTreeSet::new();
    let mut diagnostics = BTreeMap::new();
    if let Some(fleet) = &state.fleet {
        for group in &fleet.groups {
            states.insert(match group.state {
                Phase::Ready => "ready",
                Phase::Connecting => "connecting",
                Phase::Disconnected => "disconnected",
            });
            if let Some(diagnostic) = &group.diagnostic {
                // Diagnostic contains only typed phase/failure enums. The map
                // deduplicates and orders pairs, revealing no machine association.
                let value = serde_json::to_value(diagnostic).map_err(|_| Error::Encoding)?;
                let key = serde_json::to_string(&value).map_err(|_| Error::Encoding)?;
                diagnostics.insert(key, value);
            }
        }
    }
    let (native_version, native_build) = versions::native_bundle();
    let summary = Summary {
        schema_version: 1,
        product: "tmux-ide-gpui",
        // Upstream crate metadata is not the installed tmux-ide release identity.
        native_version,
        native_build,
        daemon_version: state
            .diagnostics
            .as_ref()
            .and_then(|value| value.daemon_version.clone()),
        tmux_version: state
            .diagnostics
            .as_ref()
            .and_then(|value| value.tmux_version.clone()),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        developer_mode,
        input_ready: state.input_ready,
        local_setup: state
            .local_setup
            .as_ref()
            .map(|setup| setup_name(setup.phase)),
        fleet: FleetSummary {
            states,
            diagnostics: diagnostics.into_values().collect(),
        },
    };
    let text = serde_json::to_string(&summary).map_err(|_| Error::Encoding)?;
    if text.len() > MAX_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(text)
}

fn setup_name(phase: browser::local_setup::Phase) -> &'static str {
    use browser::local_setup::Phase;
    match phase {
        Phase::Available => "available",
        Phase::Running => "running",
        Phase::Missing => "missing",
        Phase::Unsupported => "unsupported-version",
        Phase::Unrecognized => "unrecognized-installation",
        Phase::Failed => "failed",
        Phase::StoppedWaiting => "stopped-waiting",
    }
}

#[cfg(test)]
#[path = "diagnostics/tests.rs"]
mod tests;
